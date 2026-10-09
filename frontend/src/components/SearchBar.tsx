import { useEffect, useRef, useState } from 'react'
import { api, type GeoResult, type Place } from '../api'
import type { SavedPlace } from '../exporters'
import { fmtLatLon, parseLatLon } from '../util'
import Icon from './Icon'

export type SearchPick =
  | { kind: 'coords'; lat: number; lon: number }
  | { kind: 'place'; place: Place }
  | { kind: 'geo'; result: GeoResult }
  | { kind: 'saved'; saved: SavedPlace }

interface Props {
  examples: Place[]
  saved: SavedPlace[]
  onExportSaved: () => void
  title: string | null
  onPick: (p: SearchPick) => void
  onClear: () => void
}

// Nominatim's policy forbids autocomplete, so searching happens on Enter only.
export default function SearchBar({ examples, saved, onExportSaved, title, onPick, onClear }: Props) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<GeoResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const [shownTitle, setShownTitle] = useState(title)
  if (title !== shownTitle) {
    setShownTitle(title)
    if (title != null) setText(title)
  }

  // "/" focuses search, as in Google Maps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [])

  const coords = parseLatLon(text)
  const savedMatches = saved.filter((s) => !text.trim() || `${s.name} ${s.label ?? ''}`.toLowerCase().includes(text.trim().toLowerCase()))
  const q = text.trim().toLowerCase()
  const exampleMatches = q
    ? examples.filter((p) => `${p.name} ${p.country}`.toLowerCase().includes(q))
    : examples

  const submit = async () => {
    if (coords) {
      pick({ kind: 'coords', ...coords })
      return
    }
    if (q.length < 2) return
    setBusy(true)
    setErr(null)
    setOpen(true)
    try {
      const r = await api.geocode(text)
      setResults(r)
      if (r.length === 1) pick({ kind: 'geo', result: r[0] })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pick = (p: SearchPick) => {
    setOpen(false)
    setResults(null)
    inputRef.current?.blur()
    onPick(p)
  }

  return (
    <div className="search" ref={boxRef}>
      <form
        className="search-box"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <span className="brand-mark" aria-hidden>
          <Icon name="globe" size={22} />
        </span>
        <input
          ref={inputRef}
          value={text}
          placeholder="Search places or coordinates"
          aria-label="Search places or coordinates"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value)
            setResults(null)
            setErr(null)
            setOpen(true)
          }}
          onKeyDown={(e) => e.key === 'Escape' && (setOpen(false), inputRef.current?.blur())}
        />
        {text && (
          <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => {
            setText('')
            setResults(null)
            onClear()
            inputRef.current?.focus()
          }}>
            <Icon name="close" />
          </button>
        )}
        <span className="divider" aria-hidden />
        <button type="submit" className="icon-btn accent" aria-label="Search">
          <Icon name="search" />
        </button>
      </form>

      {open && (
        <div className="search-results" role="listbox">
          {coords && (
            <button className="result" onClick={() => pick({ kind: 'coords', ...coords })}>
              <Icon name="pin" />
              <div><strong>Go to {fmtLatLon(coords.lat, coords.lon)}</strong><span>Coordinates</span></div>
            </button>
          )}
          {busy && <div className="result muted">Searching…</div>}
          {err && <div className="result muted">{err}</div>}
          {results?.length === 0 && <div className="result muted">No places found. Try a broader name, or lat, lon.</div>}
          {results?.map((r) => (
            <button key={`${r.lat},${r.lon},${r.label}`} className="result" onClick={() => pick({ kind: 'geo', result: r })}>
              <Icon name="pin" />
              <div><strong>{r.name}</strong><span>{r.label}</span></div>
            </button>
          ))}
          {!results && !coords && savedMatches.length > 0 && (
            <>
              <div className="result-heading with-action">
                Saved places
                <button className="link" onClick={onExportSaved}>Download all</button>
              </div>
              {savedMatches.map((s) => (
                <button key={`${s.lat},${s.lon}`} className="result" onClick={() => pick({ kind: 'saved', saved: s })}>
                  <Icon name="starFilled" />
                  <div><strong>{s.name}</strong><span>{s.label ?? fmtLatLon(s.lat, s.lon)}</span></div>
                </button>
              ))}
            </>
          )}
          {!results && !coords && exampleMatches.length > 0 && (
            <>
              <div className="result-heading">{q ? 'Example places' : 'Try an example place'}</div>
              {exampleMatches.map((p) => (
                <button key={p.id} className="result" onClick={() => pick({ kind: 'place', place: p })}>
                  <Icon name="history" />
                  <div><strong>{p.name}</strong><span>{p.country} · {p.about}</span></div>
                </button>
              ))}
            </>
          )}
          {!results && !coords && q.length >= 2 && (
            <div className="result-hint">Press Enter to search all places · or click anywhere on the globe</div>
          )}
          {!q && <div className="result-hint">Tip: click anywhere on the globe to drop a pin · press / to search</div>}
        </div>
      )}
    </div>
  )
}
