import { linkProps } from '../router'
import PageShell from './PageShell'

export default function About() {
  return (
    <PageShell>
      <article className="doc">
        <h1>About EarthOS</h1>
        <p className="lead">
          EarthOS turns open satellite and weather data into a landslide and flash-flood screen that anyone can check, piloted in
          Santa Ana, Costa Rica. It also makes NASA's vegetation record readable: what changed, how unusual it was, whether the data
          can be trusted, and what other evidence lines up.
        </p>

        <h2>The Santa Ana pilot</h2>
        <p>
          Santa Ana's neighbourhoods climb into the steep Escazú hills. Heavy rain on saturated slopes has caused deadly landslides
          nearby, such as the 2010 Pico Blanco slide in San Antonio de Escazú, and stream corridors flood quickly. Official warnings come
          from the CNE and IMN; what is often missing locally is an open, explainable picture of <i>where</i> slopes and stream banks are
          more susceptible, <i>whether</i> steep forest has been lost, and <i>when</i> rain approaches levels that have coincided with
          past slides.
        </p>
        <p>
          EarthOS answers with three layers and one test: susceptibility, a slope forest-loss watch and a rainfall trigger, plus a
          backtest that scores the trigger against past landslides, misses and false alarms included. Everything runs on free, open
          data, so it costs little to keep running and can be repeated for any town.
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
          EarthOS is a screening tool, not an official warning. "Lower susceptibility" never means safe, vegetation loss is always "cause
          unconfirmed", and explanations aren't proof of cause. For warnings and evacuation orders, follow the national services.
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
