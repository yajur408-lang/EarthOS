import { linkProps } from '../router'
import PageShell from './PageShell'

export default function About() {
  return (
    <PageShell>
      <article className="doc">
        <h1>About EarthOS</h1>
        <p className="lead">
          EarthOS is an independent project that makes NASA's vegetation record readable: what changed, how unusual it was, whether the
          data can be trusted, and what other evidence lines up.
        </p>

        <h2>Why</h2>
        <p>
          Satellite data about forests, farms and drylands is free, but turning it into an answer takes specialist tools. Simple
          "greenness dropped" alerts mistake every dry season for damage, and cloud makes tropical records noisy. EarthOS compares each
          place with its own normal season, filters out low-quality measurements, and checks each flag against independent data, then
          shows its working.
        </p>

        <h2>Research question</h2>
        <p>
          Can seasonal anomaly detection with quality control and multi-source evidence identify unusual vegetation change more reliably
          than simple threshold methods? The Costa Rica showcase is the first test region; the comparison between both methods is shown
          for every place.
        </p>

        <h2>What it isn't</h2>
        <p>
          EarthOS is not an early-warning or emergency system, and its explanations aren't proof of cause. Use it to find and understand
          changes worth a closer look.
        </p>

        <h2>Who</h2>
        <p>Built by Yajur Ojha.</p>

        <h2>Data and licences</h2>
        <p>
          All data come from open sources - mainly NASA - and keep their original licences and credits. The full list, with attribution
          requirements, is under "Data sources &amp; licences" in the explorer. See the <a {...linkProps('/methods')}>methods</a> for how the
          numbers are calculated.
        </p>
      </article>
    </PageShell>
  )
}
