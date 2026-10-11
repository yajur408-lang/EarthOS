import type { LossResult, LossStatus, Screening, SourceRef, SuscClass, SuscMode, Trigger, TriggerRule } from '../api'
import { linkProps } from '../router'
import { prettyDate } from '../util'

interface Props {
  data: Screening | null
  loading: boolean
  error: string | null
  retry: () => void
  loss: LossStatus | null
  showSusc: boolean
  onShowSusc: (on: boolean) => void
  suscMode: SuscMode
  onSuscMode: (m: SuscMode) => void
  showLoss: boolean
  onShowLoss: (on: boolean) => void
  onFly: (lat: number, lon: number) => void
  onRunLoss: () => void
  /** "Natural hazards near here" (built by the app, which owns the map). */
  natural?: React.ReactNode
  /** "Where to inspect first" (built by the app). */
  inspect?: React.ReactNode
  lat: number
  lon: number
}

const CLASS_LABEL: Record<SuscClass | 'unassessed', string> = {
  unassessed: 'Unassessed: drainage could not be traced here (not "lower")',
  lower: 'Lower susceptibility, not safe',
  medium: 'Medium susceptibility',
  high: 'High susceptibility',
}
// Display names avoid "Watch"/"Warning", the words official services use (config keys stay watch/warning).
const LEVEL_NAME = { watch: 'Elevated rainfall', warning: 'High rainfall' } as const
const LEVEL_TEXT = {
  none: { title: 'No rainfall trigger', detail: 'None of the Elevated-rainfall rules are met right now.' },
  watch: { title: 'Elevated rainfall', detail: 'Rain amounts meet the Elevated-rainfall rules below.' },
  warning: { title: 'High rainfall', detail: 'Rain amounts meet the High-rainfall rules below.' },
  unavailable: { title: 'Could not be evaluated', detail: 'Some inputs are missing, so this is not a "no trigger" result.' },
}
const INPUT_LABEL_LIVE: Record<keyof Trigger['inputs'], string> = {
  fc24: 'forecast next 24 h',
  fc72: 'forecast next 72 h',
  ante7: 'observed last 7 days',
  soil: 'root-zone soil wetness',
}
const INPUT_LABEL_PAST: Record<keyof Trigger['inputs'], string> = {
  fc24: 'rain on the day',
  fc72: 'rain over 3 days from the day',
  ante7: 'rain in the 7 days before',
  soil: 'root-zone soil wetness',
}
const unit = (k: string, v: number) => (k === 'soil' ? v.toFixed(2) : `${v} mm`)
const pct = (v: number) => `${Math.round(v * 100)}%`

export default function HazardsPanel(p: Props) {
  if (p.loading) {
    return (
      <div className="loading">
        <span className="spinner" aria-hidden />
        <div>
          <strong>Building the screening layers…</strong>
          <span>Terrain, drainage and land cover for this area (a few seconds the first time, instant after that).</span>
        </div>
      </div>
    )
  }
  if (p.error || !p.data) {
    return <div className="alert">Screening unavailable: {p.error ?? 'no data'} <button className="link" onClick={p.retry}>Retry</button></div>
  }
  const d = p.data
  return (
    <div className="hazards">
      <Notice d={d} />
      <p className="hz-date">Screening for <b>{prettyDate(d.date)}</b> · change the day with the date bar</p>
      {p.inspect}
      <TriggerSection t={d.trigger} lat={p.lat} lon={p.lon} />
      {p.natural}
      <SusceptibilitySection d={d} show={p.showSusc} onShow={p.onShowSusc} mode={p.suscMode} onMode={p.onSuscMode} />
      <LossSection loss={p.loss} show={p.showLoss} onShow={p.onShowLoss} onFly={p.onFly} onRun={p.onRunLoss} />
    </div>
  )
}

function Notice({ d }: { d: Screening }) {
  return (
    <details className="screen-notice" role="note">
      <summary><strong>{d.notice}</strong> <span>Official alerts ▾</span></summary>
      <span>For warnings and evacuation orders, always follow:</span>
      <ul>
        {d.official.map((o) => <li key={o.url}><a href={o.url} target="_blank" rel="noopener noreferrer">{o.name}</a></li>)}
      </ul>
    </details>
  )
}

