// Turning what EarthOS shows into files people can keep, share or open elsewhere.
import { api, type EventsResult, type ExtraKind, type Series, type StreetNearby } from './api'
import { SOURCES } from './licences'
import { loadPlotly } from './plotly'
import { fmtLatLon } from './util'

export interface ExportPlace {
  lat: number
  lon: number
  km: number
  name: string | null
  label: string | null
  country: string | null
}

const slug = (p: ExportPlace) =>
  `earthos_${(p.name ?? 'pin').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}_${p.lat.toFixed(3)}_${p.lon.toFixed(3)}`

export function downloadBlob(filename: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

const CITATION = 'Sources: NASA MODIS MOD13Q1 v061 (doi:10.5067/MODIS/MOD13Q1.061) via ORNL DAAC; NASA LaRC POWER Project. See EarthOS "Data sources & licences" for all attributions.'

/** One wide CSV: 16-day NDVI rows with their statistics, then daily weather rows. Opens directly in Excel / Sheets. */
export function exportCsv(place: ExportPlace, series: Series) {
  const v = (x: unknown) => (x == null ? '' : String(x))
  const stats = new Map(series.stats?.series.map((p) => [p.date, p]))
  const climCols = Object.keys(series.climate.points[0] ?? {}).filter((k) => k !== 'date')
  const rows = [['dataset', 'date', 'ndvi', 'usable_fraction', 'ndvi_seasonal_median', 'ndvi_sigma', 'ndvi_z',
    'flag_below', 'flag_above', 'flag_threshold', ...climCols].join(',')]
  for (const p of series.ndvi.points) {
    const s = stats.get(p.date)
    rows.push(['MOD13Q1', p.date, v(p.ndvi), v(p.usable_fraction), v(s?.ndvi_expected), v(s?.ndvi_sigma), v(s?.ndvi_z),
      v(s?.flag_below), v(s?.flag_above), v(s?.flag_threshold), ...climCols.map(() => '')].join(','))
  }
  for (const p of series.climate.points) {
    rows.push(['POWER', p.date, '', '', '', '', '', '', '', '', ...climCols.map((c) => v((p as unknown as Record<string, unknown>)[c]))].join(','))
  }
  rows.push('', `# ${place.name ?? 'Dropped pin'} ${fmtLatLon(place.lat, place.lon)}; area half-width ${place.km} km`, `# ${CITATION}`)
  downloadBlob(`${slug(place)}.csv`, new Blob([rows.join('\n')], { type: 'text/csv' }))
}

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))])

/** Everything EarthOS knows about the place, in one JSON file (good for Python / R / sharing with a colleague). */
export async function exportJson(place: ExportPlace, series: Series | null, street: StreetNearby | null, events: EventsResult | null) {
  const q = series?.query
  const range = { lat: place.lat, lon: place.lon, km: place.km, start_year: q?.start_year ?? new Date().getUTCFullYear() - 9, end_year: q?.end_year ?? new Date().getUTCFullYear() }
  const extraKinds: ExtraKind[] = ['evi', 'lst', 'burned', 'landcover']
  const settled = await Promise.allSettled([
    withTimeout(api.terrain(place.lat, place.lon, place.km), 20_000),
    withTimeout(api.weather(place.lat, place.lon), 20_000),
    // Extra MODIS products are usually cached once the Charts tab has been opened; don't wait long otherwise.
    ...extraKinds.map((k) => withTimeout(api.extra(k, range), 15_000)),
  ])
  const val = (i: number) => (settled[i].status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<unknown>).value : { unavailable: String((settled[i] as PromiseRejectedResult).reason) })
  const bundle = {
    generated: new Date().toISOString(),
    generator: 'EarthOS',
    place,
    note: 'Measurements and statistics as published by each source; EarthOS draws no conclusions.',
    ndvi_and_climate: series,
    terrain: val(0),
    forecast: val(1),
    evi: val(2), land_surface_temperature: val(3), burned_area: val(4), land_cover: val(5),
    street_level_photos: street,
    nearby_events_and_news: events,
    sources: SOURCES.filter((s) => s.status === 'in use').map(({ name, licence, attribution, link }) => ({ name, licence, attribution, link })),
  }
  downloadBlob(`${slug(place)}.json`, new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
}

/** Pin, averaging box, events and photo locations as GeoJSON (opens in QGIS, ArcGIS, geojson.io, Google Earth Pro). */
export function exportGeoJson(place: ExportPlace, street: StreetNearby | null, events: EventsResult | null) {
  const dLat = place.km / 111.32
  const dLon = place.km / (111.32 * Math.max(Math.cos((place.lat * Math.PI) / 180), 0.02))
  const point = (lon: number, lat: number, properties: Record<string, unknown>) =>
    ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties })
  const features: unknown[] = [
    point(place.lon, place.lat, { kind: 'pin', name: place.name, label: place.label }),
  ]
  if (place.km > 0) {
    const [w, e, s, n] = [place.lon - dLon, place.lon + dLon, place.lat - dLat, place.lat + dLat]
    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      properties: { kind: 'ndvi_averaging_area', half_width_km: place.km } })
  }
  for (const ev of events?.natural ?? []) features.push(point(ev.lon, ev.lat, { kind: 'natural_event', ...ev }))
  for (const q of events?.earthquakes ?? []) features.push(point(q.lon, q.lat, { kind: 'earthquake', ...q }))
  for (const i of street?.items ?? []) features.push(point(i.lon, i.lat, { kind: 'street_photo', provider: i.provider, captured: i.captured, url: i.page, licence: 'CC BY-SA 4.0' }))
  const fc = { type: 'FeatureCollection', features }
  downloadBlob(`${slug(place)}.geojson`, new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' }))
}

