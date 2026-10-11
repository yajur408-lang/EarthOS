import { useState } from 'react'
import type { ChangeStatus, HazardEvent, HazardEvents, HazardType } from '../api'
import { HAZARD_COLORS } from '../hazardColors'
import { prettyDate } from '../util'

const ICON: Record<HazardType, string> = {
  cyclone: '🌀', tornado: '🌪', earthquake: '〰', wildfire: '🔥', volcano: '🌋', flood: '🌊', landslide: '⛰', storm: '⛈', drought: '☀',
}

interface Props {
  data: HazardEvents | null
  loading: boolean
  error: string | null
  around: boolean
  onAround: (on: boolean) => void
  date: string
  selected: HazardEvent | null
  onSelect: (e: HazardEvent | null) => void
  change: { status: ChangeStatus | null; loading: boolean; run: () => void }
  showChange: boolean
  onShowChange: (on: boolean) => void
  onGoTo: (e: HazardEvent) => void
  onBeforeAfter: (e: HazardEvent) => void
  onFly: (lat: number, lon: number) => void
}

export default function NaturalHazards(p: Props) {
  const [filter, setFilter] = useState<HazardType | 'all'>('all')
  const events = (p.data?.events ?? []).filter((e) => filter === 'all' || e.type === filter)
  return (
    <section className="hz">
      <h3>Natural hazards near here <small>cyclones, tornadoes, earthquakes, fires, volcanoes, floods, storms, landslides</small></h3>
      <div className="seg" role="group" aria-label="Period">
        <button className={!p.around ? 'on' : ''} onClick={() => p.onAround(false)}>All years</button>
        <button className={p.around ? 'on' : ''} onClick={() => p.onAround(true)}>Around {prettyDate(p.date)}</button>
      </div>
      {p.loading && <p className="hint">Searching NOAA, USGS and NASA catalogues…</p>}
      {p.error && <div className="alert soft">Hazard catalogues unavailable: {p.error}</div>}
      {p.data && (
        <>
          <div className="chips">
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All {p.data.events.length}</button>
            {(Object.entries(p.data.counts) as [HazardType, number][]).map(([t, n]) => (
              <button key={t} className={filter === t ? 'on' : ''} onClick={() => setFilter(t)}>
                <span aria-hidden>{ICON[t]}</span> {n}
              </button>
            ))}
          </div>
          {events.length === 0 && <p>No events of this kind in the catalogues for this period. That doesn't mean none happened.</p>}
          <ul className="hz-events">
            {events.slice(0, 60).map((e, i) => {
              const on = p.selected && p.selected.title === e.title && p.selected.date === e.date
              return (
                <li key={`${e.type}${e.date}${i}`} className={on ? 'on' : ''}>
                  <button className="hz-ev-head" onClick={() => p.onSelect(on ? null : e)} aria-expanded={!!on}>
                    <span className="hz-dot" style={{ background: HAZARD_COLORS[e.type] }} aria-hidden>{ICON[e.type]}</span>
                    <span>
                      <b>{e.title}</b>
                      <small>{prettyDate(e.date)} · {e.type_name} · {e.distance_km} km away</small>
                    </span>
                  </button>
                  {on && <EventDetail e={e} {...p} />}
                </li>
              )
            })}
          </ul>
          {events.length > 60 && <p className="hint">Showing the 60 most recent of {events.length}.</p>}
          {p.data.errors.map((x) => <p key={x} className="hint">{x}</p>)}
          <details className="method">
            <summary>Coverage and sources</summary>
            <ul>{p.data.coverage.map((c) => <li key={c}>{c}</li>)}</ul>
            <ul className="sources">
              {Object.values(p.data.sources).map((s) => (
                <li key={s.name}>{s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a> : s.name}{s.citation ? ` · ${s.citation}` : ''}</li>
              ))}
            </ul>
            <p>Search radius: cyclones {p.data.radius_km.cyclone} km, earthquakes {p.data.radius_km.earthquake} km, other events {p.data.radius_km.eonet} km, tornadoes {p.data.radius_km.tornado} km, landslides {p.data.radius_km.landslide} km.</p>
          </details>
        </>
      )}
    </section>
  )
}

function EventDetail({ e, change, showChange, onShowChange, onGoTo, onBeforeAfter, onFly }: Props & { e: HazardEvent }) {
  const st = change.status
  return (
    <div className="hz-ev-body">
      <p>{e.detail}{e.link ? <> · <a href={e.link} target="_blank" rel="noopener noreferrer">source</a></> : null}</p>
      <div className="hz-actions">
        <button className="btn" onClick={() => onGoTo(e)}>Show that day on the map</button>
        <button className="btn" onClick={() => onBeforeAfter(e)}>Before / after</button>
        <button className="btn" onClick={() => onFly(e.lat, e.lon)}>Fly to closest point</button>
      </div>
      {e.satellite_check ? (
        <div className="change-box">
          <b>30 m satellite check: {e.satellite_check}</b>
          {(!st || st.status === 'not_started') && (
            <>
              <button className="btn primary" onClick={change.run} disabled={change.loading}>Compare 30 m imagery before and after</button>
              <small>Reads NASA HLS scenes from the weeks before and after; takes a few minutes, then the result is kept.</small>
            </>
          )}
          {(st?.status === 'running' || st?.status === 'queued') && (
            <div className="loss-progress">
              <span>{st.status === 'queued' ? 'Waiting for another satellite run…' : `Reading scenes… ${Math.round(st.progress * 100)}%`}</span>
              <div className="bar"><i style={{ width: `${Math.max(3, (st.status === 'running' ? st.progress : 0) * 100)}%` }} /></div>
            </div>
          )}
          {(st?.status === 'unavailable' || st?.status === 'error' || st?.status === 'busy') && (
            <div className="alert soft">{st.error}{st.status === 'error' && <> <button className="link" onClick={change.run}>Try again</button></>}</div>
          )}
          {st?.status === 'done' && (
            <>
              <p className="loss-meta">
                {st.index_name ?? st.index}: clear views {prettyDate(st.before_window[0])} – {prettyDate(st.before_window[1])} ({st.scenes.before} scenes)
                vs {prettyDate(st.after_window[0])} – {prettyDate(st.after_window[1])} ({st.scenes.after} scenes).
              </p>
              {st.note && <div className="alert soft">{st.note}</div>}
              {!st.note && (st.patches.length === 0
                ? <p>No patches of 0.5 ha or more passed the thresholds in this area. Cloud, timing or small damage can hide real change.</p>
                : (
                  <>
                    <p><b>{st.patches.length} patch{st.patches.length === 1 ? '' : 'es'}, {st.flagged_ha} ha</b> - {st.label}.</p>
                    <ul className="patches">
                      {st.patches.slice(0, 8).map((pt) => (
                        <li key={pt.id}>
                          <button onClick={() => { onShowChange(true); onFly(pt.lat, pt.lon) }}>
                            <b>{pt.area_ha} ha</b>
                            <span>{st.index} {pt.before.toFixed(2)} → {pt.after.toFixed(2)} ({pt.robust_z}σ)</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ))}
              {st.has_overlay && (
                <label className="toggle">
                  <input type="checkbox" checked={showChange} onChange={(ev) => onShowChange(ev.target.checked)} />
                  <span>Show on the map</span>
                </label>
              )}
              <details className="method">
                <summary>Method</summary>
                <p>{st.method}</p>
                <p>{st.qa}</p>
                <p>{st.source.name} · {st.source.citation}</p>
              </details>
            </>
          )}
        </div>
      ) : (
        <p className="hint">{e.date < '2013-06-01' ? 'Before the 30 m HLS record (2013), so no satellite check.' : 'No satellite check suits this kind of event.'}</p>
      )}
    </div>
  )
}
