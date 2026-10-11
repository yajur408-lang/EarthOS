import { useRef, useState } from 'react'
import type { InspectSite, Priority } from '../api'
import { exportFieldCsv, exportFieldGeoJson, printFieldSheet, readFieldCsv, type FieldSummary } from '../fieldSheet'
import { prettyDate } from '../util'

interface Props {
  data: Priority | null
  loading: boolean
  error: string | null
  place: string
  kind: InspectSite['kind']
  onKind: (k: InspectSite['kind']) => void
  selected: string | null
  onSelect: (s: InspectSite) => void
}

const PART_LABEL: Record<string, string> = {
  susceptibility: 'susceptibility', exposure: 'buildings nearby', recent_loss: 'recent vegetation loss', history: 'past landslide', size: 'extent',
}
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`)

export default function InspectionList(p: Props) {
  const [summary, setSummary] = useState<FieldSummary | null>(null)
  const [importErr, setImportErr] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  if (p.loading) return <section className="hz"><h3>Where to inspect first</h3><p className="hint">Ranking 250 m squares…</p></section>
  if (p.error || !p.data) return <section className="hz"><h3>Where to inspect first</h3><div className="alert soft">{p.error ?? 'Unavailable'}</div></section>
  const d = p.data
  const list = d.sites.filter((s) => s.kind === p.kind)
  const v = d.validation
  return (
    <section className="hz">
      <h3>Where to inspect first <small>ranked 250 m squares, with the reasons</small></h3>
      <div className="seg" role="group" aria-label="Hazard">
        <button className={p.kind === 'slope' ? 'on' : ''} onClick={() => p.onKind('slope')}>Slopes · landslides ({d.total_sites.slope})</button>
        <button className={p.kind === 'stream corridor' ? 'on' : ''} onClick={() => p.onKind('stream corridor')}>Streams · flash floods ({d.total_sites['stream corridor']})</button>
      </div>
      {d.calibrated === false && (
        <p className="uncalibrated"><b>Uncalibrated here.</b> The weights and thresholds behind this ranking were chosen for the Santa Ana pilot; use it only as a rough first pass.</p>
      )}
      <p className="hint">A prioritisation aid for field checks, not a hazard map: a high rank means "look here first", not "dangerous".</p>
      {d.rainfall.available && (
        <p className={`rain-context ${(d.rainfall.percent_of_normal ?? 0) >= 150 ? 'wet' : ''}`}>
          Rain over the last 30 days ({prettyDate(d.rainfall.window![0])} – {prettyDate(d.rainfall.window![1])}): <b>{d.rainfall.rain_mm} mm</b>
          {d.rainfall.percent_of_normal != null && <>, <b>{d.rainfall.percent_of_normal}% of normal</b> for those weeks ({d.rainfall.years_compared} years)</>}.
          <small> Same for every square (~50 km data), so it isn't used to rank them.</small>
        </p>
      )}
      <ol className="inspect">
        {list.map((s) => (
          <li key={s.id} className={p.selected === s.id ? 'on' : ''}>
            <button onClick={() => p.onSelect(s)}>
              <span className="sid">{s.id}</span>
              <span className="sbody">
                <span className="sbar"><i style={{ width: `${Math.round(s.score * 100)}%` }} /></span>
                <span className="sreasons">{s.reasons.join(' · ')}</span>
                {p.selected === s.id && (
                  <span className="sparts">
                    Score {s.score.toFixed(2)} = {Object.entries(s.parts).map(([k, x]) => `${PART_LABEL[k]} ${x.toFixed(2)}×${d.weights[k]}`).join(' + ')}.
                    {' '}{s.area_ha} ha of high susceptibility in the square{s.uncertain_share >= 0.3 ? `; ${pct(s.uncertain_share)} of it could change class within data error` : ''}.
                    {' '}Centre {s.lat.toFixed(5)}, {s.lon.toFixed(5)}.
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {list.length === 0 && <p>No square in this area holds 1 ha or more of high susceptibility of this kind.</p>}

      <div className="field-actions">
        <b>Check it on the ground</b>
        <span className="hint">Give the list to local experts (municipal emergency committee, CNE, geology or geography teachers). They record what they find; import the sheet to see whether the ranking holds up.</span>
        <div className="hz-actions">
          <button className="btn" onClick={() => printFieldSheet(p.place, d)}>Print field sheet</button>
          <button className="btn" onClick={() => exportFieldCsv(p.place, d)}>Field sheet (.csv)</button>
          <button className="btn" onClick={() => exportFieldGeoJson(p.place, d)}>Squares (.geojson)</button>
          <button className="btn" onClick={() => file.current?.click()}>Import findings…</button>
          <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            try {
              const sm = readFieldCsv(await f.text(), d.sites)
              setSummary(sm)
              setImportErr(sm.matched ? null : 'No rows with a site_id from this list and a finding were found.')
            } catch (err) {
              setImportErr((err as Error).message)
            }
          }} />
        </div>
        {importErr && <div className="alert soft">{importErr}</div>}
        {summary && summary.matched > 0 && <FieldResults s={summary} />}
      </div>

      <details className="method">
        <summary>Is the map any good? Past landslides vs the map</summary>
        {v.events_usable === 0 ? (
          <p>No reported landslide inside this area has a location accurate to 1 km or better ({v.events_in_area} reported, all too vague), so the map can't be checked against history here. Field checks are the way to test it.</p>
        ) : (
          <>
            <p>
              Of <b>{v.events_usable}</b> located landslides in the area, <b>{pct(v.share_in_high)}</b> fall within 100 m of a high cell and{' '}
              <b>{pct(v.share_in_medium_or_high)}</b> of a medium or high cell, while high covers {pct(v.area_share.high)} and medium or high{' '}
              {pct(v.area_share.high + v.area_share.medium)} of the area. {v.excluded_vague_location} more were left out because their location is vague.
            </p>
            <ul>
              {v.events.map((e) => <li key={e.date + e.title}>{e.date} · {e.title} · at the point: {e.class_at_point}, within 100 m: <b>{e.highest_within_100m}</b></li>)}
            </ul>
            {v.missed.length > 0 && <p><b>Missed:</b> {v.missed.map((m) => `${m.date} ${m.title}`).join('; ')}.</p>}
          </>
        )}
        <p>{v.method}</p>
        <p className="caveat">{v.caveat}</p>
      </details>
      <details className="method">
        <summary>Evidence: data, dates and resolution</summary>
        <table className="evidence">
          <thead><tr><th>Layer</th><th>Source</th><th>Date</th><th>Resolution</th></tr></thead>
          <tbody>{d.evidence.map((e) => <tr key={e.layer}><td>{e.layer}</td><td>{e.source}</td><td>{e.date}</td><td>{e.resolution}</td></tr>)}</tbody>
        </table>
        {!d.forest_loss_used && <p className="hint">The forest-loss watch hasn't finished for this area, so "recent vegetation loss" isn't counted yet.</p>}
        <p>{d.method}</p>
      </details>
    </section>
  )
}

function FieldResults({ s }: { s: FieldSummary }) {
  return (
    <div className="field-results">
      <b>Field findings imported: {s.matched} squares</b>
      {Object.entries(s.byKind).map(([k, x]) => (
        <p key={k}>
          {k === 'slope' ? 'Slopes' : 'Stream corridors'}: {x.inspected} inspected · <b>signs seen at {x.signs}</b>
          {x.inspected ? ` (${pct(x.signs / x.inspected)})` : ''} · no signs {x.none} · unsure {x.unsure}{x.inaccessible ? ` · not accessible ${x.inaccessible}` : ''}
        </p>
      ))}
      {s.topHalfSignsRate != null && s.bottomHalfSignsRate != null && (
        <p>Signs seen in {pct(s.topHalfSignsRate)} of the top-ranked half vs {pct(s.bottomHalfSignsRate)} of the lower half
          {s.topHalfSignsRate > s.bottomHalfSignsRate ? ' - the ranking is pointing the right way.' : ' - the ranking is not helping yet; adjust the weights in screening.toml and re-check.'}</p>
      )}
      {s.unknownIds.length > 0 && <p className="hint">Not in this list: {s.unknownIds.slice(0, 8).join(', ')}{s.unknownIds.length > 8 ? '…' : ''}</p>}
      <p className="hint">The findings stay in your browser; keep the filled-in sheet as the record.</p>
    </div>
  )
}
