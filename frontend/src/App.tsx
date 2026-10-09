import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type AnomalyEvent, type EventsResult, type Place, type Series, type StreetImage, type StreetNearby } from './api'
import DateBar, { type CompareState } from './components/DateBar'
import Globe, { type GlobeHandle, type LayerSpec, type Marker, type ViewState } from './components/Globe'
import LayersPanel from './components/LayersPanel'
import Licences from './components/Licences'
import MapControls from './components/MapControls'
import PlaceCard, { type CardTab, type ExportKind, type Options, type PlaceInfo } from './components/PlaceCard'
import SearchBar, { type SearchPick } from './components/SearchBar'
import Tour, { type TourStep } from './components/Tour'
import Icon from './components/Icon'
import ReportView from './components/ReportView'
import {
  buildReport, downloadReportHtml, exportChartImages, exportCsv, exportGeoJson, exportJson, exportPng, exportSavedPlaces,
  loadSaved, readShareUrl, shareUrl, storeSaved, type SavedPlace,
} from './exporters'
import { GIBS_ACK } from './layers'
import StreetView from './components/StreetView'
import { createBus, useBus, type Bus } from './bus'
import { layerById } from './layers'
import { useFetch } from './useFetch'
import { useSharpImagery } from './useSharpImagery'
import SharpChip from './components/SharpChip'
import { fmtDistance, fmtLatLon, isoDaysAgo, shiftDate } from './util'
import './App.css'
import './panels.css'
import './extras.css'

const THIS_YEAR = new Date().getUTCFullYear()
type Cursor = { lat: number; lon: number; heightM?: number } | null
const round5 = (v: number) => +v.toFixed(5)

