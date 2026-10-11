import 'cesium/Build/Cesium/Widgets/widgets.css'
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Credit,
  DistanceDisplayCondition,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  HeadingPitchRange,
  HeightReference,
  ImageryLayer,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  NeverTileDiscardPolicy,
  NearFarScalar,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SingleTileImageryProvider,
  SplitDirection,
  TextureMagnificationFilter,
  TileMapServiceImageryProvider,
  buildModuleUrl,
  VerticalOrigin,
  Viewer,
  WebMapServiceImageryProvider,
  WebMapTileServiceImageryProvider,
  WebMercatorTilingScheme,
  type Entity,
  type ImageryProvider,
} from 'cesium'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { GIBS_ACK, MAX_LEVEL, layerById, type GibsLayer } from '../layers'
import { PROFILE } from '../perf'
import { createTerrainProvider, setTerrainRedraw } from '../terrain'

export interface LayerSpec {
  layerId: string
  date?: string
  split?: 'left' | 'right'
  alpha?: number
  /** Hide the layer until the view is this detailed (avoids loading 30 m tiles for the whole globe). */
  minLevel?: number
  /** A single georeferenced image (EarthOS screening overlays) instead of a GIBS layer. */
  image?: { url: string; west: number; south: number; east: number; north: number; credit: string }
}

export interface Pin {
  lat: number
  lon: number
  /** Half-width of the averaged box in km; 0 draws the pin only. */
  km: number
}

export interface Marker {
  id: string
  lat: number
  lon: number
  color: string
  label?: string
  size?: number
}

export interface GlobeHandle {
  zoom: (direction: 1 | -1) => void
  resetNorth: () => void
  /** Google Earth-style flight that ends tilted, looking at the target. */
  flyTo: (lat: number, lon: number, range?: number, pitchDeg?: number) => void
  flyToBounds: (south: number, north: number, west: number, east: number) => void
  toggleTilt: () => boolean
  rotate: (deg: number) => void
  setOrbit: (on: boolean) => void
  /** PNG data URL of the current view, with attribution burned in. */
  snapshot: (credit: string) => string | null
}

export interface ViewState {
  heightM: number
  headingDeg: number
  pitchDeg: number
  /** Ground point at the centre of the screen, if the globe fills it. */
  centre: { lat: number; lon: number } | null
}

interface Props {
  layers: LayerSpec[]
  splitActive: boolean
  pin: Pin | null
  markers: Marker[]
  terrain: boolean
  onPick: (lat: number, lon: number) => void
  onMarker: (id: string) => void
  onCursor: (pos: { lat: number; lon: number; heightM?: number } | null) => void
  onView: (v: ViewState) => void
}

const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'

// Tiles come from the GIBS Web Mercator endpoint. Its EPSG:4326 tiles start as two 288°-wide tiles that run past the
// antimeridian, which Cesium's tiling schemes can't represent: imagery east of ~108°E was stretched into streaks or
// never drawn (most visibly as an empty right half in compare mode).
// GIBS sometimes drops or times out tile requests under load (two compare layers plus the base can be ~100 tiles at once).
// Cesium never re-requests a failed tile by default, which leaves permanent holes, so transient failures (network
// errors, 429, 5xx) are retried a few times. A 4xx means the tile doesn't exist (no data there), so it isn't retried.
const GIBS_RETRIES = 3
function withRetry<T extends ImageryProvider>(p: T): T {
  p.errorEvent.addEventListener((e) => {
    const status = (e.error as { statusCode?: number } | undefined)?.statusCode
    const transient = status === undefined || status === 429 || status >= 500
    if (transient && e.timesRetried < GIBS_RETRIES) e.retry = true
  })
  return p
}
// A tile discard policy makes Cesium fetch tiles via XHR (blob) instead of an <img>, so errors carry the HTTP status.
// (The providers accept tileDiscardPolicy at runtime; their TypeScript options type omits it, hence the spread.)
const fetchWithStatus = (): object => ({ tileDiscardPolicy: new NeverTileDiscardPolicy() })