export function exportPng(place: ExportPlace | null, dataUrl: string) {
  fetch(dataUrl).then((r) => r.blob()).then((b) => downloadBlob(`${place ? slug(place) : 'earthos_view'}_map.png`, b))
}

/** Every chart currently on screen as PNG files. */
export async function exportChartImages(place: ExportPlace) {
  const Plotly = await loadPlotly()
  const charts = [...document.querySelectorAll<HTMLElement>('.mini')]
  let n = 0
  for (const card of charts) {
    const el = card.querySelector<HTMLElement>('.js-plotly-plot')
    if (!el || !el.getBoundingClientRect().height) continue
    const title = card.querySelector('h4')?.textContent ?? `chart-${n}`
    const url = await Plotly.toImage(el as unknown as Plotly.PlotlyHTMLElement, { format: 'png', width: 1200, height: Math.max(500, el.clientHeight * 2), scale: 1 })
    const b = await (await fetch(url)).blob()
    downloadBlob(`${slug(place)}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`, b)
    n++
  }
  return n
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** A printable one-page report as a standalone HTML document (shown in-app; Save as PDF via print). */
export async function buildReport(place: ExportPlace, series: Series | null, mapImage: string | null): Promise<string> {
  const [terrain, weather] = await Promise.allSettled([api.terrain(place.lat, place.lon, place.km), api.weather(place.lat, place.lon)])
  const Plotly = await loadPlotly()
  const chart = async (data: Plotly.Data[], title: string, ytitle: string) => {
    const div = document.createElement('div')
    div.style.cssText = 'position:fixed;left:-9999px;width:900px;height:300px'
    document.body.appendChild(div)
    await Plotly.newPlot(div, data, {
      title: { text: title, font: { size: 14 } }, width: 900, height: 300, margin: { l: 50, r: 10, t: 40, b: 30 },
      showlegend: data.length > 1, legend: { orientation: 'h', y: -0.15 }, yaxis: { title: { text: ytitle } }, font: { family: 'Arial', size: 11 },
    }, { staticPlot: true })
    const url = await Plotly.toImage(div as unknown as Plotly.PlotlyHTMLElement, { format: 'png', width: 900, height: 300 })
    Plotly.purge(div)
    div.remove()
    return url
  }

  const imgs: string[] = []
  const st = series?.stats?.series ?? []
  if (series && st.length) {
    imgs.push(await chart([
      { x: st.map((p) => p.date), y: st.map((p) => p.ndvi_expected), type: 'scatter', mode: 'lines', name: 'Seasonal median', line: { color: '#888', dash: 'dot' } },
      { x: series.ndvi.points.map((p) => p.date), y: series.ndvi.points.map((p) => p.ndvi), type: 'scatter', mode: 'lines', name: 'NDVI', line: { color: '#188038' } },
      { x: st.filter((p) => p.flag_below).map((p) => p.date), y: st.filter((p) => p.flag_below).map((p) => p.ndvi), type: 'scatter', mode: 'markers', name: 'Below normal', marker: { color: '#d93025' } },
    ], 'Vegetation (NDVI, 16-day, 250 m)', 'NDVI'))
  }
  if (series?.climate.points.length) {
    const m = new Map<string, { p: number; t: number[]; n: number }>()
    for (const d of series.climate.points) {
      const k = d.date.slice(0, 7) + '-15'
      const g = m.get(k) ?? { p: 0, t: [], n: 0 }
      g.p += d.precip_mm ?? 0
      if (d.tmax_c != null) g.t.push(d.tmax_c)
      g.n++
      m.set(k, g)
    }
    const xs = [...m.keys()]
    imgs.push(await chart([
      { x: xs, y: xs.map((k) => m.get(k)!.p), type: 'bar', name: 'Rain (mm/month)', marker: { color: '#4285f4' } },
      { x: xs, y: xs.map((k) => { const t = m.get(k)!.t; return t.length ? t.reduce((a, b) => a + b, 0) / t.length : null }), type: 'scatter', mode: 'lines', name: 'Max temp (°C, monthly mean)', yaxis: 'y2', line: { color: '#e8710a' } },
    ], 'Rainfall and temperature (NASA POWER)', 'mm'))
  }

  const t = terrain.status === 'fulfilled' ? terrain.value : null
  const now = weather.status === 'fulfilled' ? weather.value.hours[0] : null
  const m = series?.stats?.methods
  const events = series?.stats?.events.slice(0, 8) ?? []
  const used = SOURCES.filter((s) => s.status === 'in use')

  return `<!doctype html><html><head><meta charset="utf-8"><title>EarthOS report - ${esc(place.name ?? 'Dropped pin')}</title>
<style>
  body { font: 13px/1.45 Arial, sans-serif; color: #202124; max-width: 900px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 2px; } h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .muted { color: #5f6368; } table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  img { max-width: 100%; } .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .grid div { background: #f1f3f4; border-radius: 8px; padding: 8px 10px; } .grid b { display: block; font-size: 18px; font-weight: 500; }
  @media print { body { margin: 0; } h2 { break-after: avoid; } img { break-inside: avoid; } }
</style></head><body>
<h1>${esc(place.name ?? 'Dropped pin')}</h1>
<div class="muted">${esc(place.label ?? '')}<br>${esc(fmtLatLon(place.lat, place.lon))} · area ${place.km === 0 ? 'single 250 m pixel' : `${(2 * place.km + 0.25).toFixed(1)} km square`} · generated ${esc(new Date().toLocaleString())}</div>
${mapImage ? `<h2>Map view</h2><img src="${mapImage}" alt="Map view">` : ''}
<h2>At a glance</h2>
<div class="grid">
  <div>Elevation<b>${t ? `${Math.round(t.elevation_m)} m` : '–'}</b></div>
  <div>Slope<b>${t ? `${t.slope_deg}°` : '–'}</b></div>
  <div>Weather now<b>${now?.temp_c != null ? `${Math.round(now.temp_c)} °C` : '–'}</b>${esc(now?.symbol?.split('_')[0] ?? '')}</div>
  <div>Seasonal flags<b>${m ? `${m.seasonal_below_flags} below / ${m.seasonal_above_flags} above` : '–'}</b>${m ? `of ${m.composites_evaluated} composites` : ''}</div>
</div>
${imgs.map((src) => `<img src="${src}" alt="">`).join('')}
${events.length ? `<h2>Largest NDVI anomalies (statistics only)</h2><table><tr><th>Dates</th><th>Direction</th><th>Peak z</th><th>Mean NDVI vs median</th><th>Rain vs median</th></tr>
${events.map((e) => `<tr><td>${esc(e.start)}${e.end !== e.start ? ` – ${esc(e.end)}` : ''}</td><td>${e.direction}</td><td>${e.peak_z.toFixed(1)}</td><td>${e.mean_ndvi.toFixed(3)} vs ${e.mean_expected.toFixed(3)}</td><td>${e.precip_pct_vs_median == null ? '–' : `${e.precip_pct_vs_median > 0 ? '+' : ''}${e.precip_pct_vs_median.toFixed(0)}%`}</td></tr>`).join('')}</table>` : ''}
<h2>Method</h2><ul>${(series?.stats?.method_notes ?? []).map((n) => `<li>${esc(n)}</li>`).join('')}<li>EarthOS reports measurements and statistics; it does not attribute causes.</li></ul>
<h2>Sources and attribution</h2><table>${used.map((s) => `<tr><td><b>${esc(s.name)}</b><br><span class="muted">${esc(s.licence)}</span></td><td>${esc(s.attribution)}</td></tr>`).join('')}</table>
</body></html>`
}

export function downloadReportHtml(place: ExportPlace, html: string) {
  downloadBlob(`${slug(place)}_report.html`, new Blob([html], { type: 'text/html' }))
}

// ---------- share links & saved places ----------

export interface ViewLink {
  lat: number
  lon: number
  km: number
  date?: string
  base?: string
  tab?: string
}

export function shareUrl(v: ViewLink) {
  const p = new URLSearchParams({ lat: v.lat.toFixed(5), lon: v.lon.toFixed(5), km: String(v.km) })
  if (v.date) p.set('date', v.date)
  if (v.base) p.set('base', v.base)
  if (v.tab) p.set('tab', v.tab)
  return `${location.origin}${location.pathname}#${p}`
}

export function readShareUrl(): ViewLink | null {
  const p = new URLSearchParams(location.hash.slice(1))
  const lat = Number(p.get('lat')), lon = Number(p.get('lon'))
  if (!p.has('lat') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const km = Math.min(Math.max(Number(p.get('km') ?? 1) || 0, 0), 5)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p.get('date') ?? '') ? p.get('date')! : undefined
  return { lat, lon, km, date, base: p.get('base') ?? undefined, tab: p.get('tab') ?? undefined }
}

export interface SavedPlace {
  lat: number
  lon: number
  km: number
  name: string
  label: string | null
  country: string | null
  saved: string
}

const SAVED_KEY = 'earthos.saved.v1'

export function loadSaved(): SavedPlace[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function storeSaved(list: SavedPlace[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list))
  } catch {
    /* private mode / storage full: saving is best-effort */
  }
}

export function exportSavedPlaces(list: SavedPlace[]) {
  const fc = { type: 'FeatureCollection', features: list.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: s })) }
  downloadBlob('earthos_saved_places.geojson', new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' }))
}