export default function App() {
  const globe = useRef<GlobeHandle>(null)
  // A shared link (#lat=..&lon=..) sets the starting view.
  const [link] = useState(readShareUrl)
  const [base, setBase] = useState(link?.base ?? 'bluemarble')
  const [overlays, setOverlays] = useState<string[]>(['labels'])
  const [opacity, setOpacity] = useState(0.85)
  const [date, setDate] = useState(link?.date ?? isoDaysAgo(2))
  const [compare, setCompare] = useState<CompareState>({
    on: false, layerId: 'ndvi', a: shiftDate(isoDaysAgo(30), -365), b: isoDaysAgo(30),
  })

  const [examples, setExamples] = useState<Place[]>([])
  const [place, setPlace] = useState<PlaceInfo | null>(() =>
    link ? { lat: +link.lat.toFixed(5), lon: +link.lon.toFixed(5), km: link.km, name: null, label: null, country: null } : null)
  const [tab, setTab] = useState<CardTab>(() =>
    link?.tab && ['overview', 'charts', 'anomalies', 'street', 'weather', 'news'].includes(link.tab) ? (link.tab as CardTab) : 'overview')
  const [options, setOptions] = useState<Options>({ start: THIS_YEAR - 9, end: THIS_YEAR, z: 2, drop: 0.1 })
  const [result, setResult] = useState<{ key: string; series?: Series; error?: string } | null>(null)
  const [focus, setFocus] = useState<{ key: string; index: number } | null>(null)

  // Cursor and camera change every frame; keep them out of App state so the card and charts don't re-render.
  const [cursorBus] = useState(() => createBus<Cursor>(null))
  const [viewBus] = useState(() => createBus<ViewState>({ heightM: 20_000_000, headingDeg: 0, pitchDeg: -90, centre: null }))
  const [sharpOn, setSharpOn] = useState(true)
  const sharp = useSharpImagery(viewBus, sharpOn)
  const [terrain, setTerrain] = useState(true)
  const [orbiting, setOrbiting] = useState(false)
  const [pegman, setPegman] = useState(false)
  const [streetOpen, setStreetOpen] = useState<StreetImage | null>(null)
  const [streetPending, setStreetPending] = useState(false)
  const [locating, setLocating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [showLicences, setShowLicences] = useState(false)
  const [saved, setSaved] = useState<SavedPlace[]>(loadSaved)
  const [report, setReport] = useState<string | null>(null)
  const [touring, setTouring] = useState(() => {
    try {
      return !localStorage.getItem('earthos.tour.done') && !location.hash
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (!link) return
    const la = +link.lat.toFixed(5), lo = +link.lon.toFixed(5)
    api.reverse(link.lat, link.lon).then((r) => r && setPlace((p) => (p && p.lat === la && p.lon === lo && !p.name
      ? { ...p, name: r.name, label: r.label, country: r.country ?? null } : p))).catch(() => {})
    const t = setTimeout(() => globe.current?.flyTo(link.lat, link.lon, 25_000), 600)
    return () => clearTimeout(t)
  }, [link])

  useEffect(() => {
    api.places().then(setExamples).catch(() => setNotice('Data server not reachable. Start the backend on port 8000.'))
  }, [])

  // Main NDVI/climate series: one request per pin + options; stale results are ignored.
  const pLat = place?.lat, pLon = place?.lon, pKm = place?.km
  const query = useMemo(() => pLat == null || pLon == null || pKm == null ? null : {
    lat: pLat, lon: pLon, km: pKm,
    start_year: options.start, end_year: options.end, z: options.z, drop: options.drop,
  }, [pLat, pLon, pKm, options])
  const queryKey = query ? JSON.stringify(query) : null
  useEffect(() => {
    if (!query || !queryKey) return
    const ctrl = new AbortController()
    api.series(query, ctrl.signal)
      .then((s) => setResult({ key: queryKey, series: s }))
      .catch((e: Error) => !ctrl.signal.aborted && setResult({ key: queryKey, error: e.message }))
    return () => ctrl.abort()
  }, [query, queryKey])
  const current = result && result.key === queryKey ? result : null
  const series = current?.series ?? null
  const error = current?.error ?? null
  const loading = !!queryKey && !current
  const focusIndex = focus && focus.key === queryKey ? focus.index : null
  const setFocusIndex = (i: number | null) => setFocus(i == null || !queryKey ? null : { key: queryKey, index: i })

  // Street-level photos near the pin; events/news only once the News tab is opened (GDELT is rate-limited).
  const pointKey = pLat != null && pLon != null ? `${pLat},${pLon}` : null
  const street = useFetch<StreetNearby>(pointKey, (s) => api.street(pLat!, pLon!, s))
  const eventsKey = pointKey && tab === 'news' ? `${pointKey}|${place?.name}|${place?.country}` : null
  const events = useFetch<EventsResult>(eventsKey, (s) => api.events({
    lat: pLat!, lon: pLon!, place: place?.name ?? undefined, country: place?.country ?? undefined,
  }, s))

  // After a pegman drop, open the nearest photo as soon as the search returns.
  if (streetPending && !street.loading && pointKey) {
    setStreetPending(false)
    const first = street.data?.items[0]
    if (first) setStreetOpen(first)
    else setNotice(street.error ? `Street imagery unavailable: ${street.error}` : 'No street-level photos within 600 m of that spot.')
  }

  const openPlace = useCallback((lat: number, lon: number, name: string | null = null, label: string | null = null,
    km?: number, country: string | null = null) => {
    const la = round5(lat), lo = round5(lon)
    setPlace((prev) => ({ lat: la, lon: lo, km: km ?? prev?.km ?? 1, name, label, country }))
    if (name == null || country == null) {
      // Name the dropped pin like Maps does; failure just leaves "Dropped pin".
      api.reverse(lat, lon).then((r) => r && setPlace((p) => (p && p.lat === la && p.lon === lo
        ? { ...p, name: p.name ?? r.name, label: p.label ?? r.label, country: p.country ?? r.country ?? null } : p))).catch(() => {})
    }
  }, [])

  const onPick = useCallback((lat: number, lon: number) => {
    if (pegman) {
      setPegman(false)
      setStreetPending(true)
      setTab('street')
    }
    openPlace(lat, lon)
  }, [openPlace, pegman])

  const onSearch = (p: SearchPick) => {
    if (p.kind === 'coords') {
      openPlace(p.lat, p.lon)
      globe.current?.flyTo(p.lat, p.lon, 25_000)
    } else if (p.kind === 'saved') {
      openPlace(p.saved.lat, p.saved.lon, p.saved.name, p.saved.label, p.saved.km, p.saved.country)
      globe.current?.flyTo(p.saved.lat, p.saved.lon, 25_000)
    } else if (p.kind === 'place') {
      openPlace(p.place.lat, p.place.lon, p.place.name, `${p.place.about} · ${p.place.country}`, p.place.km, p.place.country ?? null)
      globe.current?.flyTo(p.place.lat, p.place.lon, 25_000)
    } else {
      const r = p.result
      openPlace(r.lat, r.lon, r.name, r.label, undefined, r.label.split(',').at(-1)?.trim() ?? null)
      if (r.bbox) globe.current?.flyToBounds(...r.bbox)
      else globe.current?.flyTo(r.lat, r.lon, 40_000)
    }
  }

  const locate = () => {
    if (!navigator.geolocation) return setNotice('Location is not available in this browser.')
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        openPlace(pos.coords.latitude, pos.coords.longitude)
        globe.current?.flyTo(pos.coords.latitude, pos.coords.longitude, 15_000)
      },
      () => {
        setLocating(false)
        setNotice('Could not get your location (permission denied or unavailable).')
      },
      { timeout: 10_000 },
    )
  }

  const showEvent = (ev: AnomalyEvent) => {
    // Same 16-day slot one year earlier, side by side with the event's first composite.
    setCompare({ on: true, layerId: 'ndvi', a: shiftDate(ev.start, -368), b: ev.start })
    setDate(ev.start)
    if (place) globe.current?.flyTo(place.lat, place.lon, Math.max(8000, place.km * 9000), -50)
  }

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setShowLicences(false)
      setPegman(false)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const stack = useMemo<LayerSpec[]>(() => {
    const out: LayerSpec[] = [{ layerId: base, date }]
    for (const p of sharpOn ? [sharp.fill, sharp.pass] : []) {
      if (p) out.push({ layerId: p.sensor === 'S30' ? 'hls-s30' : 'hls-l30', date: p.date, minLevel: 9 })
    }
    if (compare.on) {
      out.push({ layerId: compare.layerId, date: compare.a, split: 'left' })
      out.push({ layerId: compare.layerId, date: compare.b, split: 'right' })
    }
    for (const id of overlays) {
      if (compare.on && id === compare.layerId) continue
      out.push({ layerId: id, date, alpha: layerById(id).credit ? 1 : opacity })
    }
    return out
  }, [base, date, overlays, opacity, compare, sharpOn, sharp.pass, sharp.fill])

  // Markers: photo locations on the Street tab, events/earthquakes on the News tab.
  const markers = useMemo<Marker[]>(() => {
    if (place && (tab === 'street' || streetOpen) && street.data) {
      return street.data.items.slice(0, 150).map((i) => ({
        id: `s:${i.provider}:${i.id}`, lat: i.lat, lon: i.lon, size: streetOpen?.id === i.id ? 13 : 7,
        color: streetOpen?.id === i.id ? '#fbbc04' : '#1a73e8',
      }))
    }
    if (place && tab === 'news' && events.data) {
      return [
        ...events.data.natural.map((e, i) => ({ id: `n:${i}`, lat: e.lat, lon: e.lon, color: '#e8710a', size: 11, label: e.title })),
        ...events.data.earthquakes.map((q, i) => ({ id: `q:${i}`, lat: q.lat, lon: q.lon, color: '#d93025', size: 6 + q.magnitude * 1.5, label: `M${q.magnitude}` })),
      ]
    }
    return []
  }, [place, tab, street.data, streetOpen, events.data])

  const onMarker = useCallback((id: string) => {
    const [kind, ...rest] = id.split(':')
    if (kind === 's') {
      const img = street.data?.items.find((i) => i.provider === rest[0] && i.id === rest[1])
      if (img) setStreetOpen(img)
    } else if (kind === 'n' && events.data) {
      const e = events.data.natural[+rest[0]]
      if (e?.url) window.open(e.url, '_blank', 'noopener')
    } else if (kind === 'q' && events.data) {
      const q = events.data.earthquakes[+rest[0]]
      if (q) window.open(q.url, '_blank', 'noopener')
    }
  }, [street.data, events.data])

  const pin = useMemo(() => (place ? { lat: place.lat, lon: place.lon, km: place.km } : null), [place])
  const onDate = useCallback((d: string) => setDate(d), [])

  const isSaved = !!place && saved.some((s) => s.lat === place.lat && s.lon === place.lon)
  const toggleSave = () => {
    if (!place) return
    const next = isSaved
      ? saved.filter((s) => !(s.lat === place.lat && s.lon === place.lon))
      : [{ lat: place.lat, lon: place.lon, km: place.km, name: place.name ?? fmtLatLon(place.lat, place.lon), label: place.label, country: place.country, saved: new Date().toISOString() }, ...saved]
    setSaved(next)
    storeSaved(next)
    setNotice(isSaved ? 'Removed from saved places' : 'Saved. Find it in the search box under "Saved places".')
  }

  const share = async () => {
    if (!place) return false
    const url = shareUrl({ lat: place.lat, lon: place.lon, km: place.km, date, base, tab })
    history.replaceState(null, '', url)
    try {
      await navigator.clipboard.writeText(url)
      return true
    } catch {
      setNotice(`Copy this link: ${url}`)
      return false
    }
  }

  const credits = `${GIBS_ACK} ${sharpOn && sharp.pass ? 'NASA HLS (contains modified Copernicus Sentinel data). ' : ''}${terrain ? 'Terrain: Terrain Tiles (USGS, NOAA and others).' : ''}`
  const onExport = async (kind: ExportKind) => {
    if (!place) return
    if (kind === 'csv' && series) exportCsv(place, series)
    else if (kind === 'json') await exportJson(place, series, street.data, events.data)
    else if (kind === 'geojson') exportGeoJson(place, street.data, events.data)
    else if (kind === 'png') {
      const url = globe.current?.snapshot(credits)
      if (url) exportPng(place, url)
    } else if (kind === 'charts') {
      if (tab !== 'charts') {
        setTab('charts')
        throw new Error('Opened the Charts tab. Choose "Chart images" again once the charts have loaded.')
      }
      const n = await exportChartImages(place)
      if (!n) throw new Error('No charts are ready yet.')
    } else if (kind === 'report') {
      setReport(await buildReport(place, series, globe.current?.snapshot(credits) ?? null))
    }
  }

  const endTour = () => {
    setTouring(false)
    try {
      localStorage.setItem('earthos.tour.done', '1')
    } catch {
      /* best effort */
    }
  }
  const example = examples.find((e) => e.id === 'guanacaste') ?? examples[0]
  const tourSteps: TourStep[] = [
    { title: 'Welcome to EarthOS', body: 'Explore satellite, climate and terrain data for anywhere on Earth. This 1-minute tour shows the essentials. Use the arrow keys or the buttons to move through it.' },
    { target: '.search-box', title: 'Search anywhere', body: 'Type a place name or coordinates (like "-3.1, -60.0") and press Enter. Press / at any time to jump here. Example and saved places appear when you click in.' },
    { title: 'Move like Google Earth', body: 'Drag to pan, scroll or double-click to zoom, and Ctrl+drag to tilt. W A S D flies, Q/E rotates and R/F tilts. Click anywhere to drop a pin. When you zoom in close, EarthOS loads sharp 30 m imagery from the clearest recent satellite pass.' },
    { target: '.controls', title: 'Map controls', body: 'From the top: shortcuts help, street-level photos (click it, then the globe), compass with rotate arrows, 2D/3D tilt, orbit, 3D terrain, your location and zoom.' },
    { target: '.layers-btn', title: 'Layers', body: 'Switch map imagery and add data layers such as vegetation (NDVI), land temperature, rainfall, fires and labels. You can also turn sharp 30 m imagery on or off here.' },
    { target: '.datebar', title: 'Time travel', body: 'Step through dates, or press Compare to swipe between two dates side by side.' },
    {
      target: '.card', title: 'Place card', body: 'Dropping a pin opens a card. Here is an example place. Overview shows today\'s readings and the terrain, and the other tabs hold charts, anomalies, street photos, the weather forecast and nearby news.',
      enter: () => { if (example && !place) onSearch({ kind: 'place', place: example }) },
    },
    { target: '.card-tabs', title: 'Six tabs of data', body: 'Charts has 11 graphs: vegetation, temperature, rain, sunlight, humidity, soil moisture, wind, fire and land cover. Anomalies flags unusual periods. Everything is measured data, with no guesses about causes.' },
    { target: '.actions', title: 'Save, share and download', body: 'Star a place to save it, copy a link that reopens this exact view, or download the data as CSV, JSON, GeoJSON, map and chart images, or a printable PDF report.' },
    { target: '.tour-btn', title: 'Replay any time', body: 'Press Tutorial to see this tour again. Enjoy exploring!' },
  ]


  return (
    <div className={`app ${place ? 'with-card' : ''} ${pegman ? 'pegman-mode' : ''}`}>
      <Globe ref={globe} layers={stack} splitActive={compare.on} pin={pin} markers={markers} terrain={terrain}
        onPick={onPick} onMarker={onMarker} onCursor={cursorBus.set} onView={viewBus.set} />

      <SearchBar examples={examples} saved={saved} onExportSaved={() => exportSavedPlaces(saved)} title={place ? place.name ?? fmtLatLon(place.lat, place.lon) : null}
        onPick={onSearch} onClear={() => setPlace(null)} />

      {place && (
        <PlaceCard
          key={`${place.lat},${place.lon}`}
          place={place} tab={tab} onTab={setTab} series={series} loading={loading} error={error}
          street={street} events={events}
          date={date} compare={compare} options={options} thisYear={THIS_YEAR}
          focus={focusIndex} onFocus={setFocusIndex}
          onOptions={(o, km) => { setOptions(o); if (km !== place.km) setPlace({ ...place, km }) }}
          onDate={onDate}
          onZoomTo={() => globe.current?.flyTo(place.lat, place.lon, Math.max(6000, place.km * 9000))}
          onShowEvent={showEvent}
          onOpenStreet={setStreetOpen}
          onFly={(lat, lon) => globe.current?.flyTo(lat, lon, 120_000, -45)}
          saved={isSaved} onToggleSave={toggleSave} onShare={share} onExport={onExport}
          onClose={() => setPlace(null)}
        />
      )}

      {compare.on && (
        <div className="compare-labels" aria-hidden>
          <span>A · {compare.a}</span>
          <span>B · {compare.b}</span>
        </div>
      )}

      {pegman && <div className="toast" role="status">Click anywhere on the globe to see street-level photos there · Esc to cancel</div>}
      {streetPending && <div className="toast" role="status">Looking for street-level photos…</div>}
      {notice && <div className="toast" role="status">{notice}</div>}

      {sharpOn && <SharpChip view={viewBus} pass={sharp.pass} passes={sharp.passes} loading={sharp.loading} onChoose={sharp.choose} />}

      <LayersPanel base={base} overlays={overlays} opacity={opacity} sharp={sharpOn} onSharp={setSharpOn} onBase={setBase} onOpacity={setOpacity}
        onToggle={(id) => setOverlays((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]))} />

      <DateBar date={date} onDate={setDate} compare={compare} onCompare={setCompare}
        legendLayers={compare.on ? [compare.layerId, ...overlays] : overlays} />

      <MapControls view={viewBus} terrain={terrain} orbiting={orbiting}
        pegman={pegman} locating={locating}
        onZoom={(d) => globe.current?.zoom(d)} onNorth={() => globe.current?.resetNorth()}
        onRotate={(deg) => globe.current?.rotate(deg)} onTilt={() => globe.current?.toggleTilt()}
        onOrbit={() => {
          globe.current?.setOrbit(!orbiting)
          setOrbiting(!orbiting)
        }}
        onTerrain={() => setTerrain(!terrain)} onPegman={() => setPegman(!pegman)} onLocate={locate} />

      <StatusBar cursor={cursorBus} view={viewBus} terrain={terrain} onLicences={() => setShowLicences(true)} />

      {streetOpen && street.data && (
        <StreetView origin={{ lat: place?.lat ?? streetOpen.lat, lon: place?.lon ?? streetOpen.lon }} images={street.data.items} start={streetOpen} attribution={street.data.attribution}
          onChange={setStreetOpen} onClose={() => setStreetOpen(null)} />
      )}

      <button className="tour-btn" onClick={() => setTouring(true)} title="Show the guided tour">
        <Icon name="school" size={18} /> Tutorial
      </button>

      {showLicences && <Licences onClose={() => setShowLicences(false)} />}
      {touring && <Tour steps={tourSteps} onClose={endTour} />}
      {report && place && (
        <ReportView html={report} onDownload={() => downloadReportHtml(place, report)} onClose={() => setReport(null)} />
      )}
    </div>
  )
}

function StatusBar({ cursor, view, terrain, onLicences }: { cursor: Bus<Cursor>; view: Bus<ViewState>; terrain: boolean; onLicences: () => void }) {
  const c = useBus(cursor)
  const v = useBus(view)
  return (
    <footer className="status">
      <span>
        {c ? fmtLatLon(c.lat, c.lon, 3) : 'Click the globe to explore a place'}
        {c && terrain && c.heightM != null ? ` · elevation ${Math.round(c.heightM).toLocaleString()} m` : ''}
      </span>
      <span>Camera {fmtDistance(v.heightM)} · tilt {Math.round(90 + v.pitchDeg)}°</span>
      <button className="link" onClick={onLicences}>Data sources &amp; licences</button>
    </footer>
  )
}