function makeProvider(layer: GibsLayer, date?: string): ImageryProvider {
  const credit = new Credit(layer.credit ? `NASA GIBS · ${layer.credit}` : 'NASA GIBS')
  if (layer.wms) {
    return withRetry(new WebMapServiceImageryProvider({
      url: GIBS_WMS,
      layers: layer.gibsId,
      parameters: { transparent: true, format: 'image/png', TIME: date ?? 'default' },
      tilingScheme: new GeographicTilingScheme(),
      maximumLevel: 10,
      ...fetchWithStatus(),
      credit,
    }))
  }
  const time = layer.timed ? (date ?? 'default') : 'default'
  const level = MAX_LEVEL[layer.matrixSet]
  return withRetry(new WebMapTileServiceImageryProvider({
    url: `${GIBS_WMTS}/${layer.gibsId}/default/${time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.${layer.format}`,
    layer: layer.gibsId,
    style: 'default',
    format: layer.format === 'jpg' ? 'image/jpeg' : 'image/png',
    tileMatrixSetID: `GoogleMapsCompatible_Level${level}`,
    tilingScheme: new WebMercatorTilingScheme(),
    tileWidth: 256,
    tileHeight: 256,
    maximumLevel: level,
    ...fetchWithStatus(),
    credit,
  }))
}

const specKey = (s: LayerSpec) => `${s.layerId}|${s.date ?? ''}|${s.split ?? ''}|${s.image?.url ?? ''}`

function boxRectangle(p: Pin) {
  const dLat = p.km / 111.32
  const dLon = Math.min(p.km / (111.32 * Math.max(Math.cos(CesiumMath.toRadians(p.lat)), 0.02)), 179)
  const clampLat = (v: number) => Math.max(-89.99, Math.min(89.99, v))
  return Rectangle.fromDegrees(p.lon - dLon, clampLat(p.lat - dLat), p.lon + dLon, clampLat(p.lat + dLat))
}

const PIN_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44">' +
      '<path d="M16 43C16 43 30 26 30 15A14 14 0 0 0 2 15C2 26 16 43 16 43Z" fill="#ea4335" stroke="#a52714" stroke-width="1.5"/>' +
      '<circle cx="16" cy="15" r="5.5" fill="#a52714"/></svg>',
  )

const TILTED = CesiumMath.toRadians(-35)
const TOP_DOWN = -CesiumMath.PI_OVER_TWO + 0.0001

