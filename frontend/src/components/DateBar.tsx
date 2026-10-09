import { LAYERS, layerById } from '../layers'
import { isoDaysAgo, prettyDate, shiftDate } from '../util'
import Icon from './Icon'

export interface CompareState {
  on: boolean
  layerId: string
  a: string
  b: string
}

interface Props {
  date: string
  onDate: (d: string) => void
  compare: CompareState
  onCompare: (c: CompareState) => void
  legendLayers: string[]
}

const TODAY = isoDaysAgo(0)

export default function DateBar({ date, onDate, compare, onCompare, legendLayers }: Props) {
  const legends = legendLayers.map(layerById).filter((l) => l.legend)
  return (
    <div className="datebar-wrap">
      {legends.length > 0 && (
        <div className="legends">
          {legends.map((l) => (
            <div key={l.id} className="legend">
              <span>{l.title}</span>
              <i>{l.legend!.from}</i>
              <b style={{ background: `linear-gradient(90deg, ${l.legend!.colors.join(',')})` }} />
              <i>{l.legend!.to}</i>
            </div>
          ))}
        </div>
      )}

      <div className="datebar">
        {!compare.on ? (
          <>
            <button className="icon-btn" title="Back 16 days" aria-label="Back 16 days" onClick={() => onDate(shiftDate(date, -16))}>«</button>
            <button className="icon-btn" title="Previous day" aria-label="Previous day" onClick={() => onDate(shiftDate(date, -1))}>
              <Icon name="chevronLeft" />
            </button>
            <label className="date-pick" title="Choose date">
              <Icon name="calendar" size={18} />
              <span>{prettyDate(date)}</span>
              <input type="date" value={date} min="2000-03-01" max={TODAY} onChange={(e) => e.target.value && onDate(e.target.value)} />
            </label>
            <button className="icon-btn" title="Next day" aria-label="Next day" disabled={date >= TODAY} onClick={() => onDate(shiftDate(date, 1))}>
              <Icon name="chevronRight" />
            </button>
            <button className="icon-btn" title="Forward 16 days" aria-label="Forward 16 days" disabled={date >= TODAY} onClick={() => onDate(shiftDate(date, 16))}>»</button>
          </>
        ) : (
          <>
            <select aria-label="Layer to compare" value={compare.layerId} onChange={(e) => onCompare({ ...compare, layerId: e.target.value })}>
              {LAYERS.filter((l) => l.timed && !l.wms).map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
            <label className="date-pick small">
              <span>A · {prettyDate(compare.a)}</span>
              <input type="date" value={compare.a} min="2000-03-01" max={TODAY} onChange={(e) => e.target.value && onCompare({ ...compare, a: e.target.value })} />
            </label>
            <span className="vs">vs</span>
            <label className="date-pick small">
              <span>B · {prettyDate(compare.b)}</span>
              <input type="date" value={compare.b} min="2000-03-01" max={TODAY} onChange={(e) => e.target.value && onCompare({ ...compare, b: e.target.value })} />
            </label>
          </>
        )}
        <span className="divider" aria-hidden />
        <button className={`chip ${compare.on ? 'on' : ''}`} onClick={() => onCompare({ ...compare, on: !compare.on })} aria-pressed={compare.on}>
          <Icon name="compare" size={18} /> Compare
        </button>
      </div>
    </div>
  )
}
