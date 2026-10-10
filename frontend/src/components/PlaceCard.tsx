import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { api, type AnomalyEvent, type ExplainResult, type EventsResult, type Series, type StreetImage, type StreetNearby } from '../api'
import { fmt, fmtLatLon, prettyDate } from '../util'
import Icon from './Icon'
import { useFetch } from '../useFetch'
import { NewsPanel, Stat, TerrainSection, WeatherPanel } from './Panels'

const Dashboard = lazy(() => import('./Dashboard'))

export interface PlaceInfo {
  lat: number
  lon: number
  km: number
  name: string | null
  label: string | null
  country: string | null
}

export interface Options {
  start: number
  end: number
  z: number
  drop: number
}

export type CardTab = 'overview' | 'charts' | 'anomalies' | 'street' | 'weather' | 'news'

const TABS: { id: CardTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'charts', label: 'Charts' },
  { id: 'anomalies', label: 'Anomalies' },
  { id: 'street', label: 'Street' },
  // Optional context, hidden unless "Show weather & nearby events" is on in Layers.
  { id: 'weather', label: 'Weather' },
  { id: 'news', label: 'Events' },
]

interface Fetched<T> {
  data: T | null
  loading: boolean
  error: string | null
  retry: () => void
}

interface Props {
  place: PlaceInfo
  tab: CardTab
  onTab: (t: CardTab) => void
  series: Series | null
  loading: boolean
  error: string | null
  street: Fetched<StreetNearby>
  events: Fetched<EventsResult>
  date: string
  compare: { a: string; b: string }
  options: Options
  thisYear: number
  focus: number | null
  onFocus: (i: number | null) => void
  onOptions: (o: Options, km: number) => void
  onDate: (d: string) => void
  onZoomTo: () => void
  onShowEvent: (ev: AnomalyEvent) => void
  onOpenStreet: (img: StreetImage) => void
  onFly: (lat: number, lon: number) => void
  saved: boolean
  onToggleSave: () => void
  onShare: () => Promise<boolean>
  onExport: (kind: ExportKind) => Promise<void>
  onClose: () => void
  /** Show the optional weather and nearby-events tabs. */
  extras: boolean
  /** Phone layout: how far the bottom sheet is pulled up. */
  sheet: Sheet
  onSheet: (s: Sheet) => void
}

export type Sheet = 'peek' | 'half' | 'full'

export type ExportKind = 'csv' | 'json' | 'geojson' | 'png' | 'charts' | 'report'

const EXPORTS: { kind: ExportKind; title: string; detail: string; needsSeries?: boolean }[] = [
  { kind: 'csv', title: 'Spreadsheet (.csv)', detail: 'NDVI, statistics and daily weather; opens in Excel or Google Sheets', needsSeries: true },
  { kind: 'json', title: 'Full data bundle (.json)', detail: 'Everything for this place, including terrain, forecast, events and sources' },
  { kind: 'geojson', title: 'Map features (.geojson)', detail: 'Pin, area, events and photo spots for QGIS, ArcGIS or Google Earth Pro' },
  { kind: 'png', title: 'Map image (.png)', detail: 'The current globe view, with credits' },
  { kind: 'charts', title: 'Chart images (.png)', detail: 'Every chart on the Charts tab', needsSeries: true },
  { kind: 'report', title: 'Report (PDF)', detail: 'A printable summary with map, charts and sources', needsSeries: true },
]

