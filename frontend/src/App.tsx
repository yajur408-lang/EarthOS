import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type AnomalyEvent, type EventsResult, type HazardEvent, type HazardEvents, type HazardType, type InspectSite, type Priority, type SuscMode, type Place, type Series, type StreetImage, type StreetNearby } from './api'
import DateBar, { type CompareState } from './components/DateBar'
import type { GlobeHandle, LayerSpec, Marker, ViewState } from './components/Globe'
import LayersPanel from './components/LayersPanel'
import MapControls from './components/MapControls'
import PlaceCard, { type CardTab, type ExportKind, type Options, type PlaceInfo, type Sheet } from './components/PlaceCard'
import SearchBar, { type SearchPick } from './components/SearchBar'
import Story, { type StoryControls } from './components/Story'
import HazardsPanel from './components/HazardsPanel'
import ScreeningFooter from './components/ScreeningFooter'
import { useChangeJob, useScreening } from './useScreening'
import NaturalHazards from './components/NaturalHazards'
import InspectionList from './components/InspectionList'
import { HAZARD_COLORS } from './hazardColors'
import Icon from './components/Icon'
import {
  buildReport, downloadReportHtml, exportChartImages, exportCsv, exportGeoJson, exportJson, exportPng, exportSavedPlaces,
  loadSaved, readShareUrl, shareUrl, storeSaved, type SavedPlace,
} from './exporters'
import { GIBS_ACK } from './layers'
import { createBus, useBus, type Bus } from './bus'
import { layerById } from './layers'
import { useFetch } from './useFetch'
import { useSharpImagery } from './useSharpImagery'
import { PROFILE } from './perf'
import SharpChip from './components/SharpChip'
import { fmtDistance, fmtLatLon, isoDaysAgo, shiftDate } from './util'
import './App.css'

// Heavy pieces load on demand so the page's controls appear immediately.
const Globe = lazy(() => import('./components/Globe')) // CesiumJS, ~4 MB
const StreetView = lazy(() => import('./components/StreetView')) // panorama viewer + three.js
const ReportView = lazy(() => import('./components/ReportView'))
const Licences = lazy(() => import('./components/Licences'))
import './panels.css'
import './extras.css'
import './story.css'
import './hazards.css'

const THIS_YEAR = new Date().getUTCFullYear()
type Cursor = { lat: number; lon: number; heightM?: number } | null
const round5 = (v: number) => +v.toFixed(5)

