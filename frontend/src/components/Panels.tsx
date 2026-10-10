import { useMemo } from 'react'
import { api, type EventsResult, type Forecast, type TerrainInfo } from '../api'
import { useFetch } from '../useFetch'
import MiniChart from './MiniChart'

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8]

export function TerrainSection({ lat, lon, km }: { lat: number; lon: number; km: number }) {
  const t = useFetch<TerrainInfo>(`${lat},${lon},${km}`, (s) => api.terrain(lat, lon, km, s))
  return (
    <>
      <h3>Terrain</h3>
      {t.loading && <p className="hint">Loading elevation…</p>}
      {t.error && <p className="hint">Elevation unavailable: {t.error}</p>}
      {t.data && (
        <>
          <div className="stats">
            <Stat label="Elevation" value={`${Math.round(t.data.elevation_m).toLocaleString()} m`} sub="at the pin" />
            <Stat label="Slope" value={`${t.data.slope_deg}°`}
              sub={t.data.aspect_deg != null ? `faces ${compass(t.data.aspect_deg)} (${t.data.aspect_deg}°)` : 'flat'} />
            <Stat label="Range in area" value={`${Math.round(t.data.box.min_m)}–${Math.round(t.data.box.max_m)} m`} sub={`relief ${Math.round(t.data.box.relief_m)} m`} />
            <Stat label="Mean elevation in area" value={`${Math.round(t.data.box.mean_m)} m`} sub={`${t.data.pixel_m} m grid`} />
          </div>
          <MiniChart title="Elevation profile (west → east)" subtitle="Through the pin"
            data={[{
              x: t.data.profile.map((p) => p.distance_m / 1000), y: t.data.profile.map((p) => p.elevation_m),
              type: 'scatter', mode: 'lines', fill: 'tozeroy', fillcolor: 'rgba(121,85,72,0.18)', line: { color: '#795548', width: 1.5 },
              name: 'Elevation', hovertemplate: '%{x:.2f} km: %{y:.0f} m<extra></extra>',
            }]}
            layout={{ xaxis: { title: { text: 'km from pin' } }, yaxis: { title: { text: 'm' } }, hovermode: 'closest', margin: { l: 46, r: 8, t: 6, b: 36 } }}
            height={170} source="Terrain Tiles (USGS SRTM/3DEP, GMTED, ETOPO1 and others)" />
        </>
      )}
    </>
  )
}

// MET Norway symbol codes -> emoji (https://github.com/metno/weathericons)
const SYMBOL: [RegExp, string][] = [
  [/thunder/, '⛈️'], [/snow/, '🌨️'], [/sleet/, '🌨️'], [/heavyrain/, '🌧️'], [/rain/, '🌦️'],
  [/fog/, '🌫️'], [/^cloudy/, '☁️'], [/partlycloudy/, '⛅'], [/fair/, '🌤️'], [/clearsky_night/, '🌙'], [/clearsky/, '☀️'],
]
const icon = (s: string | null) => (s ? SYMBOL.find(([re]) => re.test(s))?.[1] ?? '·' : '·')
const label = (s: string | null) => (s ? s.split('_')[0].replace('heavy', 'heavy ').replace('light', 'light ').replace('partly', 'partly ').replace('sky', ' sky') : '')

