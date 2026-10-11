import { api, type BacktestScore } from '../api'
import { linkProps } from '../router'
import { useFetch } from '../useFetch'
import PageShell from './PageShell'

const PREVIEW = api.url('/api/screening/preview.png?lat=9.915&lon=-84.19&half_km=6')

const FEATURED = [
  { id: 'santa-ana', name: 'Santa Ana (pilot)', href: '/explore?pilot=santa-ana', text: 'Landslide and flash-flood screening for the Escazú-Santa Ana hills.' },
  { id: 'guanacaste', name: 'Santa Rosa, Guanacaste', href: '/explore?story=santa-rosa', text: 'Vegetation anomalies: in 2026 the rainy-season green-up came weeks late.' },
  { id: 'tempisque', name: 'Tempisque basin', href: '/explore#lat=10.35&lon=-85.35&km=1', text: 'Sugarcane and rice - harvests make greenness drop sharply each year.' },
  { id: 'osa', name: 'Corcovado, Osa Peninsula', href: '/explore#lat=8.54&lon=-83.59&km=1', text: 'Rainforest under near-constant cloud - a hard test for satellites.' },
  { id: 'chirripo', name: 'Chirripó highlands', href: '/explore#lat=9.48&lon=-83.49&km=1', text: 'Montane forest and páramo up to 3,800 m.' },
]

interface MethodsSummary {
  susceptibility_validation?: { events_usable: number }
  backtest: { scores: BacktestScore[]; baselines: Record<string, { random?: { hit_rate_mean: number }; rain_only?: { hit_rate: number; threshold_mm: number } }> }
}

export default function Landing() {
  // One real result, read live from the server (the same numbers as /methods and /backtest).
  const m = useFetch<MethodsSummary>('landing-methods', (s) => fetch(api.url('/api/methods'), { signal: s }).then((r) => r.json()))
  const s = m.data?.backtest?.scores?.[0]
  const b = m.data?.backtest?.baselines?.watch
  const pct = (v?: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`)
  return (
    <PageShell>
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow"><span>Pilot · Santa Ana, Costa Rica</span> The layers run anywhere; thresholds are calibrated only for the pilot.</p>
          <h1>Landslide and flash-flood screening from open satellite data.</h1>
          <p className="lead">
            EarthOS maps which slopes and stream corridors are more susceptible, watches steep forest for possible loss, and
            checks rainfall against thresholds tested on past landslides. Every layer names its data and method.
          </p>
          <p className="for-whom"><b>For</b> schools, neighbourhood groups and municipal staff deciding which slopes and streams to inspect first.</p>
          <div className="truth">
            <div><b>Tested</b><span>Rainfall trigger vs {s ? s.events : '…'} past landslide days in the pilot area{s ? `: caught ${s.hits} of ${s.events} (${pct(s.hit_rate)}) vs ${pct(b?.random?.hit_rate_mean)} for random days in the same months, and the same as a plain rain-only rule` : ''}.</span></div>
            <div><b>Not yet tested</b><span>The susceptibility map (only {m.data?.susceptibility_validation?.events_usable ?? '…'} located landslides), the forest-loss watch, and field checks with local experts.</span></div>
          </div>
          <div className="cta">
            <a className="btn-lg primary" {...linkProps('/explore?pilot=santa-ana')}>Open the Santa Ana pilot</a>
            <a className="btn-lg" {...linkProps('/backtest')}>See the backtest</a>
          </div>
          <p className="screen-line"><b>Screening tool, not an official warning.</b> For alerts, follow the <a href="https://www.cne.go.cr" target="_blank" rel="noopener noreferrer">CNE</a> and <a href="https://www.imn.ac.cr/avisos" target="_blank" rel="noopener noreferrer">IMN</a>.</p>
        </div>
        <figure className="hero-figure">
          <img className="relief" src={PREVIEW} alt="Shaded relief of Santa Ana with susceptibility classes: red high, orange medium, faint yellow lower; blue drainage lines" loading="eager" />
          <figcaption>
            Santa Ana, 12 × 12 km. Red: high, orange: medium, faint yellow: lower susceptibility (not safe), from slope, height above the
            nearest drainage line and land cover. Paler = could change class within typical data error. Blue: drainage lines.
            Data: SRTM terrain (Terrain Tiles), ESA WorldCover 2021.
          </figcaption>
        </figure>
      </section>

      <section className="steps">
        <h2>Three layers, one test</h2>
        <ol>
          <li><b>Susceptibility.</b> Slope, height above the nearest stream and land cover give each 30 m cell a lower, medium or high class, with the cells whose class is uncertain marked.</li>
          <li><b>Slope forest-loss watch.</b> NASA HLS 30 m NDVI flags patches of 0.5 ha or more on slopes over 15° that are much less green than the same season in past years. Cause unconfirmed.</li>
          <li><b>Rainfall trigger.</b> Forecast rain, the last 7 days of rain and soil wetness give an Elevated or High rainfall level (screening levels, not official warnings). Thresholds sit in one config file.</li>
          <li><b>Backtest.</b> The same rules are replayed over 20+ years of daily rain and scored against reported landslides: hit rate and alerts with no catalogued landslide, shown openly.</li>
        </ol>
      </section>

      <section className="why">
        <h2>Why Santa Ana</h2>
        <div className="why-grid">
          <p>Santa Ana sits below the steep Escazú hills, where heavy rain on saturated soil has triggered deadly slides. NASA's Global Landslide Catalog lists the November 2010 Pico Blanco slide in neighbouring San Antonio de Escazú (23 deaths) and a slide on Calle Montoya in Salitral the month before.</p>
          <p>In September 2018 the national emergency commission (CNE) inspected a landslide in the upper Quebrada Pittier at Tapezco, Salitral. Its report is on the municipality's open-data portal.</p>
          <p>Official warnings come from the CNE and IMN. EarthOS adds a free, open screen that a school, a neighbourhood committee or a municipality can check and question, with every number traceable.</p>
        </div>
      </section>

      <section className="places">
        <h2>Explore</h2>
        <p className="muted">These places are pre-loaded, so they open instantly. Other places work too (click the globe, open the Hazards tab), but the rainfall thresholds and weights were set for Santa Ana and are not validated elsewhere; those results carry an "uncalibrated here" label.</p>
        <div className="place-grid">
          {FEATURED.map((p) => (
            <a key={p.id} className="place" {...linkProps(p.href)}>
              <b>{p.name}</b>
              <span>{p.text}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="trust">
        <div>
          <h3>Open data, cited</h3>
          <p>NASA HLS, MODIS and POWER, MET Norway forecasts, ESA WorldCover and SRTM terrain. Every layer names its source, method and limits.</p>
        </div>
        <div>
          <h3>Tested in the open</h3>
          <p>The rainfall thresholds are scored against past landslides, including the misses and the alerts with no catalogued landslide. <a {...linkProps('/backtest')}>See the backtest</a>.</p>
        </div>
        <div>
          <h3>No verdicts</h3>
          <p>"Lower susceptibility" never means safe, and vegetation loss is always "cause unconfirmed". <a {...linkProps('/methods')}>Read the methods</a>.</p>
        </div>
      </section>
    </PageShell>
  )
}