export default function PlaceCard(props: Props) {
  const { place, tab, onTab, series, loading, error, date, compare, focus, onFocus, onDate, onZoomTo, onShowEvent, onClose } = props
  const [shared, setShared] = useState(false)
  const stats = series?.stats ?? null
  const focused = stats && focus != null ? stats.events[focus] : null
  const needsSeries = tab === 'overview' || tab === 'charts' || tab === 'anomalies'

  // Raw readings nearest the globe date and NDVI statistics at compare dates A/B - lookups only.
  const near = useMemo(() => {
    if (!series) return null
    const t = Date.parse(date)
    const nearest = <T extends { date: string }>(pts: T[], at: number, ok: (p: T) => boolean) =>
      pts.filter(ok).reduce<T | null>((b, p) => (!b || Math.abs(Date.parse(p.date) - at) < Math.abs(Date.parse(b.date) - at) ? p : b), null)
    const st = stats?.series ?? []
    return {
      ndvi: nearest(st, t, (p) => p.ndvi != null),
      climate: nearest(series.climate.points, t, (p) => p.precip_mm != null || p.tmax_c != null),
      a: nearest(st, Date.parse(compare.a), (p) => p.ndvi != null),
      b: nearest(st, Date.parse(compare.b), (p) => p.ndvi != null),
    }
  }, [series, stats, date, compare.a, compare.b])

  const share = async () => {
    if (await props.onShare()) {
      setShared(true)
      setTimeout(() => setShared(false), 1800)
    }
  }

  const nearestStreet = props.street.data?.items[0]

  // Drag the sheet (phones): follow the finger, then snap to the nearest of peek / half / full.
  const cardRef = useRef<HTMLElement>(null)
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null)
  const snapHeights = () => {
    const vh = window.innerHeight
    return { peek: 176, half: Math.round(vh * 0.55), full: vh - 72 }
  }
  const dragHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (!window.matchMedia('(max-width: 760px)').matches || (e.target as HTMLElement).closest('button')) return
      drag.current = { y: e.clientY, h: cardRef.current?.getBoundingClientRect().height ?? 0, moved: false }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current
      const card = cardRef.current
      if (!d || !card) return
      const dy = d.y - e.clientY
      if (Math.abs(dy) > 6) d.moved = true
      card.style.transition = 'none'
      card.style.height = `${Math.min(Math.max(d.h + dy, 120), window.innerHeight - 64)}px`
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = drag.current
      const card = cardRef.current
      drag.current = null
      if (!d || !card) return
      card.style.transition = ''
      card.style.height = ''
      const snaps = snapHeights()
      if (!d.moved) {
        // A tap on the handle or the title toggles between peek and half, like Google Maps.
        if ((e.target as HTMLElement).closest('.sheet-handle, .card-head')) props.onSheet(props.sheet === 'peek' ? 'half' : 'peek')
        return
      }
      const h = d.h + (d.y - e.clientY)
      const best = (Object.entries(snaps) as [Sheet, number][]).reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))
      props.onSheet(best[0])
    },
  }

  return (
    <aside className="card" aria-label="Place details" ref={cardRef}>
      <div className="sheet-handle" {...dragHandlers} role="button" tabIndex={0} aria-label={props.sheet === 'peek' ? 'Expand details' : 'Collapse details'}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && props.onSheet(props.sheet === 'peek' ? 'half' : 'peek')}>
        <span />
      </div>
      <header className="card-head" {...dragHandlers}>
        <div>
          <h2>{place.name ?? 'Dropped pin'}</h2>
          <p>{place.label ?? fmtLatLon(place.lat, place.lon)}</p>
          {place.label && <p className="coords">{fmtLatLon(place.lat, place.lon)}</p>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>

      <div className="actions">
        <button onClick={onZoomTo}><span><Icon name="zoomTo" /></span>Fly here</button>
        <button onClick={() => (nearestStreet ? props.onOpenStreet(nearestStreet) : onTab('street'))} disabled={props.street.loading && !nearestStreet}>
          <span><Icon name="street" /></span>Street level
        </button>
        <button onClick={props.onToggleSave} aria-pressed={props.saved} className={props.saved ? 'saved' : ''}>
          <span><Icon name={props.saved ? 'starFilled' : 'star'} /></span>{props.saved ? 'Saved' : 'Save'}
        </button>
        <button onClick={share}><span><Icon name="share" /></span>{shared ? 'Link copied' : 'Share'}</button>
        <DownloadMenu hasSeries={!!series} onExport={props.onExport} />
      </div>

      <nav className="card-tabs" role="tablist">
        {TABS.filter((t) => props.extras || (t.id !== 'weather' && t.id !== 'news')).map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => { onTab(t.id); if (props.sheet === 'peek') props.onSheet('half') }}>
            {t.label}
            {t.id === 'anomalies' && stats ? <em>{stats.events.length}</em> : null}
          </button>
        ))}
      </nav>

      <div className="card-body">
        {needsSeries && loading && (
          <div className="loading">
            <span className="spinner" aria-hidden />
            <div>
              {series ? (
                <>
                  <strong>Showing the last {series.query.end_year - series.query.start_year + 1} years…</strong>
                  <span>Still loading the full {props.options.end - props.options.start + 1}-year record, which the seasonal normal range and anomaly statistics need.</span>
                </>
              ) : (
                <>
                  <strong>Fetching satellite record…</strong>
                  <span>NASA's MODIS service is slow on a first visit, so recent data appears first and the full record follows. Later visits are instant.</span>
                </>
              )}
            </div>
          </div>
        )}
        {needsSeries && error && <div className="alert">{error}</div>}
        {needsSeries && series?.ndvi.error && <div className="alert soft">NDVI: {series.ndvi.error}</div>}
        {needsSeries && series?.climate.error && <div className="alert soft">Climate: {series.climate.error}</div>}
        {needsSeries && !loading && stats?.warnings.map((w) => <div key={w} className="alert soft">{w}</div>)}

        {tab === 'overview' && (
          <>
            {series && near && (
              <>
                <h3>Readings near {prettyDate(date)}</h3>
                <div className="stats">
                  <Stat label="NDVI" value={near.ndvi?.ndvi?.toFixed(3) ?? '–'}
                    sub={near.ndvi ? `composite ${near.ndvi.date} · median ${fmt(near.ndvi.ndvi_expected, 3, false)}` : undefined} />
                  <Stat label="vs normal for the season" value={fmtZ(near.ndvi?.ndvi_z)} sub="z-score; the same weeks in other years" />
                  <Stat label="Rain" value={near.climate?.precip_mm != null ? `${near.climate.precip_mm} mm` : '–'} sub={near.climate?.date} />
                  <Stat label="Air temperature" value={near.climate?.tmax_c != null ? `${near.climate.tmin_c ?? '–'} – ${near.climate.tmax_c} °C` : '–'} sub="daily min – max" />
                  <Stat label="Humidity" value={near.climate?.humidity_pct != null ? `${Math.round(near.climate.humidity_pct)}%` : '–'} />
                  <Stat label="Sunlight" value={near.climate?.solar_kwh_m2 != null ? `${near.climate.solar_kwh_m2} kWh/m²` : '–'}
                    sub={near.climate?.cloud_pct != null ? `cloud ${Math.round(near.climate.cloud_pct)}%` : undefined} />
                </div>
                {near.a && near.b && (
                  <>
                    <h3>Compare dates A and B</h3>
                    <div className="stats">
                      <Stat label={`A · ${near.a.date}`} value={near.a.ndvi!.toFixed(3)} sub={`z ${fmt(near.a.ndvi_z, 1)}`} />
                      <Stat label={`B · ${near.b.date}`} value={near.b.ndvi!.toFixed(3)} sub={`z ${fmt(near.b.ndvi_z, 1)}`} />
                      <Stat label="NDVI change (B − A)" value={fmt(near.b.ndvi! - near.a.ndvi!, 3)} />
                      <Stat label="z change (B − A)" value={near.a.ndvi_z != null && near.b.ndvi_z != null ? fmt(near.b.ndvi_z - near.a.ndvi_z, 1) : '–'} />
                    </div>
                  </>
                )}
              </>
            )}
            <TerrainSection lat={place.lat} lon={place.lon} km={place.km} />
            {stats && (
              <button className="link-row" onClick={() => onTab('anomalies')}>
                {stats.methods.seasonal_below_flags + stats.methods.seasonal_above_flags} composites outside the seasonal normal range
                · {stats.events.length} events <Icon name="chevronRight" size={18} />
              </button>
            )}
            {series && <SourceNotes series={series} />}
          </>
        )}

        {tab === 'charts' && series && (
          <>
            <Suspense fallback={<p className="hint">Loading charts…</p>}>
              <Dashboard series={series} km={place.km} focus={focused} cursorDate={date} onDate={onDate} />
            </Suspense>
            <OptionsForm {...props} />
          </>
        )}

        {tab === 'anomalies' && series && stats && (
          <>
            <h3>Unusual periods <small>most trustworthy first</small></h3>
            {stats.events.length === 0 && (
              <p className="empty">Nothing outside the normal range for the season in this period (|z| ≥ {series.query.z} and at least {stats.params.min_deviation} NDVI).</p>
            )}
            {stats.events.map((ev, i) => (
              <EventCard key={ev.direction + ev.start} ev={ev} open={focus === i} query={series.query}
                onToggle={() => onFocus(focus === i ? null : i)} onShow={() => onShowEvent(ev)}
                onChart={() => { onFocus(i); onTab('charts') }} antecedent={stats.params.antecedent_days} />
            ))}
            <details className="method">
              <summary>Compare with a simple threshold alarm</summary>
              <div className="stats">
                <Stat label="Seasonal flags (EarthOS)" value={stats.methods.seasonal_below_flags + stats.methods.seasonal_above_flags} tone="blue"
                  sub={`of ${stats.methods.composites_evaluated} trusted composites`} />
                <Stat label="Threshold alarms" value={stats.methods.threshold_flags} tone="amber" sub={`any NDVI drop ≥ ${series.query.drop}`} />
                <Stat label="Threshold alarms inside the normal range" value={stats.methods.threshold_flags_within_1_5_sigma}
                  sub="ordinary seasonal browning a simple alarm would report" />
                <Stat label="Composites excluded for cloud" value={stats.methods.composites_excluded_quality} sub="shown faintly on charts, never flagged" />
              </div>
            </details>
            <OptionsForm {...props} />
            <details className="method">
              <summary>How these numbers are calculated</summary>
              <ul>{stats.method_notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </details>
          </>
        )}

        {tab === 'street' && <StreetList {...props} />}
        {tab === 'weather' && <WeatherPanel lat={place.lat} lon={place.lon} />}
        {tab === 'news' && (
          <NewsPanel data={props.events.data} loading={props.events.loading} error={props.events.error}
            retry={props.events.retry} onFly={props.onFly} />
        )}
      </div>
    </aside>
  )
}

