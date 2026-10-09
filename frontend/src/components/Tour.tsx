import { useEffect, useLayoutEffect, useState } from 'react'

export interface TourStep {
  /** CSS selector of the element to spotlight; omit for a centred card. */
  target?: string
  title: string
  body: string
  /** Runs when the step opens (e.g. open an example place so the card exists). */
  enter?: () => void
}

interface Props {
  steps: TourStep[]
  onClose: () => void
}

type Rect = { top: number; left: number; width: number; height: number }
const PAD = 8

/** A lightweight guided tour: dims the page, spotlights one element per step, and explains it. */
export default function Tour({ steps, onClose }: Props) {
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const step = steps[i]

  useEffect(() => {
    step.enter?.()
  }, [step])

  // Follow the target as it appears, animates or the window resizes.
  useLayoutEffect(() => {
    let frame = 0
    const measure = () => {
      const el = step.target ? document.querySelector(step.target) : null
      const r = el?.getBoundingClientRect()
      setRect((prev) => {
        const next = r && r.width > 0 ? { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 } : null
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      })
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [step])

  const next = () => (i === steps.length - 1 ? onClose() : setI(i + 1))

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1))
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  })

  // Put the explanation card beside the spotlight, on whichever side has room.
  const vw = window.innerWidth, vh = window.innerHeight
  const cardW = Math.min(340, vw - 24)
  let style: React.CSSProperties = { left: (vw - cardW) / 2, top: vh / 2 - 110, width: cardW }
  if (rect) {
    const right = rect.left + rect.width + 14
    const below = rect.top + rect.height + 14
    if (right + cardW < vw - 12) style = { left: right, top: Math.min(Math.max(rect.top, 12), vh - 240), width: cardW }
    else if (rect.left - cardW - 14 > 12) style = { left: rect.left - cardW - 14, top: Math.min(Math.max(rect.top, 12), vh - 240), width: cardW }
    else if (below + 200 < vh) style = { left: Math.min(Math.max(rect.left, 12), vw - cardW - 12), top: below, width: cardW }
    else style = { left: Math.min(Math.max(rect.left, 12), vw - cardW - 12), top: Math.max(rect.top - 214, 12), width: cardW }
  }

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="EarthOS tutorial">
      {rect
        ? <div className="tour-hole" style={rect} />
        : <div className="tour-dim" />}
      <div className="tour-card" style={style}>
        <span className="tour-count">{i + 1} / {steps.length}</span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button className="link" onClick={onClose}>Skip tour</button>
          <span />
          {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>Back</button>}
          <button className="btn primary" onClick={next} autoFocus>{i === steps.length - 1 ? 'Start exploring' : 'Next'}</button>
        </div>
      </div>
    </div>
  )
}