function ruleText(r: TriggerRule, labels: Record<keyof Trigger['inputs'], string>) {
  return (Object.entries(r) as [keyof Trigger['inputs'], number][]).map(([k, v]) => `${labels[k]} ≥ ${unit(k, v)}`).join(' and ')
}

function TriggerSection({ t, lat, lon }: { t: Trigger; lat: number; lon: number }) {
  if (t.error) return <section className="hz"><h3>Rainfall trigger</h3><div className="alert soft">{t.error}</div></section>
  const fired = new Set(t.fired.map((r) => JSON.stringify(r)))
  const lv = LEVEL_TEXT[t.level]
  const past = t.mode === 'reconstructed'
  const INPUT_LABEL = past ? INPUT_LABEL_PAST : INPUT_LABEL_LIVE
  return (
    <section className="hz">
      <h3>Rainfall trigger <small>{past ? 'reconstructed from observed rain' : 'live forecast'}</small></h3>
      {t.available === false ? (
        <div className="trigger-badge unavailable"><b>Not available for this day yet</b><span>Observed rain for this day isn't published yet.</span></div>
      ) : (
        <div className={`trigger-badge ${t.level}`}>
          <b>{lv.title}{past ? ' (reconstructed)' : ''}</b>
          <span>{past ? lv.detail.replace('right now', 'on this day').replace('meet', 'met') : lv.detail}</span>
          {t.level === 'unavailable' && t.missing_inputs?.length ? (
            <span>Missing: {t.missing_inputs.map((k) => INPUT_LABEL[k]).join(', ')}{t.missing_inputs.some((k) => k === 'fc24' || k === 'fc72') ? ' (forecast service unavailable)' : ''}.</span>
          ) : null}
          {t.level === 'watch' && t.incomplete ? <span>High-rainfall rules couldn't all be checked (missing: {t.missing_inputs?.map((k) => INPUT_LABEL[k]).join(', ')}).</span> : null}
        </div>
      )}
      <p className="not-official">Screening tool, not an official warning. For warnings follow the CNE and IMN (or your national service). These thresholds are not official criteria.</p>
      {t.calibrated === false && (
        <p className="uncalibrated"><b>Uncalibrated here.</b> The mm thresholds were set for the Santa Ana pilot; how much rain triggers slides differs by climate, soil and slope, so read this as a rough guide only.</p>
      )}
      <dl className="facts">
        {(Object.keys(INPUT_LABEL) as (keyof Trigger['inputs'])[]).map((k) => (
          <div key={k}>
            <dt>{INPUT_LABEL[k][0].toUpperCase() + INPUT_LABEL[k].slice(1)}</dt>
            <dd>{t.inputs[k] == null ? 'unavailable' : unit(k, t.inputs[k]!)}
              {k === 'ante7' && t.windows.observed_from ? <small> ({prettyDate(t.windows.observed_from)} – {prettyDate(t.windows.observed_to!)})</small> : null}
            </dd>
          </div>
        ))}
      </dl>
      {(['watch', 'warning'] as const).map((lvl) => (
        <div key={lvl} className="rules">
          <h4>{LEVEL_NAME[lvl]} if any of:</h4>
          <ul>
            {t.rules[lvl].map((r) => {
              const on = t.level === lvl && fired.has(JSON.stringify(r))
              return <li key={JSON.stringify(r)} className={on ? 'on' : ''}><span aria-hidden>{on ? '●' : '○'}</span>{ruleText(r, INPUT_LABEL)}</li>
            })}
          </ul>
        </div>
      ))}
      {t.notes.map((n) => <p key={n} className="hint">{n}</p>)}
      {t.errors.map((e) => <p key={e} className="hint">{e}</p>)}
      <a className="link-row" {...linkProps(`/backtest?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`)}>
        How did these thresholds do on past landslides here? Open the backtest →
      </a>
      <Sources list={t.sources} method="Thresholds are set in the server's screening.toml and checked on the Backtest page." />
    </section>
  )
}

const LEGEND: Record<SuscMode, string> = {
  combined: 'larger of the two: faint yellow lower · orange medium · red high · grey unassessed · paler = uncertain · blue = drainage lines',
  landslide: 'slope + land cover only: faint yellow lower · orange medium · red high · paler = uncertain',
  flood: 'height above drainage only: pale blue lower · blue medium · dark blue high · grey unknown · paler = uncertain',
}

function SusceptibilitySection({ d, show, onShow, mode, onMode }: { d: Screening; show: boolean; onShow: (on: boolean) => void; mode: SuscMode; onMode: (m: SuscMode) => void }) {
  const s = d.susceptibility
  if (s.error) return <section className="hz"><h3>Susceptibility</h3><div className="alert soft">{s.error}</div></section>
  const at = s.at_point
  return (
    <section className="hz">
      <h3>Susceptibility <small>{(d.area.half_km * 2).toFixed(0)} × {(d.area.half_km * 2).toFixed(0)} km around here, {Math.round(s.cell_m)} m cells</small></h3>
      {at && (
        <div className={`susc-point ${at.class}`}>
          <b>At the pin: {CLASS_LABEL[at.class]}</b>
          {at.uncertain && (
            <span>Uncertain: within typical data error this could be {at.range[0] === at.range[1] ? at.range[0] : `${at.range[0]} to ${at.range[1]}`}.</span>
          )}
          {at.landslide_class && (
            <span>Landslide: <b>{at.landslide_class}</b> · Flood: <b>{at.flood_class}</b>{at.driver ? ` · combined class driven by ${at.driver}` : ''}</span>
          )}
          <span>Slope {at.slope_deg}° · {at.hand_m == null ? 'drains out of the area before a drainage line' : `${at.hand_m} m above the nearest drainage line`} · {at.land_cover}</span>
        </div>
      )}
      <div className="susc-bars" aria-label="Share of the area in each class">
        {(['high', 'medium', 'lower'] as SuscClass[]).map((c) => {
          const x = s.summary.classes[c]
          return (
            <div key={c} className="susc-row">
              <span>{c === 'lower' ? 'Lower (not safe)' : c[0].toUpperCase() + c.slice(1)}</span>
              <div className="bar"><i className={c} style={{ width: pct(x.share) }}><em style={{ width: x.share ? `${(x.uncertain_share / x.share) * 100}%` : 0 }} /></i></div>
              <b>{pct(x.share)}</b>
            </div>
          )
        })}
        <p className="hint">Hatched part of each bar: cells whose class could change within typical data error ({pct(s.summary.uncertain_share)} of the area).</p>
        {(s.summary.unassessed_share ?? 0) > 0 && (
          <p className="hint">Unassessed (grey on the map): {pct(s.summary.unassessed_share!)} of the area, where water leaves the box before reaching a drainage line, so flood susceptibility is unknown.</p>
        )}
      </div>
      <div className="seg" role="group" aria-label="Which hazard">
        {(['combined', 'landslide', 'flood'] as SuscMode[]).map((m) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => { onMode(m); onShow(true) }}>
            {m === 'combined' ? 'Combined' : m === 'landslide' ? 'Landslide' : 'Flood'}
            {d.susceptibility.summary.by_hazard && m !== 'combined' ? ` · ${Math.round((d.susceptibility.summary.by_hazard[m].high) * 100)}% high` : ''}
          </button>
        ))}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={show} onChange={(e) => onShow(e.target.checked)} />
        <span>Show on the map <small>{LEGEND[mode]}</small></span>
      </label>
      <Sources list={s.sources} method={s.method} limits={s.limits} />
    </section>
  )
}

