import { Credit, CustomHeightmapTerrainProvider, WebMercatorTilingScheme } from 'cesium'
import { PROFILE } from './perf'

// Open Terrain Tiles (Terrarium PNG encoding), public on AWS with CORS.
// Attribution: https://github.com/tilezen/joerd/blob/master/docs/attribution.md
const URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium'

export const TERRAIN_CREDIT =
  'Terrain: Terrain Tiles (Mapzen/AWS) · USGS 3DEP, SRTM, GMTED2010 · ETOPO1 (NOAA) · EU-DEM (Copernicus) · Geoscience Australia · Kartverket · LINZ · and others'

// A small pool of decoder workers keeps PNG decoding off the main (rendering) thread.
type Pending = { resolve: (h: Float32Array) => void; reject: (e: Error) => void }
let pool: Worker[] | null = null
let next = 0
let jobId = 0
const pending = new Map<number, Pending>()

// The globe draws on demand, and Cesium only knows about its own downloads. Terrain decoded by our
// workers must ask for a redraw, or freshly loaded tiles would wait until the camera next moves.
let onTileReady: () => void = () => {}
export function setTerrainRedraw(fn: () => void) {
  onTileReady = fn
}

function workers() {
  if (pool) return pool
  const n = Math.min(Math.max((navigator.hardwareConcurrency ?? 4) - 2, 1), 3)
  pool = Array.from({ length: n }, () => {
    const w = new Worker(new globalThis.URL('./terrainWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ id: number; heights?: Float32Array; error?: string }>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.heights) p.resolve(e.data.heights)
      else p.reject(new Error(e.data.error ?? 'terrain decode failed'))
      // Resolve first, then redraw on the next frame so Cesium picks the tile up.
      setTimeout(onTileReady, 0)
    }
    return w
  })
  return pool
}

function heights(x: number, y: number, level: number): Promise<Float32Array> {
  const id = ++jobId
  const w = workers()[next++ % workers().length]
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, url: `${URL}/${level}/${x}/${y}.png`, samples: PROFILE.terrainSamples })
  })
}

export function createTerrainProvider() {
  return new CustomHeightmapTerrainProvider({
    width: PROFILE.terrainSamples,
    height: PROFILE.terrainSamples,
    tilingScheme: new WebMercatorTilingScheme(),
    credit: new Credit(TERRAIN_CREDIT),
    // Returning undefined marks a tile unavailable; Cesium then upsamples the parent.
    callback: (x, y, level) => (level > PROFILE.terrainMaxLevel ? undefined : heights(x, y, level)),
  })
}