function StreetList({ street, onOpenStreet }: Props) {
  const [sort, setSort] = useState<'distance' | 'newest' | 'oldest'>('distance')
  if (street.loading) return <p className="hint">Searching for street-level photos…</p>
  if (street.error) return <div className="alert soft">Street imagery unavailable: {street.error} <button className="link" onClick={street.retry}>Retry</button></div>
  if (!street.data) return null
  const items = [...street.data.items].sort((a, b) =>
    sort === 'distance' ? a.distance_m - b.distance_m : sort === 'newest' ? b.captured.localeCompare(a.captured) : a.captured.localeCompare(b.captured))
  const dates = new Set(street.data.items.map((i) => i.captured.slice(0, 4)))
  return (
    <>
      {!items.length && (
        <div className="empty-block">
          <p><b>No street-level photos within 600 m.</b></p>
          <p className="hint">Coverage comes from volunteers, so it is densest along roads in cities. Try a pin on a road, or another town.</p>
          {!street.data.providers.mapillary && (
            <p className="hint">Tip: adding a free Mapillary token (<code>MAPILLARY_TOKEN</code> in <code>backend/.env</code>) adds Mapillary's much larger coverage.</p>
          )}
        </div>
      )}
      {items.length > 0 && (
        <>
          <div className="street-summary">
            <span>{items.length} photos · {dates.size} year{dates.size === 1 ? '' : 's'} ({[...dates].sort()[0]}–{[...dates].sort().at(-1)})</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort photos">
              <option value="distance">Nearest</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
          </div>
          <div className="street-grid">
            {items.slice(0, 60).map((i) => (
              <button key={i.provider + i.id} onClick={() => onOpenStreet(i)} title={`${i.captured} · ${Math.round(i.distance_m)} m`}>
                <img src={api.streetImageUrl(i, 'thumb')} alt="" loading="lazy" />
                <span>{i.captured.slice(0, 7)}{i.pano ? ' · 360°' : ''}</span>
              </button>
            ))}
          </div>
          {!street.data.providers.mapillary && (
            <p className="hint">Showing KartaView. Add a free Mapillary token to <code>backend/.env</code> for more coverage.</p>
          )}
        </>
      )}
      <p className="hint">{street.data.attribution}. Blue dots on the globe mark photo locations.</p>
    </>
  )
}