function LossSection({ loss, show, onShow, onFly, onRun }: { loss: LossStatus | null; show: boolean; onShow: (on: boolean) => void; onFly: (lat: number, lon: number) => void; onRun: () => void }) {
  const head = <h3>Slope forest-loss watch <small>30 m NASA HLS, slopes over 15°</small></h3>
  if (!loss) return <section className="hz">{head}</section>
  const result: (LossResult & { end?: string }) | null = loss.status === 'done' ? loss : loss.previous ?? null
  return (
    <section className="hz">
      {head}
      {loss.status === 'not_started' && (
        <div className="loss-progress">
          <span>Not yet computed for the 90 days up to {loss.end ? prettyDate(loss.end) : 'this day'}.</span>
          <button className="btn primary" onClick={onRun}>Run the forest-loss watch for this date</button>
          <small>Reads a few hundred NASA HLS scenes; takes several minutes, then the result is kept for everyone.</small>
        </div>
      )}
      {loss.status === 'error' && <button className="btn" onClick={onRun}>Try again</button>}
      {loss.status === 'queued' && <p className="hint">Waiting for another forest-loss run to finish…</p>}
      {loss.status === 'running' && (
        <div className="loss-progress">
          <span>Reading NASA HLS scenes for this area… {Math.round(loss.progress * 100)}%</span>
          <div className="bar"><i style={{ width: `${Math.max(3, loss.progress * 100)}%` }} /></div>
          <small>A first run reads a few hundred satellite scenes and can take several minutes; the result is then kept.</small>
        </div>
      )}
      {(loss.status === 'unavailable' || loss.status === 'error' || loss.status === 'busy') && <div className="alert soft">{loss.error}</div>}
      {result && (
        <>
          {loss.status !== 'done' && <p className="hint">Showing the last finished run (to {prettyDate(result.recent_window[1])}).</p>}
          <p className="loss-meta">
            Recent clear views {prettyDate(result.recent_window[0])} – {prettyDate(result.recent_window[1])} compared with the same
            weeks in <b>{result.n_baseline_years} baseline year{result.n_baseline_years === 1 ? '' : 's'}</b>
            {result.baseline_years_used.length ? ` (${result.baseline_years_used.join(', ')})` : ''}.
            {' '}{result.scenes.recent} recent and {result.scenes.baseline} baseline scenes used.
          </p>
          <p className="hint">Cloud mask: {result.qa}</p>
          {result.judged_steep_share != null && (
            <p className="hint">{pct(result.judged_steep_share)} of the steep ground had enough clear views to be judged; the rest is not assessed.</p>
          )}
          {result.note && <div className="alert soft">{result.note}</div>}
          {result.patches.length === 0 ? (
            <p>No patches met the thresholds ({result.thresholds ? `≥ ${result.thresholds.min_patch_ha} ha, NDVI drop ≥ ${result.thresholds.ndvi_drop}` : 'see Methods'}). That is not proof that nothing changed.</p>
          ) : (
            <ul className="patches">
              {result.patches.slice(0, 12).map((pt) => (
                <li key={pt.id}>
                  <button onClick={() => onFly(pt.lat, pt.lon)}>
                    <b>{pt.label}</b>
                    <span>{pt.area_ha} ha · slope {pt.mean_slope_deg}° · NDVI {pt.ndvi_baseline.toFixed(2)} → {pt.ndvi_recent.toFixed(2)} ({pt.robust_z}σ)</span>
                  </button>
                </li>
              ))}
              {result.patches.length > 12 && <li className="hint">+{result.patches.length - 12} more on the map</li>}
            </ul>
          )}
          {result.has_overlay && (
            <label className="toggle">
              <input type="checkbox" checked={show} onChange={(e) => onShow(e.target.checked)} />
              <span>Show patches on the map <small>magenta</small></span>
            </label>
          )}
          <Sources list={[result.source]} method={
            'Median clear NDVI in the recent window vs the median of the same weeks in prior years; flagged where NDVI fell '
            + `by at least ${result.thresholds?.ndvi_drop ?? 0.15} and ${Math.abs(result.thresholds?.robust_z ?? 2)} robust sigmas, on slopes over `
            + `${result.thresholds?.min_slope_deg ?? 15}°, in patches of at least ${result.thresholds?.min_patch_ha ?? 0.5} ha. The cause is not determined: `
            + 'clearing, landslides, fire, harvest, drought and residual cloud all lower NDVI.'} />
        </>
      )}
    </section>
  )
}

function Sources({ list, method, limits }: { list: SourceRef[]; method: string; limits?: string[] }) {
  return (
    <details className="method">
      <summary>Method and sources</summary>
      <p>{method}</p>
      {limits && <ul>{limits.map((l) => <li key={l}>{l}</li>)}</ul>}
      <ul className="sources">
        {list.map((s) => (
          <li key={s.name}>
            {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a> : s.name}
            {s.use ? ` - ${s.use}` : ''}{s.licence ? ` · ${s.licence}` : ''}{s.citation ? ` · ${s.citation}` : ''}
          </li>
        ))}
      </ul>
    </details>
  )
}
