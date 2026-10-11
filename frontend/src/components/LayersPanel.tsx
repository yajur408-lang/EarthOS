import { useEffect, useRef, useState } from 'react'
import { LAYERS, thumbUrl } from '../layers'
import { isoDaysAgo } from '../util'
import Icon from './Icon'

interface Props {
  base: string
  overlays: string[]
  opacity: number
  sharp: boolean
  onSharp: (on: boolean) => void
  extras: boolean
  onExtras: (on: boolean) => void
  onBase: (id: string) => void
  onToggle: (id: string) => void
  onOpacity: (v: number) => void
}

const THUMB_DATE = isoDaysAgo(20) // recent enough for every timed layer to have data

export default function LayersPanel({ base, overlays, opacity, sharp, onSharp, extras, onExtras, onBase, onToggle, onOpacity }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const baseLayer = LAYERS.find((l) => l.id === base)!

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="layers" ref={ref}>
      {open && (
        <div className="layers-panel" role="dialog" aria-label="Map layers">
          <h3>Map type</h3>
          <div className="thumbs">
            {LAYERS.filter((l) => l.kind === 'base').map((l) => (
              <button key={l.id} className={`thumb ${base === l.id ? 'on' : ''}`} onClick={() => onBase(l.id)} title={l.description}>
                <img src={thumbUrl(l, THUMB_DATE)} alt="" loading="lazy" />
                <span>{l.title.replace(' true colour', '')}</span>
              </button>
            ))}
          </div>
          <label className="sharp-toggle">
            <input type="checkbox" checked={sharp} onChange={(e) => onSharp(e.target.checked)} />
            <span><b>Sharp 30 m imagery when zoomed in</b><small>Clearest recent Landsat / Sentinel-2 pass (NASA HLS)</small></span>
          </label>
          <h3>Map details</h3>
          <div className="thumbs">
            {LAYERS.filter((l) => l.kind === 'overlay').map((l) => (
              <button key={l.id} className={`thumb overlay ${overlays.includes(l.id) ? 'on' : ''}`} onClick={() => onToggle(l.id)}
                title={l.description} aria-pressed={overlays.includes(l.id)}>
                <img src={thumbUrl(l, THUMB_DATE)} alt="" loading="lazy" />
                <span>{l.title}</span>
              </button>
            ))}
          </div>
          <h3>Hazard layers <small>storms, floods, damage, outages</small></h3>
          <div className="thumbs">
            {LAYERS.filter((l) => l.kind === 'hazard').map((l) => (
              <button key={l.id} className={`thumb overlay ${overlays.includes(l.id) ? 'on' : ''}`} onClick={() => onToggle(l.id)}
                title={`${l.description} (${l.cadence})`} aria-pressed={overlays.includes(l.id)}>
                <img src={thumbUrl(l, THUMB_DATE)} alt="" loading="lazy" />
                <span>{l.title}</span>
              </button>
            ))}
          </div>
          <label className="sharp-toggle">
            <input type="checkbox" checked={extras} onChange={(e) => onExtras(e.target.checked)} />
            <span><b>Show weather and nearby events</b><small>Adds Weather and Events tabs to the place card (optional context)</small></span>
          </label>
          <label className="opacity">
            <span>Data layer opacity</span>
            <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => onOpacity(+e.target.value)} />
          </label>
        </div>
      )}
      <button className={`layers-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Layers">
        <img src={thumbUrl(baseLayer, THUMB_DATE)} alt="" />
        <span><Icon name="layers" size={16} /> Layers</span>
      </button>
    </div>
  )
}
