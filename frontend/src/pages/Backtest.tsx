import { useState } from 'react'
import { api, type Backtest as BT, type TriggerRule } from '../api'
import { linkProps, navigate } from '../router'
import { useFetch } from '../useFetch'
import { prettyDate } from '../util'
import PageShell from './PageShell'

const SANTA_ANA = { lat: 9.915, lon: -84.19 }
const LABEL: Record<string, string> = { fc24: 'rain that day', fc72: '3-day rain', ante7: 'previous 7 days', soil: 'soil wetness' }
const ruleText = (r: TriggerRule) =>
  Object.entries(r).map(([k, v]) => `${LABEL[k] ?? k} ≥ ${k === 'soil' ? v : `${v} mm`}`).join(' and ')
const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`)

function readParams() {
  const q = new URLSearchParams(location.search)
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'))
  return Number.isFinite(lat) && Number.isFinite(lon) && q.get('lat') ? { lat, lon } : SANTA_ANA
}

export default function Backtest() {
  const [at, setAt] = useState(readParams)
  const [form, setForm] = useState({ lat: String(at.lat), lon: String(at.lon) })
  const res = useFetch<BT>(`${at.lat},${at.lon}`, (s) => api.backtest(at.lat, at.lon, s))
  const isPilot = Math.abs(at.lat - SANTA_ANA.lat) < 0.03 && Math.abs(at.lon - SANTA_ANA.lon) < 0.03
  const d = res.data

  return (
    <PageShell>
      <article className="doc wide">
        <h1>Backtest: rainfall trigger vs past landslides</h1>
        <p className="lead">
          {isPilot ? 'Santa Ana, Costa Rica (pilot area). ' : ''}How often would the Watch and Warning rules have been active when
          landslides were reported nearby, and how often were they active with no landslide reported?
        </p>
        <form className="bt-form" onSubmit={(e) => {
          e.preventDefault()
          const lat = Number(form.lat), lon = Number(form.lon)
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
          setAt({ lat, lon })
          history.replaceState(null, '', `/backtest?lat=${lat}&lon=${lon}`)
        }}>
          <label>Latitude<input value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} inputMode="decimal" /></label>
          <label>Longitude<input value={form.lon} onChange={(e) => setForm({ ...form, lon: e.target.value })} inputMode="decimal" /></label>
          <button className="btn-lg primary sm" type="submit">Run backtest</button>
          {!isPilot && <button className="btn-lg sm" type="button" onClick={() => { setForm({ lat: String(SANTA_ANA.lat), lon: String(SANTA_ANA.lon) }); setAt(SANTA_ANA); history.replaceState(null, '', '/backtest') }}>Santa Ana</button>}
        </form>

        {res.loading && <p className="muted">Replaying the rules over 20+ years of daily rain…</p>}
        {res.error && <p className="note">Backtest unavailable: {res.error}</p>}
        {d && (
          <>
            <p className="muted">
              Landslides reported within {d.place.radius_km} km, {prettyDate(d.period[0])} – {prettyDate(d.period[1])}.
              A hit means an alert was active within ±{d.match_days} day{d.match_days === 1 ? '' : 's'} of the reported date.
            </p>
            <div className="bt-scores">
              {d.scores.map((s) => (
                <div key={s.level} className="bt-score">
                  <h3>{s.level === 'watch' ? 'Watch or Warning' : 'Warning only'}</h3>
                  <div className="big">{pct(s.hit_rate)}</div>
                  <p>hit rate: {s.hits} of {s.events} rain-triggered landslides</p>
                  <div className="big">{pct(s.false_alarm_rate)}</div>
                  <p>false-alarm rate: {s.false_alarms} of {s.alert_episodes} alert episodes had no reported landslide</p>
                  <p>{s.alert_days_per_year} alert days per year on average</p>
                </div>
              ))}
            </div>
            {d.events.length === 0 && <p>No landslides are recorded within {d.place.radius_km} km in the catalogues used, so the rules cannot be scored here.</p>}

            <h2>Events</h2>
            <div className="bt-table-wrap">
              <table className="bt-table">
                <thead>
                  <tr><th>Date</th><th>Place (as reported)</th><th>Distance</th><th>Trigger</th><th>Rain that day</th><th>Prev. 7 days</th><th>Soil</th><th>Alert</th></tr>
                </thead>
                <tbody>
                  {d.events.map((e, i) => {
                    const inPeriod = e.date >= d.period[0] && e.date <= d.period[1]
                    const scored = e.rain_triggered && inPeriod
                    const lvl = e.level_on_day ?? 'none'
                    return (
                      <tr key={i} className={scored ? '' : 'excluded'}>
                        <td className="num">{e.date}</td>
                        <td>{e.source?.startsWith('http') ? <a href={e.source} target="_blank" rel="noopener noreferrer">{e.title}</a> : e.title}
                          <br /><small className="muted">{e.origin}{e.fatalities && e.fatalities !== '0' ? ` · ${e.fatalities} deaths reported` : ''} · location ±{e.accuracy || '?'}</small></td>
                        <td className="num">{e.distance_km} km</td>
                        <td>{e.trigger || 'unknown'}{scored ? '' : ' (not scored)'}</td>
                        <td className="num">{e.rain_mm != null ? `${e.rain_mm} mm` : '–'}</td>
                        <td className="num">{e.ante7_mm != null ? `${e.ante7_mm} mm` : '–'}</td>
                        <td className="num">{e.soil ?? '–'}</td>
                        <td className={scored ? (lvl === 'none' ? 'miss' : 'hit') : ''}>{lvl === 'none' ? 'none' : lvl === 'watch' ? 'Watch' : 'Warning'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <h2>Rules tested</h2>
            <ul>
              <li><b>Watch</b> if any of: {d.rules.watch.map(ruleText).join('; or ')}</li>
              <li><b>Warning</b> if any of: {d.rules.warning.map(ruleText).join('; or ')}</li>
            </ul>
            <h2>Method</h2>
            <p>{d.method}</p>
            <h2>Read with care</h2>
            <ul>{d.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
            <h2>Sources</h2>
            <ul>
              {d.sources.map((s) => (
                <li key={s.name}>{s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a> : s.name}{s.citation ? ` - ${s.citation}` : ''}{s.use ? ` - ${s.use}` : ''}</li>
              ))}
              <li>Local reports: CNE technical report on the Tapezco landslide, published on the Municipality of Santa Ana open-data portal.</li>
            </ul>
            <p className="muted">{d.notice} Thresholds live in the server's <code>screening.toml</code>; this page always tests the current values.</p>
            <p><a className="btn-lg primary" {...linkProps('/explore')} onClick={(e) => { e.preventDefault(); navigate(`/explore?pilot=santa-ana`) }}>Open Santa Ana on the globe</a></p>
          </>
        )}
      </article>
    </PageShell>
  )
}
