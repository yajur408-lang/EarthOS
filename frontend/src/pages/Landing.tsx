import { linkProps } from '../router'
import PageShell from './PageShell'

const gibsNdvi = (date: string) =>
  'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1' +
  '&LAYERS=MODIS_Terra_L3_NDVI_16Day&STYLES=&FORMAT=image/png&TRANSPARENT=FALSE&SRS=EPSG:4326' +
  `&BBOX=-86.0,10.25,-85.0,11.25&WIDTH=512&HEIGHT=512&TIME=${date}`

const FEATURED = [
  { id: 'guanacaste', name: 'Santa Rosa, Guanacaste', lat: 10.84, lon: -85.62, text: 'Tropical dry forest. In 2026 the rainy-season green-up came weeks late.' },
  { id: 'tempisque', name: 'Tempisque basin', lat: 10.35, lon: -85.35, text: 'Sugarcane and rice - harvests make greenness drop sharply each year.' },
  { id: 'san-carlos', name: 'San Carlos plains', lat: 10.55, lon: -84.3, text: 'Pineapple and pasture frontier in the northern lowlands.' },
  { id: 'osa', name: 'Corcovado, Osa Peninsula', lat: 8.54, lon: -83.59, text: 'Rainforest under near-constant cloud - a hard test for satellites.' },
  { id: 'chirripo', name: 'Chirripó highlands', lat: 9.48, lon: -83.49, text: 'Montane forest and páramo up to 3,800 m.' },
]

export default function Landing() {
  return (
    <PageShell>
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">Open NASA satellite data · Costa Rica showcase</p>
          <h1>See how vegetation changes, and check why.</h1>
          <p className="lead">
            EarthOS compares every 16-day satellite measurement of greenness with what's normal for that place and season,
            flags the unusual ones only when the data are clean, and lays out the rain, heat, fire and land-cover evidence
            for each.
          </p>
          <div className="cta">
            <a className="btn-lg primary" {...linkProps('/explore?story=santa-rosa')}>Follow the Santa Rosa story</a>
            <a className="btn-lg" {...linkProps('/explore')}>Open the globe</a>
          </div>
        </div>
        <figure className="hero-figure">
          <div className="pair">
            <div><img src={gibsNdvi('2025-05-25')} alt="Vegetation greenness over Guanacaste, late May 2025" loading="eager" /><span>Late May 2025</span></div>
            <div><img src={gibsNdvi('2026-05-25')} alt="Vegetation greenness over Guanacaste, late May 2026 - visibly paler" loading="eager" /><span>Late May 2026</span></div>
          </div>
          <figcaption>
            Guanacaste, Costa Rica, at the same time of year. In 2026 greenness at Santa Rosa was 0.62 against a normal of 0.86, after
            rainfall 43% below normal in the preceding month. Imagery: NASA GIBS, MODIS 16-day NDVI.
          </figcaption>
        </figure>
      </section>

      <section className="steps">
        <h2>How it works</h2>
        <ol>
          <li><b>Measure.</b> NASA's MODIS satellites record vegetation greenness (NDVI) every 16 days at 250 m, back to 2000.</li>
          <li><b>Compare with normal.</b> Each measurement is compared with the same weeks in every other year, so ordinary dry seasons aren't mistaken for damage.</li>
          <li><b>Check the data.</b> Cloudy or low-quality measurements are shown but never flagged. Each flag lists the quality checks it passed.</li>
          <li><b>Weigh the evidence.</b> Rainfall, temperature, burned area and land cover are checked against each flag, saying what the data are consistent with, and what they rule out.</li>
        </ol>
      </section>

      <section className="places">
        <h2>Start with Costa Rica</h2>
        <p className="muted">These places are pre-loaded, so they open instantly. Anywhere else on Earth works too - the first visit takes a minute or two while NASA's servers respond.</p>
        <div className="place-grid">
          {FEATURED.map((p) => (
            <a key={p.id} className="place" {...linkProps(`/explore#lat=${p.lat}&lon=${p.lon}&km=1`)}>
              <b>{p.name}</b>
              <span>{p.text}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="trust">
        <div>
          <h3>Open data, cited</h3>
          <p>NASA MODIS, Landsat/Sentinel-2 (HLS) and POWER weather data. Every chart and claim names its source; downloads keep the credits.</p>
        </div>
        <div>
          <h3>Quality first</h3>
          <p>MODIS pixel-quality flags decide which measurements count. A cloudy composite can't raise an alarm.</p>
        </div>
        <div>
          <h3>Evidence, not verdicts</h3>
          <p>Explanations say what the data are consistent with and list what's missing. They don't claim cause. <a {...linkProps('/methods')}>Read the methods</a>.</p>
        </div>
      </section>
    </PageShell>
  )
}
