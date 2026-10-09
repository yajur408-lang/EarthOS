import { useState } from 'react'
import { useBus, type Bus } from '../bus'
import type { ViewState } from './Globe'
import Icon from './Icon'

interface Props {
  view: Bus<ViewState>
  terrain: boolean
  orbiting: boolean
  pegman: boolean
  locating: boolean
  onZoom: (d: 1 | -1) => void
  onNorth: () => void
  onRotate: (deg: number) => void
  onTilt: () => void
  onOrbit: () => void
  onTerrain: () => void
  onPegman: () => void
  onLocate: () => void
}

const SHORTCUTS: [string, string][] = [
  ['Drag', 'Pan'],
  ['Scroll / double-click', 'Zoom'],
  ['Right-drag', 'Zoom smoothly'],
  ['Ctrl + drag / middle-drag', 'Tilt and rotate'],
  ['W A S D / arrows', 'Fly'],
  ['Q / E', 'Rotate'],
  ['R / F', 'Tilt up / down'],
  ['+ / −', 'Zoom'],
  ['/', 'Search'],
]

export default function MapControls(p: Props) {
  const [help, setHelp] = useState(false)
  const { headingDeg, pitchDeg } = useBus(p.view)
  const tilted = pitchDeg > -75
  return (
    <div className="controls">
      {help && (
        <div className="shortcuts" role="dialog" aria-label="Navigation shortcuts">
          <h3>Navigate like Google Earth</h3>
          <dl>{SHORTCUTS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </div>
      )}
      <button className={`ctrl ${help ? 'on' : ''}`} onClick={() => setHelp(!help)} title="Navigation help" aria-label="Navigation help">
        <Icon name="help" />
      </button>
      <button className={`ctrl pegman ${p.pegman ? 'on' : ''}`} onClick={p.onPegman}
        title={p.pegman ? 'Click the globe to open street-level photos there' : 'Street-level photos: click, then click a place'} aria-pressed={p.pegman}>
        <Icon name="street" />
      </button>
      <div className="compass-wrap">
        <button className="rot" onClick={() => p.onRotate(-30)} title="Rotate left (Q)" aria-label="Rotate left">‹</button>
        <button className="ctrl compass" onClick={p.onNorth} title="Reset to north" aria-label="Reset to north">
          <svg viewBox="0 0 24 24" width="26" height="26" style={{ transform: `rotate(${-headingDeg}deg)` }} aria-hidden>
            <path d="M12 2 15 12H9z" fill="#ea4335" />
            <path d="M12 22 9 12h6z" fill="#9aa0a6" />
          </svg>
        </button>
        <button className="rot" onClick={() => p.onRotate(30)} title="Rotate right (E)" aria-label="Rotate right">›</button>
      </div>
      <button className={`ctrl text ${tilted ? 'on' : ''}`} onClick={p.onTilt} title={tilted ? 'Look straight down' : 'Tilt to 3D view'}>
        {tilted ? '2D' : '3D'}
      </button>
      <button className={`ctrl ${p.orbiting ? 'on' : ''}`} onClick={p.onOrbit} title="Orbit around the centre of the view" aria-pressed={p.orbiting}>
        <Icon name="orbit" />
      </button>
      <button className={`ctrl ${p.terrain ? 'on' : ''}`} onClick={p.onTerrain} title={p.terrain ? '3D terrain on' : '3D terrain off'} aria-pressed={p.terrain}>
        <Icon name="terrain" />
      </button>
      <button className={`ctrl ${p.locating ? 'busy' : ''}`} onClick={p.onLocate} title="Show my location" aria-label="Show my location">
        <Icon name="location" />
      </button>
      <div className="ctrl-group">
        <button className="ctrl" onClick={() => p.onZoom(1)} title="Zoom in" aria-label="Zoom in"><Icon name="plus" /></button>
        <button className="ctrl" onClick={() => p.onZoom(-1)} title="Zoom out" aria-label="Zoom out"><Icon name="minus" /></button>
      </div>
    </div>
  )
}
