import { linkProps } from '../router'
import PageShell from './PageShell'

export default function Methods() {
  return (
    <PageShell>
      <article className="doc">
        <h1>Methods</h1>
        <p className="lead">How EarthOS turns satellite measurements into flags and explanations, and where it can go wrong.</p>

        <h2>1. Vegetation measurements</h2>
        <p>
          Greenness is NDVI from NASA's MODIS/Terra Vegetation Indices product (MOD13Q1 v061): one composite every 16 days at 250 m,
          from 2000 to today, read through the ORNL DAAC MODIS web service. EarthOS averages a small box around the pin
          (default 2.25 km square; a single pixel is possible).
        </p>

        <h2>2. Quality control</h2>
        <p>MOD13Q1 rates every pixel: good, marginal, snow/ice or cloudy. In cloudy tropics, "marginal" pixels often sit on cloud edges.</p>
        <ul>
          <li>If at least 30% of the box is rated <i>good</i>, only good pixels are averaged.</li>
          <li>A composite is <b>trusted</b> when ≥30% of pixels are good, or ≥80% are usable and ≤5% cloudy.</li>
          <li>Untrusted composites are drawn on the charts but never used for the normal range and never flagged.</li>
        </ul>
        <p className="note">
          Example: at Santa Rosa on 1 Nov 2022, 69% of pixels were cloudy and none were good; an earlier version of EarthOS flagged it as
          an extreme anomaly. It is now excluded.
        </p>

        <h2>3. What "normal" means</h2>
        <ul>
          <li>For each composite, the expected value is the median of the same and neighbouring 16-day periods in all <i>other</i> years (leave-one-year-out, about 27 values for a 10-year record).</li>
          <li>Spread σ = 1.4826 × median absolute deviation, with a floor of 0.03 NDVI, so very stable seasons can't turn small wobbles into huge scores. The grey band on the charts is median ± 2σ.</li>
          <li>The z-score says how many σ a value sits from the median. Beyond ±4σ, EarthOS just says "beyond 4σ": past that point the exact number isn't meaningful.</li>
        </ul>

        <h2>4. Flags</h2>
        <ul>
          <li><b>Seasonal flag:</b> a trusted composite with |z| ≥ 2 <i>and</i> at least 0.05 NDVI away from the median.</li>
          <li><b>Threshold flag</b> (the naive baseline, for comparison): NDVI fell by ≥ 0.10 since the previous trusted composite. It fires on every ordinary dry season, which is why EarthOS doesn't rely on it.</li>
          <li>Consecutive flags (allowing one cloudy gap) form an <b>event</b>.</li>
        </ul>

        <h2>5. Validation checks</h2>
        <p>Every event lists five checks, each pass or warn: share of good pixels, persistence (more than one composite), size of change (≥ 0.10 NDVI), cloud in neighbouring composites, and depth of the baseline. Confidence is high with no warnings, medium with one or two, and low otherwise.</p>

        <h2>6. Explanations</h2>
        <p>For each event, EarthOS tests candidate drivers against independent data and rates each <i>supported</i>, <i>possible</i> or <i>not supported</i>:</p>
        <ul>
          <li><b>Drought:</b> NASA POWER rainfall over the event and the month before, compared with the same weeks in other years.</li>
          <li><b>Late or early green-up:</b> the change falls where NDVI normally rises fast, with rain lagging or leading.</li>
          <li><b>Heat:</b> daily maximum temperature anomaly.</li>
          <li><b>Fire:</b> MODIS burned area (MCD64A1) during the event.</li>
          <li><b>Land-cover change:</b> persistence without recovery, plus change in MODIS land cover (MCD12Q1) between the years before and after.</li>
          <li><b>Data artifact:</b> few good pixels, a single composite, cloudy neighbours.</li>
        </ul>
        <p className="note">The summary always says "consistent with", never "caused by". Weather data are ~50 km grid cells; land cover lags 1–2 years; local knowledge and imagery should confirm any conclusion.</p>

        <h2>7. Sharp imagery</h2>
        <p>When you zoom in, EarthOS shows 30 m Landsat/Sentinel-2 imagery (NASA HLS) from the clearest pass near the date you've chosen. NASA's catalogue reports cloud cover per 110 km tile, so the spot you're viewing can still have clouds.</p>

        <h2>Limitations</h2>
        <ul>
          <li>250 m pixels average together fields, roads and forest edges.</li>
          <li>Persistent cloud (e.g. Osa Peninsula) leaves long gaps.</li>
          <li>Ten years is a short baseline for rare events.</li>
          <li>ORNL's service is slow on a first visit outside the pre-loaded places (1–3 minutes).</li>
        </ul>

        <h2>Sources</h2>
        <ul className="refs">
          <li>Didan, K. (2021). MOD13Q1 v061. NASA LP DAAC. doi:10.5067/MODIS/MOD13Q1.061</li>
          <li>Giglio, L. et al. (2021). MCD64A1 v061. doi:10.5067/MODIS/MCD64A1.061</li>
          <li>Friedl, M., Sulla-Menashe, D. (2022). MCD12Q1 v061. doi:10.5067/MODIS/MCD12Q1.061</li>
          <li>NASA LaRC POWER Project, daily weather (MERRA-2 based).</li>
          <li>NASA HLS v2.0 (HLSS30, HLSL30) via NASA GIBS. Contains modified Copernicus Sentinel data.</li>
        </ul>
        <p><a {...linkProps('/explore')}>Open the explorer →</a></p>
      </article>
    </PageShell>
  )
}
