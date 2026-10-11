import { useState } from 'react'
import { api, type Backtest as BT, type Priority, type TriggerRule } from '../api'
import { linkProps, navigate } from '../router'
import { useFetch } from '../useFetch'
import { prettyDate } from '../util'
import PageShell from './PageShell'

const SANTA_ANA = { lat: 9.915, lon: -84.19 }
const LABEL: Record<string, string> = { fc24: 'rain that day', fc72: '3-day rain', ante7: 'previous 7 days', soil: 'soil wetness' }
const ruleText = (r: TriggerRule) =>
  Object.entries(r).map(([k, v]) => `${LABEL[k] ?? k} ≥ ${k === 'soil' ? v : `${v} mm`}`).join(' and ')
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`)
const ci = (c: [number, number] | null | undefined) => (c ? ` (95% CI ${pct(c[0])}–${pct(c[1])})` : '')

function readParams() {
  const q = new URLSearchParams(location.search)
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'))
  return Number.isFinite(lat) && Number.isFinite(lon) && q.get('lat') ? { lat, lon } : SANTA_ANA
}

export default function Backtest() {
  const [at, setAt] = useState(readParams)
  const [form, setForm] = useState({ lat: String(at.lat), lon: String(at.lon) })
  const res = useFetch<BT>(`${at.lat},${at.lon}`, (s) => api.backtest(at.lat, at.lon, s))
  const prio = useFetch<Priority>(`${at.lat},${at.lon}`, (s) => api.priority(at.lat, at.lon, s))
  const v = prio.data?.validation
  const isPilot = Math.abs(at.lat - SANTA_ANA.lat) < 0.03 && Math.abs(at.lon - SANTA_ANA.lon) < 0.03
  const d = res.data

  return (
    <PageShell>
      <article className="doc wide">
        <h1>Backtest: rainfall trigger vs past landslides</h1>
        <p className="lead">
          {isPilot ? 'Santa Ana, Costa Rica (pilot area). ' : ''}How often would the Elevated- and High-rainfall rules have been active when
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
            {d.calibrated === false && (
              <p className="uncalibrated"><b>Uncalibrated here.</b> These thresholds were set for the Santa Ana pilot. The scores below show how
                they would have done at this place, but no thresholds were chosen or checked for its climate.</p>
            )}
            <div className="bt-limits">
              <b>Read this first.</b>
              <ul>
                <li><b>Perfect-forecast hindcast:</b> past days use the rain that actually fell in place of a forecast, so real-world hit rates would be lower.</li>
                <li><b>Coarse rain:</b> NASA POWER rain is a ~50 km average; a local downpour that triggers a slide can be invisible in it.</li>
                <li><b>Few events:</b> {d.scores[0]?.events ?? 0} landslide days. The 95% intervals below are wide, and rates from fewer than {d.min_events_for_rate} events are greyed out.</li>
                <li><b>Incomplete catalogue:</b> only slides that made the news are listed, so "alerts with no catalogued landslide" is an upper bound on false alarms, not a measurement.</li>
              </ul>
            </div>
            <p className="muted">
              Landslides reported within {d.place.radius_km} km, {prettyDate(d.period[0])} – {prettyDate(d.period[1])}; several reports on one day count as one landslide day.
              A hit means the level was active within ±{d.match_days} day{d.match_days === 1 ? '' : 's'} of the reported date.
            </p>
            <div className="bt-scores">
              {d.scores.map((s) => (
                <div key={s.level} className={`bt-score ${s.enough_events ? '' : 'thin'}`}>
                  <h3>{s.level === 'watch' ? 'Elevated or High rainfall' : 'High rainfall only'}</h3>
                  <div className="big">{pct(s.hit_rate)}</div>
                  <p>hit rate: {s.hits} of {s.events} landslide days{ci(s.hit_rate_ci)} · <b>missed {s.misses}</b></p>
                  <div className="big">{pct(s.no_event_alert_rate)}</div>
                  <p>alerts with no catalogued landslide: {s.no_event_alerts} of {s.alert_episodes} alert episodes{ci(s.no_event_alert_rate_ci)}</p>
                  <p>{s.alert_days_per_year} alert days per year on average</p>
                  {!s.enough_events && <p><b>Too few events</b> (fewer than {d.min_events_for_rate}) to read much into this rate.</p>}
                </div>
              ))}
            </div>

            <h2>Compared with chance and a simpler rule</h2>
            <p className="muted">Same number of alert days in each case, so the comparison is fair.</p>
            <div className="bt-table-wrap">
              <table className="bt-table">
                <thead><tr><th>Level</th><th>EarthOS rules</th><th>Random days ({d.baselines.watch?.random?.draws ?? 0} draws)</th><th>Rain-only rule</th></tr></thead>
                <tbody>
                  {d.scores.map((s) => {
                    const b = d.baselines[s.level as 'watch' | 'warning']
                    return (
                      <tr key={s.level}>
                        <td>{s.level === 'watch' ? 'Elevated or High' : 'High only'} ({b?.alert_days ?? 0} alert days)</td>
                        <td className="num">hit rate {pct(s.hit_rate)}{ci(s.hit_rate_ci)}</td>
                        <td className="num">{b?.random ? <>hit rate {pct(b.random.hit_rate_mean)} on average (95% of draws {pct(b.random.hit_rate_95[0])}–{pct(b.random.hit_rate_95[1])}); random days did at least as well in {(b.random.p_at_least_observed * 100).toFixed(1)}% of draws</> : '–'}</td>
                        <td className="num">{b?.rain_only ? <>rain that day ≥ {b.rain_only.threshold_mm} mm: hit rate {pct(b.rain_only.hit_rate)}{ci(b.rain_only.hit_rate_ci)}</> : '–'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted">
              If the rules don't beat the rain-only rule, the extra inputs (3-day rain, antecedent rain, soil wetness) aren't adding skill
              at this resolution; say so rather than claim they do.
            </p>

            {d.blocks.length > 0 && (
              <>
                <h2>Earlier vs later years</h2>
                <p className="muted">{d.split_note}</p>
                <div className="bt-table-wrap">
                  <table className="bt-table">
                    <thead><tr><th>Block</th><th>Level</th><th>Landslide days</th><th>Hit rate (95% CI)</th><th>Alerts with no catalogued landslide</th></tr></thead>
                    <tbody>
                      {d.blocks.flatMap((bl) => bl.scores.map((s) => (
                        <tr key={bl.block + s.level} className={s.enough_events ? '' : 'excluded'}>
                          <td>{bl.block} ({bl.period[0].slice(0, 4)}–{bl.period[1].slice(0, 4)})</td>
                          <td>{s.level === 'watch' ? 'Elevated or High' : 'High only'}</td>
                          <td className="num">{s.events}</td>
                          <td className="num">{s.hits}/{s.events} = {pct(s.hit_rate)}{ci(s.hit_rate_ci)}</td>
                          <td className="num">{s.no_event_alerts}/{s.alert_episodes}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {d.events.length === 0 && <p>No landslides are recorded within {d.place.radius_km} km in the catalogues used, so the rules cannot be scored here.</p>}

            {d.scores[0]?.missed_events.length > 0 && (
              <>
                <h2>Missed events (no Elevated or High level within ±{d.match_days} day{d.match_days === 1 ? '' : 's'})</h2>
                <ul>{d.scores[0].missed_events.map((m) => <li key={m.date + m.title}>{m.date} · {m.title}</li>)}</ul>
                <p className="muted">See the rain columns below: a slide reported on a day with little rain in the ~50 km NASA POWER cell can't be caught by rainfall rules at this resolution.</p>
              </>
            )}

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
                        <td className={scored ? (lvl === 'none' ? 'miss' : 'hit') : ''}>{lvl === 'none' ? 'none' : lvl === 'watch' ? 'Elevated' : lvl === 'warning' ? 'High' : lvl}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <h2>Susceptibility map vs past landslide locations</h2>
            {!v ? <p className="muted">{prio.loading ? 'Checking…' : prio.error ?? ''}</p> : v.events_usable === 0 ? (
              <p>None of the {v.events_in_area} reported landslides inside the screening area has a location accurate to 1 km or better, so the map can't be checked against history here.</p>
            ) : (
              <>
                <p>
                  Of {v.events_usable} located landslides in the {prio.data!.area.half_km * 2} × {prio.data!.area.half_km * 2} km area, <b>{Math.round((v.share_in_high ?? 0) * 100)}%</b> fall within 100 m of a high-susceptibility cell
                  ({Math.round(v.area_share.high * 100)}% of the area is high) and <b>{Math.round((v.share_in_medium_or_high ?? 0) * 100)}%</b> within 100 m of medium or high
                  ({Math.round((v.area_share.high + v.area_share.medium) * 100)}% of the area). {v.excluded_vague_location} more were excluded for vague locations.
                  {v.missed.length ? ` Missed (only 'lower' within 100 m): ${v.missed.map((m) => m.date).join(', ')}.` : ' None fell only in "lower" cells.'}
                </p>
                <p className="muted">{v.caveat}</p>
              </>
            )}

            <h2>Rules tested</h2>
            <ul>
              <li><b>Elevated rainfall</b> if any of: {d.rules.watch.map(ruleText).join('; or ')}</li>
              <li><b>High rainfall</b> if any of: {d.rules.warning.map(ruleText).join('; or ')}</li>
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
