import { useEffect, useRef, useState } from 'react'
import type { HlsPass } from '../api'
import { useBus, type Bus } from '../bus'
import { daysBefore, SHARP_BELOW_M } from '../useSharpImagery'
import { prettyDate } from '../util'
import type { ViewState } from './Globe'

const SENSOR = { S30: 'Sentinel-2', L30: 'Landsat' } as const

interface Props {
  view: Bus<ViewState>
  date: string
  pass: HlsPass | null
  passes: HlsPass[]
  loading: boolean
  onChoose: (p: HlsPass) => void
}

const gap = (p: HlsPass, date: string) => {
  const d = daysBefore(p, date)
  return d === 0 ? 'same day' : d > 0 ? `${d} day${d === 1 ? '' : 's'} before` : `${-d} day${d === -1 ? '' : 's'} after`
}

/** Says which 30 m pass is on screen, how far it is from the chosen date, and lets you pick another. */
export default function SharpChip({ view, date, pass, passes, loading, onChoose }: Props) {
  const { heightM } = useBus(view)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', down)
    return () => window.removeEventListener('pointerdown', down)
  }, [])

  if (heightM > SHARP_BELOW_M) return null
  const far = pass ? Math.abs(daysBefore(pass, date)) > 30 : false
  return (
    <div className="sharp" ref={ref}>
      <button className={`sharp-chip ${far ? 'far' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}
        title="The sharp 30 m imagery shown when zoomed in">
        <span className="dot-live" aria-hidden />
        {loading && !pass ? 'Finding a clear 30 m pass…'
          : pass ? <>30 m imagery: {prettyDate(pass.date)} ({gap(pass, date)}) ▾</>
            : 'No 30 m pass near this date'}
      </button>
      {open && passes.length > 0 && (
        <div className="sharp-menu" role="listbox" aria-label="30 m satellite passes">
          <h4>Passes near {prettyDate(date)}, best first</h4>
          {passes.slice(0, 20).map((p) => (
            <button key={p.sensor + p.date} role="option" aria-selected={pass?.date === p.date && pass.sensor === p.sensor}
              className={pass?.date === p.date && pass.sensor === p.sensor ? 'on' : ''}
              onClick={() => { onChoose(p); setOpen(false) }}>
              <span>{prettyDate(p.date)}</span>
              <small>{SENSOR[p.sensor]}</small>
              <b style={{ width: `${Math.max(4, 100 - p.cloud_pct) * 0.6}px` }} aria-hidden />
              <em>{Math.round(p.cloud_pct)}% tile cloud</em>
            </button>
          ))}
          <p>Ranked by cloud and closeness to the date bar. NASA reports cloud for the whole 110 km tile, so your spot may still have clouds - try the next pass.</p>
        </div>
      )}
    </div>
  )
}