const Globe = forwardRef<GlobeHandle, Props>(function Globe(
  { layers, splitActive, pin, markers, terrain, onPick, onMarker, onCursor, onView },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const activeRef = useRef(new Map<string, ImageryLayer>())
  const pinEntities = useRef<Entity[]>([])
  const markerEntities = useRef<Entity[]>([])
  const spinning = useRef(true)
  const orbit = useRef<Cartesian3 | null>(null)
  const cb = useRef({ onPick, onMarker, onCursor, onView })
  const [split, setSplit] = useState(0.5)
  useEffect(() => {
    cb.current = { onPick, onMarker, onCursor, onView }
  }, [onPick, onMarker, onCursor, onView])

  /** Point on the ground at the centre of the screen (what Google Earth rotates and tilts around). */
  const centreTarget = (v: Viewer) => {
    const c = v.canvas
    const ray = v.camera.getPickRay(new Cartesian2(c.clientWidth / 2, c.clientHeight / 2))
    return (ray && v.scene.globe.pick(ray, v.scene)) || v.camera.pickEllipsoid(new Cartesian2(c.clientWidth / 2, c.clientHeight / 2))
  }

  /** Re-aim the camera at `target` from a new heading/pitch, keeping the distance. */
  const lookAround = (v: Viewer, target: Cartesian3, heading: number, pitch: number, range?: number, duration = 0) => {
    const r = range ?? Cartesian3.distance(v.camera.positionWC, target)
    const offset = new HeadingPitchRange(heading, Math.max(Math.min(pitch, -0.05), TOP_DOWN), r)
    if (duration > 0) {
      v.camera.flyToBoundingSphere(new BoundingSphere(target, 0), { offset, duration })
    } else {
      v.camera.lookAt(target, offset)
      v.camera.lookAtTransform(Matrix4.IDENTITY)
    }
  }

  useImperativeHandle(ref, () => ({
    zoom(direction) {
      const v = viewerRef.current
      if (!v) return
      spinning.current = false
      const target = centreTarget(v)
      if (!target) {
        const h = v.camera.positionCartographic.height
        return direction > 0 ? v.camera.zoomIn(h * 0.5) : v.camera.zoomOut(h)
      }
      const range = Cartesian3.distance(v.camera.positionWC, target)
      lookAround(v, target, v.camera.heading, v.camera.pitch, direction > 0 ? range * 0.45 : range * 2.2, 0.6)
    },
    resetNorth() {
      const v = viewerRef.current
      if (!v) return
      const target = centreTarget(v)
      if (target) lookAround(v, target, 0, v.camera.pitch, undefined, 0.8)
    },
    flyTo(lat, lon, range = 30_000, pitchDeg = -35) {
      const v = viewerRef.current
      if (!v) return
      spinning.current = false
      orbit.current = null
      const carto = Cartographic.fromDegrees(lon, lat)
      const h = v.scene.globe.getHeight(carto) ?? 0
      lookAround(v, Cartesian3.fromDegrees(lon, lat, h), 0, CesiumMath.toRadians(pitchDeg), range, 2.5)
    },
    flyToBounds(south, north, west, east) {
      const v = viewerRef.current
      if (!v) return
      spinning.current = false
      orbit.current = null
      const lat = (south + north) / 2, lon = (west + east) / 2
      const spanM = Math.max((north - south) * 111_320, (east - west) * 111_320 * Math.cos(CesiumMath.toRadians(lat)))
      lookAround(v, Cartesian3.fromDegrees(lon, lat), 0, TILTED, Math.min(Math.max(spanM * 1.6, 3000), 12_000_000), 2.5)
    },
    toggleTilt() {
      const v = viewerRef.current
      if (!v) return false
      const target = centreTarget(v)
      if (!target) return false
      const flat = v.camera.pitch < CesiumMath.toRadians(-75)
      lookAround(v, target, v.camera.heading, flat ? TILTED : TOP_DOWN, undefined, 0.9)
      return flat
    },
    rotate(deg) {
      const v = viewerRef.current
      const target = v && centreTarget(v)
      if (v && target) lookAround(v, target, v.camera.heading + CesiumMath.toRadians(deg), v.camera.pitch, undefined, 0.5)
    },
    setOrbit(on) {
      const v = viewerRef.current
      if (!v) return
      spinning.current = false
      orbit.current = on ? centreTarget(v) ?? null : null
    },
    snapshot(credit) {
      const v = viewerRef.current
      if (!v) return null
      v.render() // the WebGL buffer is only readable in the same task as a render
      const src = v.canvas
      const out = document.createElement('canvas')
      out.width = src.width
      out.height = src.height
      const ctx = out.getContext('2d')!
      ctx.drawImage(src, 0, 0)
      const pad = Math.round(8 * (src.width / src.clientWidth))
      ctx.font = `${Math.round(11 * (src.width / src.clientWidth))}px 'IBM Plex Sans', sans-serif`
      const w = ctx.measureText(credit).width
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(0, out.height - pad * 3, w + pad * 2, pad * 3)
      ctx.fillStyle = '#fff'
      ctx.fillText(credit, pad, out.height - pad)
      return out.toDataURL('image/png')
    },
  }))

  useEffect(() => {
    const viewer = new Viewer(containerRef.current!, {
      baseLayer: false, // no Cesium ion: imagery from NASA GIBS, terrain from the open Terrain Tiles
      animation: false,
      timeline: false,
      geocoder: false,
      baseLayerPicker: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      // Pixel density is set explicitly below, capped per device class.
      useBrowserRecommendedResolution: false,
      // Only redraw when something changes (camera, tiles, entities) instead of 60 times a second.
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      msaaSamples: PROFILE.antialias ? 4 : 1,
    })
    const scene = viewer.scene
    setTerrainRedraw(() => !viewer.isDestroyed() && scene.requestRender())
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, PROFILE.maxPixelRatio) / (window.devicePixelRatio || 1)
    scene.postProcessStages.fxaa.enabled = false // MSAA (desktop) is sharper and cheaper than FXAA
    scene.globe.baseColor = Color.fromCssColorString('#0b1220')
    // Offline backdrop bundled with Cesium (Natural Earth II, ~2 km), always at the bottom of the stack: if NASA GIBS
    // is slow or unreachable the globe still shows land and sea instead of a bare blue sphere.
    viewer.imageryLayers.add(ImageryLayer.fromProviderAsync(
      TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')), {}), 0)
    scene.backgroundColor = Color.BLACK
    scene.globe.depthTestAgainstTerrain = true
    scene.globe.maximumScreenSpaceError = PROFILE.screenSpaceError
    scene.screenSpaceCameraController.inertiaSpin = 0.93
    scene.screenSpaceCameraController.inertiaTranslate = 0.93
    scene.screenSpaceCameraController.inertiaZoom = 0.85
    viewer.creditDisplay.addStaticCredit(new Credit(GIBS_ACK))
    viewer.camera.setView({ destination: Cartesian3.fromDegrees(-30, 15, 20_000_000) })
    viewer.camera.percentageChanged = 0.005
    // Cesium's default double-click "tracks" an entity; we use double-click to zoom instead.
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    if (import.meta.env.DEV) (window as unknown as { __viewer: Viewer }).__viewer = viewer

    const tick = viewer.clock.onTick.addEventListener(() => {
      if (spinning.current) viewer.camera.rotate(Cartesian3.UNIT_Z, -0.0006)
      else if (orbit.current) {
        lookAround(viewer, orbit.current, viewer.camera.heading + 0.0025, viewer.camera.pitch)
      }
    })
    const stopMotion = () => {
      spinning.current = false
      orbit.current = null
    }
    viewer.canvas.addEventListener('pointerdown', stopMotion)
    viewer.canvas.addEventListener('wheel', stopMotion)

    const report = () => {
      const c = viewer.camera
      const t = centreTarget(viewer)
      const tc = t && Cartographic.fromCartesian(t)
      cb.current.onView({
        heightM: c.positionCartographic.height,
        headingDeg: CesiumMath.toDegrees(c.heading),
        pitchDeg: CesiumMath.toDegrees(c.pitch),
        centre: tc ? { lat: CesiumMath.toDegrees(tc.latitude), lon: CesiumMath.toDegrees(tc.longitude) } : null,
      })
    }
    const offChanged = viewer.camera.changed.addEventListener(report)
    report()

    const groundAt = (pos: Cartesian2) => {
      const ray = viewer.camera.getPickRay(pos)
      const cart = (ray && scene.globe.pick(ray, scene)) || viewer.camera.pickEllipsoid(pos)
      if (!cart) return null
      const c = Cartographic.fromCartesian(cart)
      return { cart, lat: CesiumMath.toDegrees(c.latitude), lon: CesiumMath.toDegrees(c.longitude), heightM: c.height }
    }

    const handler = new ScreenSpaceEventHandler(viewer.canvas)
    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const hit = scene.pick(e.position)
      const id = hit?.id?.id as string | undefined
      if (id?.startsWith('m:')) return cb.current.onMarker(id.slice(2))
      const p = groundAt(e.position)
      if (p) cb.current.onPick(p.lat, p.lon)
    }, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const p = groundAt(e.position)
      if (!p) return
      stopMotion()
      const range = Cartesian3.distance(viewer.camera.positionWC, p.cart)
      lookAround(viewer, p.cart, viewer.camera.heading, viewer.camera.pitch, range * 0.4, 0.8)
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    let frame = 0
    handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const p = groundAt(e.endPosition)
        cb.current.onCursor(p && { lat: p.lat, lon: p.lon, heightM: p.heightM })
      })
    }, ScreenSpaceEventType.MOUSE_MOVE)
    const leave = () => cb.current.onCursor(null)
    viewer.canvas.addEventListener('mouseleave', leave)

    // Keyboard flying, as in Google Earth: arrows/WASD move, Shift+arrows (or Q/E, R/F) rotate and tilt.
    const keys = new Set<string>()
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    }
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', 'q', 'e', 'r', 'f', '+', '=', '-', '_', 'pageup', 'pagedown'].includes(k)) {
        e.preventDefault()
        stopMotion()
        keys.add(e.shiftKey && k.startsWith('arrow') ? `shift+${k}` : k)
      }
    }
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      keys.delete(k)
      keys.delete(`shift+${k}`)
    }
    const blur = () => keys.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    const keyTick = viewer.clock.onTick.addEventListener(() => {
      if (!keys.size) return
      const cam = viewer.camera
      const h = cam.positionCartographic.height
      const step = Math.max(h * 0.012, 2)
      const has = (...ks: string[]) => ks.some((k) => keys.has(k))
      // Move along the ground in the direction the camera faces.
      const fwd = (has('arrowup', 'w') ? 1 : 0) - (has('arrowdown', 's') ? 1 : 0)
      const right = (has('arrowright', 'd') ? 1 : 0) - (has('arrowleft', 'a') ? 1 : 0)
      if (fwd || right) {
        const c = cam.positionCartographic
        const hd = cam.heading
        const dN = (fwd * Math.cos(hd) - right * Math.sin(hd)) * step
        const dE = (fwd * Math.sin(hd) + right * Math.cos(hd)) * step
        const lat = c.latitude + dN / 6_371_000
        const lon = c.longitude + dE / (6_371_000 * Math.max(Math.cos(c.latitude), 0.01))
        cam.setView({
          destination: Cartesian3.fromRadians(lon, Math.max(Math.min(lat, 1.55), -1.55), c.height),
          orientation: { heading: cam.heading, pitch: cam.pitch, roll: 0 },
        })
      }
      const turn = (has('shift+arrowright', 'e') ? 1 : 0) - (has('shift+arrowleft', 'q') ? 1 : 0)
      const tilt = (has('shift+arrowup', 'r') ? 1 : 0) - (has('shift+arrowdown', 'f') ? 1 : 0)
      if (turn || tilt) {
        const target = centreTarget(viewer)
        if (target) lookAround(viewer, target, cam.heading + turn * 0.02, cam.pitch + tilt * 0.015)
      }
      const zoom = (has('+', '=', 'pageup') ? 1 : 0) - (has('-', '_', 'pagedown') ? 1 : 0)
      if (zoom) cam.moveForward(zoom * h * 0.03)
    })

    viewerRef.current = viewer
    const active = activeRef.current
    return () => {
      tick()
      keyTick()
      offChanged()
      cancelAnimationFrame(frame)
      handler.destroy()
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      active.clear()
      viewer.destroy()
      viewerRef.current = null
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.terrainProvider = terrain ? createTerrainProvider() : new EllipsoidTerrainProvider()
    viewer.scene.requestRender()
  }, [terrain])

  // Reconcile imagery layers with the requested stack (bottom to top).
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const active = activeRef.current
    const wanted = new Map(layers.map((s) => [specKey(s), s]))
    for (const [key, il] of active) {
      if (!wanted.has(key)) {
        viewer.imageryLayers.remove(il, true)
        active.delete(key)
      }
    }
    for (const s of layers) {
      const key = specKey(s)
      let il = active.get(key)
      if (!il) {
        if (s.image) {
          const { url, west, south, east, north, credit } = s.image
          il = ImageryLayer.fromProviderAsync(SingleTileImageryProvider.fromUrl(url, {
            rectangle: Rectangle.fromDegrees(west, south, east, north), credit: new Credit(credit),
          }), {})
          // Crisp pixels: these are 30 m analysis cells, not photos.
          il.magnificationFilter = TextureMagnificationFilter.NEAREST
          il.readyEvent.addEventListener(() => { if (!viewer.isDestroyed()) viewer.scene.requestRender() })
        } else {
          il = new ImageryLayer(makeProvider(layerById(s.layerId), s.date), s.minLevel ? { minimumTerrainLevel: s.minLevel } : undefined)
        }
        viewer.imageryLayers.add(il)
        active.set(key, il)
      }
      il.alpha = s.alpha ?? 1
      il.splitDirection =
        s.split === 'left' ? SplitDirection.LEFT : s.split === 'right' ? SplitDirection.RIGHT : SplitDirection.NONE
      viewer.imageryLayers.raiseToTop(il)
    }
    viewer.scene.requestRender()
  }, [layers])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.scene.splitPosition = split
    viewer.scene.requestRender()
  }, [split, splitActive])

  // Dropped pin and the box the NDVI statistics are averaged over.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    for (const e of pinEntities.current) viewer.entities.remove(e)
    pinEntities.current = []
    viewer.scene.requestRender()
    if (!pin) return
    pinEntities.current.push(viewer.entities.add({
      position: Cartesian3.fromDegrees(pin.lon, pin.lat),
      billboard: {
        image: PIN_SVG, verticalOrigin: VerticalOrigin.BOTTOM, width: 28, height: 38,
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
    if (pin.km > 0) {
      const rect = boxRectangle(pin)
      const w = CesiumMath.toDegrees(rect.west), e = CesiumMath.toDegrees(rect.east)
      const s = CesiumMath.toDegrees(rect.south), n = CesiumMath.toDegrees(rect.north)
      pinEntities.current.push(viewer.entities.add({
        rectangle: { coordinates: rect, material: Color.fromCssColorString('#4285f4').withAlpha(0.14) },
        polyline: {
          positions: Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n, w, s]),
          width: 2, clampToGround: true,
          material: Color.fromCssColorString('#4285f4'),
        },
      }))
    }
    viewer.scene.requestRender()
  }, [pin])

  // Clickable markers (street-level photos, natural events, earthquakes).
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    for (const e of markerEntities.current) viewer.entities.remove(e)
    markerEntities.current = markers.map((m) => viewer.entities.add({
      id: `m:${m.id}`,
      position: Cartesian3.fromDegrees(m.lon, m.lat),
      point: {
        pixelSize: m.size ?? 9, color: Color.fromCssColorString(m.color),
        outlineColor: Color.WHITE, outlineWidth: 2,
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(1e3, 1.2, 5e6, 0.6),
      },
      label: m.label ? {
        text: m.label, font: "500 12px 'IBM Plex Sans', sans-serif", fillColor: Color.WHITE, outlineColor: Color.BLACK,
        outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -10), heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new DistanceDisplayCondition(0, 2_500_000),
      } : undefined,
    }))
    viewer.scene.requestRender()
  }, [markers])

  return (
    <div className="globe-wrap">
      <div ref={containerRef} className="globe" />
      {splitActive && <SplitHandle position={split} onChange={setSplit} />}
    </div>
  )
})

export default Globe

function SplitHandle({ position, onChange }: { position: number; onChange: (p: number) => void }) {
  const dragging = useRef(false)
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      const parent = document.querySelector('.globe-wrap')!.getBoundingClientRect()
      onChange(Math.min(0.98, Math.max(0.02, (e.clientX - parent.left) / parent.width)))
    }
    const up = () => (dragging.current = false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [onChange])
  return (
    <div
      className="split-handle"
      style={{ left: `${position * 100}%` }}
      onPointerDown={(e) => {
        dragging.current = true
        e.preventDefault()
      }}
      role="slider"
      aria-label="Comparison divider"
      aria-valuenow={Math.round(position * 100)}
    >
      <span>⟷</span>
    </div>
  )
}
