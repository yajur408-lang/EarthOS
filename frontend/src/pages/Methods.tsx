import { linkProps } from '../router'
import PageShell from './PageShell'

export default function Methods() {
  return (
    <PageShell>
      <article className="doc">
        <h1>Methods</h1>
        <p className="lead">How EarthOS turns satellite measurements into screening layers, flags and explanations, and where it can go wrong.</p>
        <p className="note"><b>Screening tool, not an official warning.</b> For warnings and evacuation orders, follow the national services (in Costa Rica: CNE and IMN). All thresholds below live in one file on the server (<code>backend/app/screening/screening.toml</code>).</p>

        <h2>A. Hazard screening (landslides and flash floods)</h2>
        <h3>A1. Susceptibility</h3>
        <ul>
          <li><b>Grid:</b> a square around the place (Santa Ana: 12 × 12 km; elsewhere 6 × 6 km by default) on a 1 arc-second (~31 m) grid, with an extra 1.5 km of terrain around it so drainage routing doesn't stop at the edge.</li>
          <li><b>Terrain:</b> elevation from Terrain Tiles (Terrarium, mostly SRTM 1 arc-second in Costa Rica), sampled bilinearly. Slope by Horn's method.</li>
          <li><b>Drainage and HAND:</b> pits filled and flow routed with priority-flood (Barnes et al. 2014); cells draining at least 0.25 km² are drainage lines; HAND is each cell's height above the drainage cell it flows to (Rennó et al. 2008; Nobre et al. 2011).</li>
          <li><b>Land cover:</b> ESA WorldCover 10 m 2021.</li>
          <li><b>Points:</b> landslide points from slope (&lt;15°: 0, 15–25°: 1, 25–35°: 2, ≥35°: 3), adjusted on slopes ≥15° by land cover (tree −0.5, grass, crop or built +0.5, bare +1). Flood points from HAND (&lt;2 m: 3, 2–5 m: 2, 5–10 m: 1). The class uses the larger: medium from 1.5, high from 2.5.</li>
          <li><b>Uncertainty:</b> the class is recomputed with slope ±3°, HAND ±2 m and the land-cover adjustment ±0.5 (typical errors of these inputs). Cells whose class changes are marked uncertain (paler on the map, hatched in the bars).</li>
          <li><b>Wording:</b> the lowest class is always "lower susceptibility, not safe". The layer ranks places relative to each other; it is not a probability.</li>
        </ul>
        <h3>A2. Slope forest-loss watch</h3>
        <ul>
          <li><b>Data:</b> NASA HLS Vegetation Indices v2.0 NDVI at 30 m (HLSL30_VI from Landsat 8/9, HLSS30_VI from Sentinel-2), found through NASA's CMR catalogue.</li>
          <li><b>Cloud mask (QA):</b> the HLS Fmask band. Pixels flagged cloud, adjacent to cloud or shadow, cloud shadow, snow/ice or water are removed; scenes with more than 80% tile cloud are skipped.</li>
          <li><b>Comparison:</b> per pixel, the median clear NDVI of the last 90 days against the median of the same weeks (±15 days) in up to 5 prior years. A pixel needs at least 2 recent and 3 baseline clear views to be judged.</li>
          <li><b>Flag:</b> NDVI fell by at least 0.15 and at least 2 robust sigmas (1.4826 × MAD, floor 0.03), on a slope over 15°. Flagged pixels are joined into 8-connected patches; patches under 0.5 ha are dropped.</li>
          <li><b>Label:</b> every patch reads "Possible vegetation loss, cause unconfirmed", with the date range, cloud mask and number of baseline years. Clearing, a landslide, fire, harvest, drought and missed cloud all lower NDVI.</li>
        </ul>
        <h3>A3. Rainfall trigger</h3>
        <ul>
          <li><b>Inputs:</b> forecast rain for the next 24 and 72 h (MET Norway), observed rain over the last 7 available days and root-zone soil wetness (NASA POWER; about 50 km cells, a few days behind).</li>
          <li><b>Rules:</b> "Elevated rainfall" (config key <code>watch</code>) if forecast 24 h ≥ 50 mm, or 72 h ≥ 80 mm, or (last 7 days ≥ 100 mm and soil wetness ≥ 0.75 and forecast 24 h ≥ 25 mm). "High rainfall" (<code>warning</code>) at 90 mm, 150 mm, or (150 mm, 0.80, 50 mm). These are starting values set for the Santa Ana pilot, not official criteria and not validated elsewhere. The names avoid "Watch" and "Warning", which official services use.</li>
          <li>The days between the last observed day and today are counted by neither source; the panel says how many.</li>
        </ul>
        <h3>A4. Backtest</h3>
        <ul>
          <li>The same rules are replayed for every day since 2001 with observed rain standing in for the forecast (a "perfect-forecast hindcast"), and compared with landslides reported within 25 km: NASA's Global Landslide Catalog (2007–2017 export) and local reports such as the CNE's Tapezco 2018 report.</li>
          <li><b>Hit rate</b> = rain-triggered landslides with an alert within ±1 day ÷ all of them. <b>False-alarm rate</b> = alert episodes with no landslide reported within ±1 day ÷ all alert episodes.</li>
          <li>Catalogues only include landslides that made the news, so some "false alarms" are probably unreported slides; real forecasts are less accurate than observed rain, so real hit rates would be lower. <a {...linkProps('/backtest')}>See the backtest</a>.</li>
        </ul>

        <h3>A5. Where to inspect first</h3>
        <ul>
          <li>The area is cut into 250 m squares; a square is listed if it holds at least 1 ha of high susceptibility. Slopes (landslides, L01…) and stream corridors (flash floods, F01…) are ranked separately because their scores aren't comparable.</li>
          <li>Score = 0.35 × susceptibility + 0.30 × buildings within 300 m (WorldCover built-up share × 2, capped at 1) + 0.15 × a forest-loss patch within 150 m + 0.10 × a reported landslide (located to 1 km or better) within 1 km + 0.10 × the share of the square that is high. Weights are in <code>screening.toml</code>.</li>
          <li>Rain over the last 30 days vs the same weeks in other years is reported for the whole area (NASA POWER cells are ~50 km, so it can't separate squares).</li>
          <li>The susceptibility map is checked against past landslides: the share of located landslides within 100 m of high or medium cells, compared with those classes' share of the area; landslides in "lower" cells are listed as missed.</li>
          <li>Field sheets (print, CSV, GeoJSON) carry the ranking and reasons; imported findings report signs seen per kind and in the top vs lower half of each list.</li>
        </ul>
        <h3>A6. Natural hazards near a place</h3>
        <ul>
          <li><b>Tropical cyclones:</b> NOAA IBTrACS 6-hourly best-track centres since 1980, within 200 km; the closest approach and the strongest winds within that radius (Saffir-Simpson category from the wind speed).</li>
          <li><b>Tornadoes:</b> NOAA Storm Prediction Center paths since 1950 (United States only), within 40 km of the straight start-end path, with (E)F rating, length, width and reported casualties.</li>
          <li><b>Earthquakes:</b> USGS ComCat, magnitude 4.5+, within 150 km. <b>Wildfires, volcanoes, floods, storms, drought:</b> NASA EONET (about 2015 onwards), within 100 km. <b>Landslides:</b> as in the backtest.</li>
          <li>Catalogues list what was reported; an empty list doesn't mean nothing happened.</li>
        </ul>
        <h3>A7. Satellite before/after check</h3>
        <ul>
          <li>For an event since 2013, the median of clear 30 m HLS views in the weeks before is compared with the weeks after, per pixel, using the index that suits the hazard: <b>NDVI drop</b> (wind damage, tornado tracks, landslides, ash), <b>NBR drop of 0.27+</b> (burn scars; "moderate" in USGS/MTBS practice) or <b>NDWI rise of 0.2+</b> (standing water; water pixels are kept in the cloud mask for this check).</li>
          <li>A pixel needs the change and at least 2 robust sigmas of the pre-event variability; patches under 0.5 ha are dropped. Results read "Change after [date], cause unconfirmed": harvests, construction, seasons, irrigation and missed cloud can look the same.</li>
          <li>Live context layers from NASA GIBS: GOES and Himawari geostationary imagery, MODIS/VIIRS flood maps, OPERA surface water (optical and radar) and vegetation-disturbance alerts, and VIIRS night lights (outages).</li>
        </ul>

        <h2>B. Vegetation anomalies</h2>

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
          <li>HLS Vegetation Indices v2.0: doi:10.5067/HLS/HLSL30_VI.002, doi:10.5067/HLS/HLSS30_VI.002.</li>
          <li>Zanaga, D. et al. (2022). ESA WorldCover 10 m 2021 v200. doi:10.5281/zenodo.7254221 (CC BY 4.0).</li>
          <li>Terrain Tiles on AWS (Mapzen/Tilezen), mostly SRTM (NASA/USGS) in Costa Rica.</li>
          <li>Barnes, R., Lehman, C., Mulla, D. (2014). Priority-flood. Computers &amp; Geosciences 62:117–127.</li>
          <li>Rennó, C. D. et al. (2008). HAND. Remote Sensing of Environment 112:3469–3481; Nobre, A. D. et al. (2011). J. Hydrology 404:13–29.</li>
          <li>Kirschbaum, D. et al. (2010). Natural Hazards 52:561–575; Kirschbaum, Stanley &amp; Zhou (2015). Geomorphology 249:4–15 (Global Landslide Catalog).</li>
          <li>MET Norway Locationforecast 2.0 (CC BY 4.0).</li>
          <li>Knapp, K. R. et al. (2010). IBTrACS. BAMS 91:363–376; Gahtan, J. et al. (2024). IBTrACS v04r01. NOAA NCEI. doi:10.25921/82ty-9e16</li>
          <li>NOAA/NWS Storm Prediction Center, Severe Weather Database (tornadoes, 1950 onwards).</li>
          <li>U.S. Geological Survey, ComCat earthquake catalogue.</li>
          <li>Key, C. H., Benson, N. C. (2006). Landscape Assessment (dNBR). USDA Forest Service RMRS-GTR-164-CD.</li>
          <li>McFeeters, S. K. (1996). The use of the Normalized Difference Water Index (NDWI). Int. J. Remote Sensing 17:1425–1432.</li>
          <li>CNE: Informe técnico, deslizamiento Tapezco (2018), via the Municipalidad de Santa Ana open-data portal.</li>
        </ul>
        <p><a {...linkProps('/explore')}>Open the explorer →</a></p>
      </article>
    </PageShell>
  )
}