function OptionsForm({ place, options, thisYear, loading, onOptions }: Props) {
  const [o, setO] = useState(options)
  const [km, setKm] = useState(place.km)
  const dirty = JSON.stringify(o) !== JSON.stringify(options) || km !== place.km
  const years = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
  return (
    <details className="options">
      <summary>Options</summary>
      <div className="grid2">
        <label>From
          <select value={o.start} onChange={(e) => setO({ ...o, start: +e.target.value })}>
            {years(2000, o.end).map((y) => <option key={y}>{y}</option>)}
          </select>
        </label>
        <label>To
          <select value={o.end} onChange={(e) => setO({ ...o, end: +e.target.value })}>
            {years(o.start, thisYear).map((y) => <option key={y}>{y}</option>)}
          </select>
        </label>
        <label>Seasonal flag at |z| ≥
          <input type="number" min={0.5} max={5} step={0.5} value={o.z} onChange={(e) => setO({ ...o, z: +e.target.value })} />
        </label>
        <label>Threshold drop ≥
          <input type="number" min={0.02} max={0.5} step={0.01} value={o.drop} onChange={(e) => setO({ ...o, drop: +e.target.value })} />
        </label>
      </div>
      <label className="slider">
        Area averaged: {km === 0 ? 'single 250 m pixel' : `${(2 * km + 0.25).toFixed(1)} km square`}
        <input type="range" min={0} max={5} step={1} value={km} onChange={(e) => setKm(+e.target.value)} />
      </label>
      <button className="btn primary" disabled={!dirty || loading} onClick={() => onOptions(o, km)}>Apply</button>
    </details>
  )
}

