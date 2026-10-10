import { useEffect, useRef, useState } from 'react'
import { OFFICIAL_ALERTS } from '../officialAlerts'

/** "Screening tool, not an official warning" + official alert links. Shown on every view. */
export default function ScreeningFooter() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', down)
    return () => window.removeEventListener('pointerdown', down)
  }, [open])
  return (
    <span className="screen-footer" ref={ref}>
      <b>Screening tool, not an official warning</b>
      <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>Official alerts</button>
      {open && (
        <span className="official-pop" role="dialog" aria-label="Official alerts">
          For warnings and evacuation orders, always follow the official services:
          <ul>
            {OFFICIAL_ALERTS.map((o) => (
              <li key={o.url}><a href={o.url} target="_blank" rel="noopener noreferrer">{o.name}</a></li>
            ))}
          </ul>
        </span>
      )}
    </span>
  )
}
