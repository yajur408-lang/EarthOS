import '@photo-sphere-viewer/core/index.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type StreetImage } from '../api'
import { prettyDate } from '../util'
import Icon from './Icon'

interface Props {
  origin: { lat: number; lon: number }
  images: StreetImage[]
  start: StreetImage
  attribution: string
  onChange: (img: StreetImage) => void
  onClose: () => void
}

export default function StreetView({ origin, images, start, attribution, onChange, onClose }: Props) {
  const [img, setImg] = useState(start)
  const [navState, setNavState] = useState<{ key: string; prev: StreetImage | null; next: StreetImage | null } | null>(null)
  const imgKey = `${img.provider}:${img.id}`
  const nav = navState?.key === imgKey ? navState : null
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  // Follow selections made outside the viewer (e.g. clicking a photo dot on the globe).
  const [shown, setShown] = useState(start)
  if (start !== shown) {
    setShown(start)
    if (start.provider !== img.provider || start.id !== img.id) {
      setImg(start)
      setLoading(true)
      setFailed(false)
    }
  }

  const go = (next: StreetImage) => {
    setImg(next)
    setLoading(true)
    setFailed(false)
    onChange(next)
  }

  useEffect(() => {
    let live = true
    if (img.sequence) api.streetSequence(img).then((n) => live && setNavState({ key: `${img.provider}:${img.id}`, ...n })).catch(() => {})
    return () => {
      live = false
    }
  }, [img])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowUp' && nav?.next) go(nav.next)
      else if (e.key === 'ArrowDown' && nav?.prev) go(nav.prev)
      else return
      e.stopPropagation()
      e.preventDefault()
    }
    window.addEventListener('keydown', k, true) // capture: the globe's keyboard flying must not react
    return () => window.removeEventListener('keydown', k, true)
  })

  // One representative (nearest) image per capture date: Google's "see more dates".
  const byDate = useMemo(() => {
    const m = new Map<string, StreetImage>()
    for (const i of images) {
      const cur = m.get(i.captured)
      if (!cur || i.distance_m < cur.distance_m) m.set(i.captured, i)
    }
    return [...m.values()].sort((a, b) => b.captured.localeCompare(a.captured))
  }, [images])

  const url = api.streetImageUrl(img, 'full')

  return (
    <div className="street" role="dialog" aria-label="Street-level imagery">
      <div className="street-stage">
        {img.pano
          ? <Pano url={url} heading={img.heading} onReady={() => setLoading(false)} onError={() => { setLoading(false); setFailed(true) }} />
          : <FlatImage url={url} onReady={() => setLoading(false)} onError={() => { setLoading(false); setFailed(true) }} />}
        {loading && <div className="street-loading"><span className="spinner" aria-hidden /> Loading image…</div>}
        {failed && <div className="street-loading">This image could not be loaded from {img.provider === 'kartaview' ? 'KartaView' : 'Mapillary'}.</div>}

        <div className="street-arrows">
          <button className="ctrl" disabled={!nav?.prev} onClick={() => nav?.prev && go(nav.prev)} title="Back along the route (↓)" aria-label="Previous photo">
            <Icon name="chevronLeft" />
          </button>
          <button className="ctrl" disabled={!nav?.next} onClick={() => nav?.next && go(nav.next)} title="Forward along the route (↑)" aria-label="Next photo">
            <Icon name="chevronRight" />
          </button>
        </div>
      </div>

      <header className="street-head">
        <button className="icon-btn on-dark" onClick={onClose} aria-label="Back to map"><Icon name="close" /></button>
        <div>
          <strong>{prettyDate(img.captured)}</strong>
          <span>
            {img.pano ? '360° panorama' : 'Photo'} · {Math.round(distanceM(origin, img))} m from pin
            {img.heading != null ? ` · facing ${Math.round(img.heading)}°` : ''}
          </span>
        </div>
        <a className="chip dark" href={img.page} target="_blank" rel="noreferrer">
          Open on {img.provider === 'kartaview' ? 'KartaView' : 'Mapillary'}
        </a>
      </header>

      {byDate.length > 1 && (
        <div className="street-dates" aria-label="Other capture dates">
          <span>Other dates</span>
          {byDate.map((d) => (
            <button key={d.provider + d.id} className={d.captured === img.captured ? 'on' : ''} onClick={() => go(d)}>
              <img src={api.streetImageUrl(d, 'thumb')} alt="" loading="lazy" />
              <b>{d.captured.slice(0, 7)}</b>
            </button>
          ))}
        </div>
      )}

      <footer className="street-foot">
        {attribution}{img.author ? ` · photo by ${img.author}` : ''}
      </footer>
    </div>
  )
}

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = Math.PI / 180
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2
  return 12_742_000 * Math.asin(Math.sqrt(h))
}

function Pano({ url, heading, onReady, onError }: { url: string; heading: number | null; onReady: () => void; onError: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const viewer = useRef<import('@photo-sphere-viewer/core').Viewer | null>(null)
  const cbs = useRef({ onReady, onError })
  useEffect(() => {
    cbs.current = { onReady, onError }
  }, [onReady, onError])

  useEffect(() => {
    let cancelled = false
    import('@photo-sphere-viewer/core').then(({ Viewer }) => {
      if (cancelled || !ref.current) return
      if (!viewer.current) {
        viewer.current = new Viewer({
          container: ref.current, panorama: url, navbar: ['zoom', 'move', 'fullscreen'],
          defaultYaw: 0, touchmoveTwoFingers: false, mousewheelCtrlKey: false, loadingTxt: '',
        })
        viewer.current.addEventListener('panorama-loaded', () => cbs.current.onReady())
        viewer.current.addEventListener('panorama-error', () => cbs.current.onError())
      } else {
        viewer.current.setPanorama(url).catch(() => cbs.current.onError())
      }
    })
    return () => {
      cancelled = true
    }
  }, [url, heading])

  useEffect(() => () => {
    viewer.current?.destroy()
    viewer.current = null
  }, [])

  return <div ref={ref} className="pano" />
}

function FlatImage({ url, onReady, onError }: { url: string; onReady: () => void; onError: () => void }) {
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      className="flat"
      onWheel={(e) => setT((v) => ({ ...v, s: Math.min(6, Math.max(1, v.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))) }))}
      onPointerDown={(e) => { drag.current = { x: e.clientX - t.x, y: e.clientY - t.y }; (e.target as HTMLElement).setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => drag.current && t.s > 1 && setT((v) => ({ ...v, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }))}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => setT({ s: 1, x: 0, y: 0 })}
    >
      <img
        key={url}
        src={url}
        alt="Street-level photo"
        draggable={false}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})` }}
        onLoad={() => { setT({ s: 1, x: 0, y: 0 }); onReady() }}
        onError={onError}
      />
    </div>
  )
}