/** z-scores beyond ±4 aren't meaningful as exact numbers; say "beyond 4σ" instead. */
function fmtZ(z: number | null | undefined) {
  if (z == null) return '–'
  if (Math.abs(z) > 4) return z < 0 ? 'beyond −4σ' : 'beyond +4σ'
  return `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}σ`
}

const LEVEL_LABEL = { supported: 'Supported', possible: 'Possible', 'not supported': 'Not supported' } as const

function EventCard({ ev, open, query, onToggle, onShow, onChart, antecedent }: {
  ev: AnomalyEvent
  open: boolean
  query: Series['query']
  onToggle: () => void
  onShow: () => void
  onChart: () => void
  antecedent: number
}) {
  // When opened, re-check the event with burned-area and land-cover data (slower datasets, fetched on demand).
  const key = open ? `${query.lat},${query.lon},${query.km},${query.start_year},${query.end_year},${ev.start},${ev.direction}` : null
  const extra = useFetch<ExplainResult>(key, (s) => api.explain({
    lat: query.lat, lon: query.lon, km: query.km, start_year: query.start_year, end_year: query.end_year,
    event_start: ev.start, direction: ev.direction,
  }, s))
  const x = extra.data?.event.explanation ?? ev.explanation
  const after = ev.within_1sigma_within_3_composites
  return (
    <article className={`event ${open ? 'open' : ''}`}>
      <button className="event-head" onClick={onToggle} aria-expanded={open}>
        <span className={`dot ${ev.direction}`} aria-hidden />
        <div>
          <strong>{prettyDate(ev.start)}{ev.end !== ev.start ? ` – ${prettyDate(ev.end)}` : ''}</strong>
          <span>
            {ev.direction === 'below' ? 'Below' : 'Above'} normal · NDVI {fmt(ev.mean_difference, 2)} · {fmtZ(ev.peak_z)}
          </span>
        </div>
        {x && <em className={`conf ${x.confidence}`}>{x.confidence} confidence</em>}
      </button>
      {open && (
        <div className="event-body">
          {x && <p className="summary">{x.summary}</p>}

          <h4>Is it real? <small>data-quality checks</small></h4>
          <ul className="checks">
            {(ev.checks ?? []).map((c) => (
              <li key={c.check} className={c.status}>
                <span aria-hidden>{c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✕'}</span>
                <div><b>{c.check}</b> {c.detail}</div>
              </li>
            ))}
          </ul>

          <h4>What could explain it? <small>{extra.loading ? 'checking fire and land-cover data…' : 'evidence from independent data'}</small></h4>
          <ul className="drivers">
            {(x?.drivers ?? []).map((d) => (
              <li key={d.id} className={d.level.replace(' ', '-')}>
                <div className="driver-head"><b>{d.title}</b><em>{LEVEL_LABEL[d.level]}</em></div>
                {d.for.length > 0 && <p><span>For:</span> {d.for.join('; ')}</p>}
                {d.against.length > 0 && <p><span>Against:</span> {d.against.join('; ')}</p>}
                <small>{d.sources.join(' · ')}</small>
              </li>
            ))}
          </ul>
          {extra.data?.notes.map((n) => <p key={n} className="hint">{n}</p>)}
          {x && <p className="hint caveat">{x.caveat}</p>}

          <details className="method">
            <summary>The numbers</summary>
            <dl className="facts">
              <dt>Mean NDVI</dt>
              <dd>{ev.mean_ndvi.toFixed(3)} (normal {ev.mean_expected.toFixed(3)}, difference {fmt(ev.mean_difference, 3)})</dd>
              <dt>Good pixels</dt><dd>{Math.round((ev.good_fraction ?? 0) * 100)}% rated good by MODIS QA</dd>
              <dt>Rainfall</dt>
              <dd>
                {ev.precip_pct_vs_median != null ? `${fmt(ev.precip_pct_vs_median, 0)}% vs usual` : '–'}
                {ev.prior_precip_pct != null ? `; month before ${fmt(ev.prior_precip_pct, 0)}%` : ''} (window includes {antecedent} prior days)
              </dd>
              <dt>Max temp</dt><dd>{ev.tmax_z != null ? `${fmtZ(ev.tmax_z)} vs the same weeks in other years` : '–'}</dd>
              <dt>Back to normal</dt>
              <dd>{after == null ? 'no later data' : after ? 'yes, within 3 composites' : 'no, not within 3 composites'}</dd>
            </dl>
          </details>
          <div className="row">
            <button className="btn" onClick={onShow}><Icon name="compare" size={18} /> Compare on map</button>
            <button className="btn" onClick={onChart}>Show on charts</button>
          </div>
        </div>
      )}
    </article>
  )
}

function SourceNotes({ series }: { series: Series }) {
  return (
    <details className="method">
      <summary>About this data</summary>
      <ul>
        <li>{series.ndvi.note} Averaged over {series.ndvi.pixels_per_composite} pixels per composite.</li>
        <li>Weather variables are daily NASA POWER values for the ~50 km grid cell containing the point.</li>
        {Object.entries(series.datasets).map(([id, d]) => (
          <li key={id}>
            <b>{id}</b>: {d.name}. {d.provider}.{' '}
            <a href={d.doi ? `https://doi.org/${d.doi}` : d.url} target="_blank" rel="noreferrer">{d.doi ? `doi:${d.doi}` : d.url}</a>
          </li>
        ))}
      </ul>
    </details>
  )
}

function DownloadMenu({ hasSeries, onExport }: { hasSeries: boolean; onExport: (k: ExportKind) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportKind | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', down)
    return () => window.removeEventListener('pointerdown', down)
  }, [])
  const run = async (k: ExportKind) => {
    setBusy(k)
    setMsg(null)
    try {
      await onExport(k)
      setOpen(false)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="download" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}><span><Icon name="download" /></span>Download</button>
      {open && (
        <div className="download-menu" role="menu">
          <h4>Save as a file</h4>
          {EXPORTS.map((x) => (
            <button key={x.kind} role="menuitem" disabled={!!busy || (x.needsSeries && !hasSeries)} onClick={() => run(x.kind)}>
              <b>{busy === x.kind ? 'Preparing…' : x.title}</b>
              <small>{x.needsSeries && !hasSeries ? 'Available once the satellite record has loaded' : x.detail}</small>
            </button>
          ))}
          {msg && <p className="download-msg">{msg}</p>}
          <p className="download-msg">Files keep each source's credit line. Data stays under its original licence.</p>
        </div>
      )}
    </div>
  )
}
