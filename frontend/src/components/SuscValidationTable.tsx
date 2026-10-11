import type { SuscValidation } from '../api'

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`)

/** Past landslides vs the susceptibility classes, with the fair area comparison and the chance level. */
export default function SuscValidationTable({ v }: { v: SuscValidation }) {
  if (v.events_usable === 0) {
    return (
      <p>
        None of the {v.events_in_area} reported landslides inside this area has a location accurate to 1 km or better, so the map can't be
        checked against history here. Field checks are the way to test it.
      </p>
    )
  }
  const high = v.table.find((t) => t.class === 'high')
  const chanceAllHigh = high && high.events === v.events_usable ? Math.pow(high.area_share_within_100m, v.events_usable) : null
  return (
    <>
      <div className="bt-table-wrap">
        <table className="bt-table">
          <thead><tr><th>Highest class within 100 m</th><th>Located landslides</th><th>Share of land</th><th>Frequency ratio</th></tr></thead>
          <tbody>
            {v.table.map((t) => (
              <tr key={t.class}>
                <td>{t.class === 'lower' ? 'lower (not safe)' : t.class}</td>
                <td className="num">{t.events} of {v.events_usable} ({pct(t.event_share)})</td>
                <td className="num">{pct(t.area_share_within_100m)}</td>
                <td className="num">{t.frequency_ratio ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        n = {v.events_usable} located landslides ({v.excluded_vague_location} more excluded for vague locations).
        {chanceAllHigh != null && <> Because {pct(high!.area_share_within_100m)} of the land is within 100 m of a high cell, {v.events_usable === 2 ? 'both' : v.events_usable === 1 ? 'it' : `all ${v.events_usable}`} would land there
          by chance {pct(chanceAllHigh)} of the time - <b>far too few events to show the map works</b>.</>}
        {v.missed.length > 0 && <> Missed (only "lower" within 100 m): {v.missed.map((m) => m.date).join(', ')}.</>}
      </p>
      <p className="muted">{v.method}</p>
      <p className="muted">{v.caveat}</p>
    </>
  )
}
