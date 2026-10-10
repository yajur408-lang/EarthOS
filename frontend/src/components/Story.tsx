import { useEffect, useState } from 'react'
import type { AnomalyEvent, Series } from '../api'
import { prettyDate } from '../util'

export interface StoryControls {
  openPlace: () => void
  showTab: (tab: 'overview' | 'charts' | 'anomalies') => void
  focusEvent: (start: string) => void
  compareEvent: (ev: AnomalyEvent) => void
  endCompare: () => void
}

interface Props {
  series: Series | null
  loading: boolean
  controls: StoryControls
  onClose: () => void
}

// The hero event: Santa Rosa's late green-up in May 2026. If the data ever change, the story falls back
// to the most trustworthy below-normal event.
const HERO_START = '2026-05-25'

/** A short, non-blocking guided example: one real anomaly, from "what's normal" to "what explains it". */
export default function Story({ series, loading, controls, onClose }: Props) {
  const [step, setStep] = useState(0)
  const events = series?.stats?.events ?? []
  const ev = events.find((e) => e.start === HERO_START) ?? events.find((e) => e.direction === 'below') ?? null
  const prior = ev?.prior_precip_pct

  const steps: { title: string; body: string; enter: () => void }[] = [
    {
      title: 'Santa Rosa, a tropical dry forest',
      body: 'Guanacaste, Costa Rica. This forest browns every dry season (December to April) and greens up when the rains arrive in May. That yearly swing is normal, so a simple "greenness dropped" alarm would fire every year.',
      enter: () => { controls.endCompare(); controls.openPlace(); controls.showTab('overview') },
    },
    {
      title: "What's normal here",
      body: 'The green line is greenness (NDVI) every 16 days since 2017. The grey band is the normal range for each time of year, built from the other years. Dips inside the band are just dry seasons. Faint grey dots are cloudy measurements, shown but never used.',
      enter: () => controls.showTab('charts'),
    },
    {
      title: ev ? `${prettyDate(ev.start)}: outside the normal range` : 'Finding the unusual',
      body: ev
        ? `Greenness was ${ev.mean_ndvi.toFixed(2)} when about ${ev.mean_expected.toFixed(2)} is normal for that time of year. ${Math.round(ev.good_fraction * 100)}% of the pixels were rated good by NASA's quality flags, so this isn't cloud.`
        : loading ? 'Loading the satellite record…' : 'No flagged events in this period.',
      enter: () => { controls.showTab('anomalies'); if (ev) controls.focusEvent(ev.start) },
    },
    {
      title: 'Checking the evidence',
      body: ev
        ? `${prior != null && prior < -20 ? `Rainfall was ${Math.abs(Math.round(prior))}% below normal in the month before, and ` : ''}late May is when this forest normally greens up fast. EarthOS checks rain, heat, burned area and land cover: here the data point to a late start of the rainy season. They don't support fire or clearing, and greenness was back to normal by June.`
        : 'Each flag lists its quality checks and which drivers the weather, fire and land-cover data support or rule out.',
      enter: () => { controls.showTab('anomalies'); if (ev) controls.focusEvent(ev.start) },
    },
    {
      title: 'See it from space',
      body: 'Left: the same weeks a year earlier. Right: late May 2026. Drag the white divider to compare. The vegetation-greenness layer comes from the same NASA product as the charts.',
      enter: () => { if (ev) controls.compareEvent(ev) },
    },
    {
      title: 'Your turn',
      body: 'Search any place or click the globe. The five Costa Rica places are pre-loaded and open instantly; anywhere else, the first visit takes a minute or two while NASA responds. The Methods page explains every rule.',
      enter: () => {},
    },
  ]
  const s = steps[step]

  // Run the step's action when it opens, and again once the data arrive (the event isn't known before).
  useEffect(() => {
    s.enter()
  }, [step, ev?.start]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="story" role="dialog" aria-label="Guided example">
      <header>
        <span>Guided example · {step + 1} of {steps.length}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close guided example">✕</button>
      </header>
      <h3>{s.title}</h3>
      <p>{s.body}</p>
      <div className="story-progress" aria-hidden>
        {steps.map((_, i) => <i key={i} className={i <= step ? 'on' : ''} />)}
      </div>
      {/* Fixed-width buttons in fixed places, so "Next" never moves between steps. */}
      <footer>
        <button className="btn" onClick={() => setStep(step - 1)} disabled={step === 0}>Back</button>
        <button className="btn primary" onClick={() => (step === steps.length - 1 ? onClose() : setStep(step + 1))}>
          {step === steps.length - 1 ? 'Explore' : 'Next'}
        </button>
      </footer>
    </aside>
  )
}