export function WeatherPanel({ lat, lon }: { lat: number; lon: number }) {
  const w = useFetch<Forecast>(`${lat},${lon}`, (s) => api.weather(lat, lon, s))
  const days = useMemo(() => {
    if (!w.data) return []
    const m = new Map<string, Forecast['hours']>()
    for (const h of w.data.hours) {
      const d = h.time.slice(0, 10)
      m.set(d, [...(m.get(d) ?? []), h])
    }
    return [...m.entries()].map(([d, hs]) => {
      const t = hs.map((h) => h.temp_c).filter((v): v is number => v != null)
      const mid = hs.find((h) => h.time.slice(11, 13) === '12') ?? hs[Math.floor(hs.length / 2)]
      return {
        date: d, min: Math.min(...t), max: Math.max(...t),
        precip: hs.reduce((a, h) => a + (h.precip_mm ?? 0), 0),
        wind: Math.max(...hs.map((h) => h.wind_m_s ?? 0)), symbol: mid.symbol,
      }
    })
  }, [w.data])

  if (w.loading) return <p className="hint">Loading forecast…</p>
  if (w.error) return <div className="alert soft">Forecast unavailable: {w.error} <button className="link" onClick={w.retry}>Retry</button></div>
  if (!w.data) return null
  const now = w.data.hours[0]
  const next48 = w.data.hours.filter((h) => Date.parse(h.time) - Date.parse(now.time) <= 48 * 3600e3)
  const all = w.data.hours
  return (
    <>
      <div className="now">
        <span className="now-icon" aria-hidden>{icon(now.symbol)}</span>
        <div>
          <b>{now.temp_c != null ? `${Math.round(now.temp_c)}°C` : '–'}</b>
          <span>{label(now.symbol)}</span>
        </div>
        <dl>
          <dt>Humidity</dt><dd>{now.humidity_pct != null ? `${Math.round(now.humidity_pct)}%` : '–'}</dd>
          <dt>Wind</dt><dd>{now.wind_m_s != null ? `${now.wind_m_s} m/s ${now.wind_from_deg != null ? compass(now.wind_from_deg) : ''}` : '–'}</dd>
          <dt>Cloud</dt><dd>{now.cloud_pct != null ? `${Math.round(now.cloud_pct)}%` : '–'}</dd>
          <dt>Pressure</dt><dd>{now.pressure_hpa != null ? `${Math.round(now.pressure_hpa)} hPa` : '–'}</dd>
        </dl>
      </div>
      <div className="days">
        {days.slice(0, 9).map((d) => (
          <div key={d.date} className="day">
            <span>{new Date(d.date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}</span>
            <i aria-hidden>{icon(d.symbol)}</i>
            <b>{Math.round(d.max)}°</b>
            <small>{Math.round(d.min)}°</small>
            <em>{d.precip >= 0.1 ? `${d.precip.toFixed(1)} mm` : ''}</em>
          </div>
        ))}
      </div>
      <MiniChart title="Next 48 hours" subtitle="Temperature and precipitation"
        data={[
          { x: next48.map((h) => h.time), y: next48.map((h) => h.temp_c), type: 'scatter', mode: 'lines', name: 'Temperature (°C)', line: { color: '#e8710a', width: 2, shape: 'spline' } },
          { x: next48.map((h) => h.time), y: next48.map((h) => h.precip_mm), type: 'bar', name: 'Precipitation (mm/h)', yaxis: 'y2', marker: { color: '#4285f4' } },
        ]}
        layout={{ xaxis: { type: 'date', tickformat: '%a %Hh' }, yaxis2: { overlaying: 'y', side: 'right', showgrid: false, rangemode: 'tozero' }, margin: { l: 34, r: 30, t: 26, b: 28 } }}
        height={200} />
      <MiniChart title={`Next ${days.length} days`} subtitle="Wind and humidity"
        data={[
          { x: all.map((h) => h.time), y: all.map((h) => h.wind_m_s), type: 'scatter', mode: 'lines', name: 'Wind (m/s)', line: { color: '#4285f4', width: 1.4 } },
          { x: all.map((h) => h.time), y: all.map((h) => h.humidity_pct), type: 'scatter', mode: 'lines', name: 'Humidity (%)', yaxis: 'y2', line: { color: '#12b5cb', width: 1.4 } },
        ]}
        layout={{ xaxis: { type: 'date' }, yaxis2: { overlaying: 'y', side: 'right', showgrid: false, range: [0, 100] }, margin: { l: 34, r: 30, t: 26, b: 28 } }}
        height={180} />
      <p className="hint">Forecast updated {new Date(w.data.updated).toLocaleString()}. {w.data.attribution}.</p>
    </>
  )
}

export function NewsPanel({ data, loading, error, retry, onFly }: {
  data: EventsResult | null
  loading: boolean
  error: string | null
  retry: () => void
  onFly: (lat: number, lon: number) => void
}) {
  if (loading) return <p className="hint">Loading nearby events…</p>
  if (error) return <div className="alert soft">Unavailable: {error} <button className="link" onClick={retry}>Retry</button></div>
  if (!data) return null
  return (
    <>
      <p className="hint first">Context only: listed by date and distance. EarthOS doesn't link these to the vegetation data.</p>

      <h3>Natural events within 500 km <small>past year · NASA EONET</small></h3>
      {data.errors.natural && <p className="hint">Unavailable right now.</p>}
      {!data.natural.length && !data.errors.natural && <p className="hint">None recorded.</p>}
      <ul className="feed">
        {data.natural.slice(0, 12).map((e) => (
          <li key={e.title + e.date}>
            <button className="feed-dot orange" onClick={() => onFly(e.lat, e.lon)} title="Show on globe" aria-label={`Show ${e.title} on globe`} />
            <div>
              <a href={e.url ?? undefined} target="_blank" rel="noreferrer">{e.title}</a>
              <span>{e.category} · {e.first_date}{e.closed ? ` – ${e.closed}` : ' (ongoing)'} · {e.distance_km} km away</span>
            </div>
          </li>
        ))}
      </ul>

      <h3>Earthquakes M3+ within 300 km <small>past year · USGS</small></h3>
      {data.errors.earthquakes && <p className="hint">Unavailable right now.</p>}
      {!data.earthquakes.length && !data.errors.earthquakes && <p className="hint">None recorded.</p>}
      <ul className="feed">
        {data.earthquakes.slice(0, 8).map((q) => (
          <li key={q.url}>
            <button className="feed-dot red" onClick={() => onFly(q.lat, q.lon)} title="Show on globe" aria-label={`Show ${q.title} on globe`} />
            <div>
              <a href={q.url} target="_blank" rel="noreferrer">{q.title}</a>
              <span>{q.date} · depth {Math.round(q.depth_km)} km · {q.distance_km} km away</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="hint">{data.attribution}</p>
    </>
  )
}

export function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'red' | 'amber' | 'blue' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  )
}
