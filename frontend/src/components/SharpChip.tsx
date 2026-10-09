import { useEffect, useRef, useState } from 'react'
import type { HlsPass } from '../api'
import { useBus, type Bus } from '../bus'
import { SHARP_BELOW_M } from '../useSharpImagery'
import { prettyDate } from '../util'
import type { ViewState } from './Globe'

const SENSOR = { S30: 'Sentinel-2', L30: 'Landsat' } as const

interface Props {
  view: Bus<ViewState>
  pass: HlsPass | null
  passes: HlsPass[]
  loading: boolean
  onChoose: (p: HlsPass) => void
}

/** Shows which 30 m pass is on screen when zoomed in, and lets the user pick another. */
export default function SharpChip({ view, pass, passes, loading, onChoose }: Props) {
  const { heightM } = useBus(view)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', down)
    return () => window.removeEventListener('pointerdown', down)
  }, [])

  if (heightM > SHARP_BELOW_M) return null
  const sorted = [...passes].sort((a, b) => a.cloud_pct - b.cloud_pct || b.date.localeCompare(a.date)).slice(0, 20)
  return (
    <div className="sharp" ref={ref}>
      <button className="sharp-chip" onClick={() => setOpen(!open)} aria-expanded={open} title="30 m satellite pass shown when zoomed in">
        <span className="dot-live" aria-hidden />
        {loading && !pass ? 'Finding a clear 30 m pass…'
          : pass ? <>30 m · {SENSOR[pass.sensor]} · {prettyDate(pass.date)} · {Math.round(pass.cloud_pct)}% cloud ▾</>
            : 'No 30 m pass found here'}
      </button>
      {open && sorted.length > 0 && (
        <div className="sharp-menu" role="listbox" aria-label="30 m satellite passes">
          <h4>Clearest passes in the last 6 months</h4>
          {sorted.map((p) => (
            <button key={p.sensor + p.date} role="option" aria-selected={pass?.date === p.date && pass.sensor === p.sensor}
              className={pass?.date === p.date && pass.sensor === p.sensor ? 'on' : ''}
              onClick={() => { onChoose(p); setOpen(false) }}>
              <span>{prettyDate(p.date)}</span>
              <small>{SENSOR[p.sensor]}</small>
              <b style={{ width: `${Math.max(4, 100 - p.cloud_pct) * 0.6}px` }} aria-hidden />
              <em>{Math.round(p.cloud_pct)}% cloud</em>
            </button>
          ))}
          <p>Cloud cover is reported per 110 km tile, so the spot you're viewing may be clearer or cloudier.</p>
        </div>
      )}
    </div>
  )
}