export default function App() {
  const globe = useRef<GlobeHandle>(null)
  // A shared link (#lat=..&lon=..) sets the starting view; /explore?pilot=santa-ana opens the hazard pilot.
  const [link] = useState(readShareUrl)
  const [pilot] = useState(() => !link && new URLSearchParams(location.search).get('pilot') === 'santa-ana')
  const [base, setBase] = useState(link?.base ?? 'bluemarble')
  const [overlays, setOverlays] = useState<string[]>(['labels'])
  const [opacity, setOpacity] = useState(0.85)
  const [date, setDate] = useState(link?.date ?? isoDaysAgo(2))
  const [compare, setCompare] = useState<CompareState>({
    on: false, layerId: 'ndvi', a: shiftDate(isoDaysAgo(30), -365), b: isoDaysAgo(30),
  })

  const [examples, setExamples] = useState<Place[]>([])
  const [place, setPlace] = useState<PlaceInfo | null>(() =>
    link ? { lat: +link.lat.toFixed(5), lon: +link.lon.toFixed(5), km: link.km, name: null, label: null, country: null }
      : pilot ? { lat: 9.915, lon: -84.19, km: 1, name: 'Santa Ana', label: 'Pilot area: landslides and flash floods · San José, Costa Rica', country: 'Costa Rica' }
        : null)
  const [sheet, setSheet] = useState<Sheet>(pilot ? 'half' : 'peek')
  const [tab, setTab] = useState<CardTab>(() => pilot ? 'hazards' :
    link?.tab && ['overview', 'hazards', 'charts', 'anomalies', 'street', 'weather', 'news'].includes(link.tab) ? (link.tab as CardTab) : 'overview')
  const [options, setOptions] = useState<Options>({ start: THIS_YEAR - 9, end: THIS_YEAR, z: 2, drop: 0.1 })
  const [result, setResult] = useState<{ key: string; series?: Series; error?: string } | null>(null)
  const [focus, setFocus] = useState<{ key: string; index: number } | null>(null)

  // Cursor and camera change every frame; keep them out of App state so the card and charts don't re-render.
  const [cursorBus] = useState(() => createBus<Cursor>(null))
  const [viewBus] = useState(() => createBus<ViewState>({ heightM: 20_000_000, headingDeg: 0, pitchDeg: -90, centre: null }))
  const [sharpOn, setSharpOn] = useState(true)
  const sharp = useSharpImagery(viewBus, sharpOn, date)
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
  // Guided example: opened from the landing page (?story=santa-rosa) or the "Guided example" button.
  // First-time visitors get a small, dismissible invitation instead of a blocking tour.
  const [storyOn, setStoryOn] = useState(() => new URLSearchParams(location.search).get('story') === 'santa-rosa')
  const [invite, setInvite] = useState(() => {
    try {
      return !storyOn && !pilot && !location.hash && !localStorage.getItem('earthos.story.seen')
    } catch {
      return false
    }
  })
  const dismissInvite = () => {
    setInvite(false)
    try {
      localStorage.setItem('earthos.story.seen', '1')
    } catch {
      /* best effort */
    }
  }
  // Weather and nearby events are optional context, off by default.
  const [extras, setExtras] = useState(() => {
    try {
      return localStorage.getItem('earthos.extras') === '1'
    } catch {
      return false
    }
  })
  const toggleExtras = (on: boolean) => {
    setExtras(on)
    if (!on && (tab === 'weather' || tab === 'news')) setTab('overview')
    try {
      localStorage.setItem('earthos.extras', on ? '1' : '0')
    } catch {
      /* best effort */
    }
  }

  useEffect(() => {
    if (!link) return
    const la = +link.lat.toFixed(5), lo = +link.lon.toFixed(5)
    api.reverse(link.lat, link.lon).then((r) => r && setPlace((p) => (p && p.lat === la && p.lon === lo && !p.name
      ? { ...p, name: r.name, label: r.label, country: r.country ?? null } : p))).catch(() => {})
    // The globe loads lazily, so wait until it exists before flying there.
    const t = setInterval(() => {
      if (!globe.current) return
      clearInterval(t)
      globe.current.flyTo(link.lat, link.lon, 25_000)
    }, 250)
    return () => clearInterval(t)
  }, [link])

  // Pilot entry point (/explore?pilot=santa-ana): fly to Santa Ana once the globe exists.
  useEffect(() => {
    if (!pilot) return
    const t = setInterval(() => {
      if (!globe.current) return
      clearInterval(t)
      globe.current.flyToBounds(9.861, 9.969, -84.245, -84.135)
    }, 250)
    return () => clearInterval(t)
  }, [pilot])

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
  // Progressive loading: ORNL answers slowly (20-60 s per request), so ask for the last ~2 years first and
  // show them while the full record (needed for seasonal statistics) keeps loading. The server shares
  // the overlapping downloads, so the quick request adds no extra work.
  const [quick, setQuick] = useState<{ key: string; series: Series } | null>(null)
  useEffect(() => {
    if (!query || !queryKey) return
    const ctrl = new AbortController()
    const loadFull = () => api.series(query, ctrl.signal)
      .then((s) => setResult({ key: queryKey, series: s }))
      .catch((e: Error) => !ctrl.signal.aborted && setResult({ key: queryKey, error: e.message }))
    // ORNL shares its time across everything we ask for, so asking for old years in parallel slows the
    // recent ones. Ask for the current year first (plus last year in Jan-Mar, ~4 requests, ~20 s), show it,
    // then load the full record, which reuses those downloads.
    const quickStart = Math.max(query.start_year, query.end_year - (new Date().getUTCMonth() < 3 ? 1 : 0))
    if (quickStart > query.start_year) {
      api.series({ ...query, start_year: quickStart }, ctrl.signal)
        .then((s) => setQuick({ key: queryKey, series: s }))
        .catch(() => { /* the full request below reports any error */ })
        .finally(() => !ctrl.signal.aborted && loadFull())
    } else {
      loadFull()
    }
    return () => ctrl.abort()
  }, [query, queryKey])
  const current = result && result.key === queryKey ? result : null
  const partial = !current?.series && quick?.key === queryKey ? quick.series : null
  const series = current?.series ?? partial
  const error = current?.error ?? null
  const loading = !!queryKey && !current?.series && !current?.error
  const focusIndex = focus && focus.key === queryKey ? focus.index : null
  const setFocusIndex = (i: number | null) => setFocus(i == null || !queryKey ? null : { key: queryKey, index: i })

  // Street-level photos near the pin; events/news only once the News tab is opened (GDELT is rate-limited).
  const pointKey = pLat != null && pLon != null ? `${pLat},${pLon}` : null
  const street = useFetch<StreetNearby>(pointKey, (s) => api.street(pLat!, pLon!, s))
  // Hazard screening: loads with the Hazards tab, or while one of its map layers is on.
  const [hazardLayers, setHazardLayers] = useState({ susc: pilot, loss: pilot })
  const [suscMode, setSuscMode] = useState<SuscMode>('combined')
  const screening = useScreening(place, tab === 'hazards' || hazardLayers.susc || hazardLayers.loss, date)
  // Natural hazards near the place (all years, or around the date bar's day) and a 30 m before/after check.
  const [hazAround, setHazAround] = useState(false)
  const [hazSel, setHazSel] = useState<HazardEvent | null>(null)
  const [showChange, setShowChange] = useState(true)
  const hazKey = pointKey && tab === 'hazards' ? `${pointKey}|${hazAround ? date : 'all'}` : null
  const hazEvents = useFetch<HazardEvents>(hazKey, (s) => api.hazardEvents({
    lat: pLat!, lon: pLon!, ...(hazAround ? { start: shiftDate(date, -60), end: shiftDate(date, 60) } : {}) }, s))
  // Where to inspect first: ranked 250 m squares for the screening area.
  const [inspectKind, setInspectKind] = useState<InspectSite['kind']>('slope')
  const [inspectSel, setInspectSel] = useState<string | null>(null)
  const prioKey = pointKey && tab === 'hazards' ? pointKey : null
  const prio = useFetch<Priority>(prioKey, (s) => api.priority(pLat!, pLon!, s))
  const change = useChangeJob(place, hazSel && hazSel.satellite_check ? { hazard: hazSel.type as HazardType, date: hazSel.date } : null)
  const eventsKey = pointKey && extras && tab === 'news' ? pointKey : null
  const events = useFetch<EventsResult>(eventsKey, (s) => api.events({ lat: pLat!, lon: pLon! }, s))

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
    setSheet('peek')
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
    for (const p of sharpOn ? [PROFILE.sharpFill ? sharp.fill : null, sharp.pass] : []) {
      if (p) out.push({ layerId: p.sensor === 'S30' ? 'hls-s30' : 'hls-l30', date: p.date, minLevel: 9 })
    }
    if (compare.on) {
      out.push({ layerId: compare.layerId, date: compare.a, split: 'left' })
      out.push({ layerId: compare.layerId, date: compare.b, split: 'right' })
    }
    const scr = screening.data
    if (scr && hazardLayers.susc && !scr.susceptibility.error) {
      out.push({ layerId: 'screen-susc', image: { url: api.url(`${scr.overlay}&mode=${suscMode}`), ...scr.susceptibility.bounds,
        credit: 'EarthOS susceptibility: Terrain Tiles (SRTM), ESA WorldCover 2021 (CC BY 4.0)' } })
    }
    const loss = screening.loss
    const lossRes = loss?.status === 'done' ? loss : loss?.previous
    if (lossRes?.has_overlay && lossRes.bounds && hazardLayers.loss && loss?.overlay) {
      const end = loss.status === 'done' ? loss.end : (loss.previous?.end ?? loss.end)
      out.push({ layerId: 'screen-loss', image: { url: api.url(loss.overlay.replace(/end=[\d-]+/, `end=${end}`)), ...lossRes.bounds,
        credit: 'EarthOS forest-loss watch: NASA HLS VI v2.0 (contains modified Copernicus Sentinel data)' } })
    }
    const ch = change.status
    if (ch?.status === 'done' && ch.has_overlay && ch.bounds && showChange) {
      out.push({ layerId: 'screen-change', image: { url: api.url(ch.overlay), ...ch.bounds,
        credit: 'EarthOS change check: NASA HLS VI v2.0 (contains modified Copernicus Sentinel data)' } })
    }
    for (const id of overlays) {
      if (compare.on && id === compare.layerId) continue
      out.push({ layerId: id, date, alpha: layerById(id).credit ? 1 : opacity })
    }
    return out
  }, [base, date, overlays, opacity, compare, sharpOn, sharp.pass, sharp.fill, screening.data, screening.loss, hazardLayers, change.status, showChange, suscMode])

  // Markers: photo locations on the Street tab, events/earthquakes on the News tab.
  const markers = useMemo<Marker[]>(() => {
    if (place && (tab === 'street' || streetOpen) && street.data) {
      return street.data.items.slice(0, 150).map((i) => ({
        id: `s:${i.provider}:${i.id}`, lat: i.lat, lon: i.lon, size: streetOpen?.id === i.id ? 13 : 7,
        color: streetOpen?.id === i.id ? '#fbbc04' : '#1a73e8',
      }))
    }
    if (place && tab === 'hazards' && prio.data && !hazSel) {
      return prio.data.sites.filter((x) => x.kind === inspectKind).map((x) => ({
        id: `p:${x.id}`, lat: x.lat, lon: x.lon, color: x.kind === 'slope' ? '#c62828' : '#1565c0',
        size: inspectSel === x.id ? 15 : 10, label: x.id,
      }))
    }
    if (place && tab === 'hazards' && hazEvents.data) {
      return hazEvents.data.events.slice(0, 150).map((e, i) => ({
        id: `h:${i}`, lat: e.lat, lon: e.lon, color: HAZARD_COLORS[e.type],
        size: hazSel && hazSel.title === e.title && hazSel.date === e.date ? 14 : 8,
        label: hazSel && hazSel.title === e.title && hazSel.date === e.date ? e.title : undefined,
      }))
    }
    if (place && tab === 'news' && events.data) {
      return [
        ...events.data.natural.map((e, i) => ({ id: `n:${i}`, lat: e.lat, lon: e.lon, color: '#e8710a', size: 11, label: e.title })),
        ...events.data.earthquakes.map((q, i) => ({ id: `q:${i}`, lat: q.lat, lon: q.lon, color: '#d93025', size: 6 + q.magnitude * 1.5, label: `M${q.magnitude}` })),
      ]
    }
    return []
  }, [place, tab, street.data, streetOpen, events.data, hazEvents.data, hazSel, prio.data, inspectKind, inspectSel])

  const onMarker = useCallback((id: string) => {
    const [kind, ...rest] = id.split(':')
    if (kind === 's') {
      const img = street.data?.items.find((i) => i.provider === rest[0] && i.id === rest[1])
      if (img) setStreetOpen(img)
    } else if (kind === 'p') {
      setInspectSel(rest.join(':'))
    } else if (kind === 'h' && hazEvents.data) {
      const e = hazEvents.data.events[+rest[0]]
      if (e) setHazSel(e)
    } else if (kind === 'n' && events.data) {
      const e = events.data.natural[+rest[0]]
      if (e?.url) window.open(e.url, '_blank', 'noopener')
    } else if (kind === 'q' && events.data) {
      const q = events.data.earthquakes[+rest[0]]
      if (q) window.open(q.url, '_blank', 'noopener')
    }
  }, [street.data, events.data, hazEvents.data])

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

  const storyControls: StoryControls = {
    openPlace: () => {
      if (!place || Math.abs(place.lat - 10.84) > 1e-3 || Math.abs(place.lon + 85.62) > 1e-3) {
        openPlace(10.84, -85.62, 'Santa Rosa, Guanacaste', 'Tropical dry forest · Costa Rica', 1, 'Costa Rica')
      }
      const fly = setInterval(() => {
        if (!globe.current) return
        clearInterval(fly)
        globe.current.flyTo(10.84, -85.62, 22_000, -40)
      }, 250)
    },
    showTab: (t) => {
      setTab(t)
      setSheet('half')
    },
    focusEvent: (start) => {
      const i = series?.stats?.events.findIndex((e) => e.start === start) ?? -1
      if (i >= 0) setFocusIndex(i)
    },
    compareEvent: (ev) => {
      showEvent(ev)
      setSheet('peek')
    },
    endCompare: () => setCompare((c) => ({ ...c, on: false })),
  }

  return (
    <div className={`app ${place ? `with-card sheet-${sheet}` : ''} ${pegman ? 'pegman-mode' : ''}`}>
      <Suspense fallback={<div className="globe-loading"><span className="spinner" aria-hidden /> Loading the globe…</div>}>
      <Globe ref={globe} layers={stack} splitActive={compare.on} pin={pin} markers={markers} terrain={terrain}
        onPick={onPick} onMarker={onMarker} onCursor={cursorBus.set} onView={viewBus.set} />
      </Suspense>

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
          sheet={sheet} onSheet={setSheet} extras={extras}
          hazards={(
            <HazardsPanel data={screening.data} loading={screening.loading} error={screening.error} retry={screening.retry}
              loss={screening.loss} lat={place.lat} lon={place.lon}
              suscMode={suscMode} onSuscMode={setSuscMode}
              showSusc={hazardLayers.susc} onShowSusc={(on) => {
                setHazardLayers((h) => ({ ...h, susc: on }))
                const b = screening.data?.susceptibility.bounds
                if (on && b) globe.current?.flyToBounds(b.south, b.north, b.west, b.east)
              }}
              showLoss={hazardLayers.loss} onShowLoss={(on) => setHazardLayers((h) => ({ ...h, loss: on }))}
              onFly={(lat, lon) => { setHazardLayers((h) => ({ ...h, loss: true })); globe.current?.flyTo(lat, lon, 3500, -50) }}
              onRunLoss={() => { screening.runLoss().catch((e: Error) => setNotice(`Couldn't start: ${e.message}`)) }}
              inspect={(
                <InspectionList data={prio.data} loading={prio.loading} error={prio.error} place={place.name ?? fmtLatLon(place.lat, place.lon)}
                  kind={inspectKind} onKind={(k) => { setInspectKind(k); setInspectSel(null) }}
                  selected={inspectSel}
                  onSelect={(x) => {
                    setInspectSel(x.id)
                    setHazSel(null)
                    globe.current?.flyTo(x.lat, x.lon, 2500, -50)
                  }} />
              )}
              natural={(
                <NaturalHazards data={hazEvents.data} loading={hazEvents.loading} error={hazEvents.error}
                  around={hazAround} onAround={setHazAround} date={date}
                  selected={hazSel} onSelect={setHazSel} change={change} showChange={showChange} onShowChange={setShowChange}
                  onFly={(lat, lon) => globe.current?.flyTo(lat, lon, 30_000, -45)}
                  onGoTo={(e) => {
                    setDate(e.date)
                    const layer = suggestedLayer(e)
                    if (layer) setOverlays((o) => (o.includes(layer) ? o : [...o, layer]))
                    setNotice(`Showing ${e.date}${layer ? ` with ${layerById(layer).title}` : ''}.`)
                  }}
                  onBeforeAfter={(e) => {
                    const layer = e.type === 'flood' && e.date >= '2021-01-04' ? 'flood-modis' : e.date >= '2012-01-20' ? 'viirs-truecolor' : 'modis-truecolor'
                    setCompare({ on: true, layerId: layer, a: shiftDate(e.date, -7), b: shiftDate(e.date, e.type === 'flood' ? 2 : 5) })
                    setSheet('peek')
                    globe.current?.flyTo(e.lat, e.lon, e.type === 'cyclone' ? 900_000 : 120_000, -60)
                  }} />
              )} />
          )}
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

      {sharpOn && <SharpChip view={viewBus} date={date} pass={sharp.pass} passes={sharp.passes} loading={sharp.loading} onChoose={sharp.choose} />}

      <LayersPanel base={base} overlays={overlays} opacity={opacity} sharp={sharpOn} onSharp={setSharpOn} extras={extras} onExtras={toggleExtras} onBase={setBase} onOpacity={setOpacity}
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

      <button className="tour-btn" onClick={() => { dismissInvite(); setStoryOn(true) }} title="Follow a guided example" aria-label="Guided example">
        <Icon name="school" size={18} /> Guided example
      </button>

      {invite && !storyOn && (
        <div className="invite" role="note">
          <span>New here? See how EarthOS spotted Santa Rosa's late rainy season in 2026.</span>
          <button className="btn primary" onClick={() => { dismissInvite(); setStoryOn(true) }}>Show me</button>
          <button className="icon-btn" onClick={dismissInvite} aria-label="Dismiss">✕</button>
        </div>
      )}
      {storyOn && <Story series={series} loading={loading} controls={storyControls} onClose={() => setStoryOn(false)} />}

      <Suspense fallback={null}>
        {streetOpen && street.data && (
          <StreetView origin={{ lat: place?.lat ?? streetOpen.lat, lon: place?.lon ?? streetOpen.lon }} images={street.data.items} start={streetOpen} attribution={street.data.attribution}
            onChange={setStreetOpen} onClose={() => setStreetOpen(null)} />
        )}
        {showLicences && <Licences onClose={() => setShowLicences(false)} />}
        {report && place && (
          <ReportView html={report} onDownload={() => downloadReportHtml(place, report)} onClose={() => setReport(null)} />
        )}
      </Suspense>
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
      <ScreeningFooter />
      <button className="link" onClick={onLicences}><span className="wide-only">Data sources &amp; licences</span><span className="narrow-only">Sources</span></button>
    </footer>
  )
}

/** The GIBS layer that best shows an event's aftermath on its day, if any. */
function suggestedLayer(e: HazardEvent): string | null {
  if (e.type === 'flood') return e.date >= '2021-01-04' ? 'flood-modis' : null
  if (e.type === 'wildfire') return 'fires'
  if (['tornado', 'cyclone', 'storm', 'landslide', 'earthquake'].includes(e.type) && e.date >= '2023-01-01') return 'dist-alert'
  return null
}
