import { api, type BacktestScore, type SuscValidation, type TriggerRule } from '../api'
import SuscValidationTable from '../components/SuscValidationTable'
import { linkProps } from '../router'
import { useFetch } from '../useFetch'
import PageShell from './PageShell'

// Everything numeric on this page comes from /api/methods, i.e. from screening.toml, explain.toml and the code
// itself, so the page can't drift from what the server actually does.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface MethodsInfo {
  config: any
  provenance: Record<string, { origin: string; note: string }>
  explain_thresholds: any
  anomaly: { z: number; min_deviation: number; trust_good: number; trust_usable: number; trust_cloudy: number; sigma_floor: number; threshold_drop: number }
  pilot: { name: string; lat: number; lon: number; half_km: number }
  susceptibility_validation: SuscValidation
  ranking_sensitivity: { weight_change: number; by_kind: Record<string, { top: number; perturbations: number; min_kept: number; mean_kept: number }>; method: string; forest_loss_included: boolean }
  backtest: { period: [string, string]; scores: BacktestScore[]; blocks: any[]; baselines: any; min_events_for_rate: number; error?: string }
  false_flag_rate: { years: [number, number]; draws_per_place: number; null: { events_per_point_year: number }; real: { events_per_point_year: number }; places: any[]; method: string; generated: string } | null
  catalogs: Record<string, { built: string; source: string }>
}

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`)
const ci = (c: [number, number] | null | undefined) => (c ? ` (95% CI ${pct(c[0])}–${pct(c[1])})` : '')
const LABEL: Record<string, string> = { fc24: 'forecast 24 h', fc72: 'forecast 72 h', ante7: 'last 7 days', soil: 'soil wetness' }
const rule = (r: TriggerRule) => Object.entries(r).map(([k, v]) => `${LABEL[k] ?? k} ≥ ${k === 'soil' ? v : `${v} mm`}`).join(' and ')

export default function Methods() {
  const m = useFetch<MethodsInfo>('methods', (s) => fetch(api.url('/api/methods'), { signal: s }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }))
  const M = m.data
  const c = M?.config
  const x = (f: (c: any) => unknown) => (c ? String(f(c)) : '…')
  const bt = M?.backtest
  const ff = M?.false_flag_rate
  return (
    <PageShell>
      <article className="doc">
        <h1>Methods</h1>
        <p className="lead">How EarthOS turns satellite measurements into screening layers, flags and explanations, and where it can go wrong.</p>
        <p className="note"><b>Screening tool, not an official warning.</b> For warnings and evacuation orders, follow the national services (in Costa Rica: CNE and IMN). Every number on this page is read live from the server's config files (<code>screening.toml</code>, <code>explain.toml</code>) and code.</p>
        {m.error && <p className="note">Couldn't load the live values ({m.error}); numbers show as "…".</p>}

        <h2>What is validated, and what isn't</h2>
        <ul>
          <li><b>Rainfall trigger (pilot only):</b> backtested against reported landslides with confidence intervals and two baselines (below). It beats random alert days but does no better than a rain-only threshold at the same alert frequency.</li>
          <li><b>Susceptibility map:</b> checked against only {M ? M.susceptibility_validation.events_usable : '…'} located landslides in the pilot area, which is far too few to call it validated.</li>
          <li><b>Vegetation anomaly detector:</b> false-flag rate estimated on synthetic undisturbed series (below); no labelled-event evaluation yet.</li>
          <li><b>Forest-loss watch and before/after checks:</b> not independently validated. Patches have not been checked against imagery or on the ground.</li>
          <li><b>Field validation with local experts:</b> not done yet. The field-sheet workflow exists for it.</li>
          <li><b>Other places:</b> thresholds and weights were set for the Santa Ana pilot and are labelled "uncalibrated here" elsewhere.</li>
        </ul>

        <h2>Validation results (pilot: {M?.pilot.name ?? '…'})</h2>
        <h3>Rainfall trigger backtest</h3>
        {bt && !bt.error ? (
          <>
            <div className="bt-table-wrap">
              <table className="bt-table">
                <thead><tr><th>Level</th><th>Hit rate</th><th>Random days, same count</th><th>Rain-only rule, same count</th><th>Alerts with no catalogued landslide</th></tr></thead>
                <tbody>
                  {bt.scores.map((s) => {
                    const b = bt.baselines[s.level]
                    return (
                      <tr key={s.level}>
                        <td>{s.level === 'watch' ? 'Elevated or High' : 'High only'}</td>
                        <td className="num">{s.hits}/{s.events} = {pct(s.hit_rate)}{ci(s.hit_rate_ci)}</td>
                        <td className="num">{b?.random ? `${pct(b.random.hit_rate_mean)} (95% of draws ${pct(b.random.hit_rate_95[0])}–${pct(b.random.hit_rate_95[1])})` : '–'}</td>
                        <td className="num">{b?.rain_only ? `≥ ${b.rain_only.threshold_mm} mm: ${pct(b.rain_only.hit_rate)}` : '–'}</td>
                        <td className="num">{s.no_event_alerts}/{s.alert_episodes}{ci(s.no_event_alert_rate_ci)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted">Period {bt.period[0]} to {bt.period[1]}; n = landslide days. Details, earlier/later blocks and every missed event: <a {...linkProps('/backtest')}>backtest page</a>.</p>
          </>
        ) : <p className="muted">{bt?.error ?? 'Loading…'}</p>}
        <h3>Susceptibility vs past landslide locations</h3>
        {M ? <SuscValidationTable v={M.susceptibility_validation} /> : <p className="muted">Loading…</p>}
        <h3>Vegetation anomaly detector: false flags</h3>
        {ff ? (
          <p>
            On synthetic series with no disturbance (each featured place's own seasonal curve plus its own noise, {ff.draws_per_place} draws per place,
            {' '}{ff.years[0]}–{ff.years[1]}), the detector produced <b>{ff.null.events_per_point_year} false events per point per year</b> (about one every
            {' '}{ff.null.events_per_point_year ? Math.round(1 / ff.null.events_per_point_year) : '∞'} years; {Math.min(...ff.places.map((p: any) => p.null_events_per_year))}–{Math.max(...ff.places.map((p: any) => p.null_events_per_year))} by place).
            {' '}Independent noise ignores autocorrelation, so treat this as a lower bound. On the real records it flagged {ff.real.events_per_point_year} events per point per year,
            which includes real anomalies (an upper bound). Computed {ff.generated} by <code>python -m scripts.flag_rate</code>.
          </p>
        ) : <p className="muted">Not computed yet.</p>}
        <h3>Stability of the "where to inspect first" ranking</h3>
        {M ? (
          <p>
            {Object.entries(M.ranking_sensitivity.by_kind).map(([k, r]) => `${k === 'slope' ? 'Slopes' : 'Stream corridors'}: at least ${r.min_kept} of the top ${r.top} stay in the top ${r.top} (mean ${r.mean_kept})`).join('; ')}
            {' '}when any one weight changes by ±{M.ranking_sensitivity.weight_change * 100}%.{!M.ranking_sensitivity.forest_loss_included && ' (The forest-loss result wasn\'t ready, so that weight had no effect in this run.)'} It is a prioritisation aid for field checks, not a hazard map.
          </p>
        ) : <p className="muted">Loading…</p>}

        <h2>A. Hazard screening (landslides and flash floods)</h2>
        <h3>A1. Susceptibility</h3>
        <ul>
          <li><b>Area:</b> a square around the clicked point, half-width {x((c) => c.area.default_half_km)} km by default ({M ? `${M.pilot.half_km} km` : '…'} for the pilot), on a {x((c) => c.area.grid_arcsec)} arc-second (~31 m) grid with {x((c) => c.area.buffer_km)} km of extra terrain around it. Results describe that box, not a municipality.</li>
          <li><b>Terrain:</b> elevation from Terrain Tiles (Terrarium, mostly SRTM 1 arc-second in Costa Rica), sampled bilinearly. Slope by Horn's method.</li>
          <li><b>Drainage and HAND:</b> pits filled and flow routed with priority-flood (Barnes et al. 2014); cells draining at least {x((c) => c.susceptibility.stream_area_km2)} km² are drainage lines; HAND is each cell's height above the drainage cell it flows to (Rennó et al. 2008; Nobre et al. 2011). Where water leaves the box before reaching a drainage line, HAND is unknown and the cell is "unassessed" (never "lower").</li>
          <li><b>Land cover:</b> ESA WorldCover 10 m 2021.</li>
          <li><b>Landslide points</b> from slope (breaks at {x((c) => c.susceptibility.slope_breaks_deg.join(', '))}°: 0–3 points), adjusted on slopes ≥ {x((c) => c.susceptibility.slope_breaks_deg[0])}° by land cover ({c ? Object.entries(c.susceptibility.landcover_points).filter(([, v]) => v).map(([k, v]) => `${k} ${(v as number) > 0 ? '+' : ''}${v}`).join(', ') : '…'}). <b>Flood points</b> from HAND (breaks at {x((c) => c.susceptibility.hand_breaks_m.join(', '))} m: 3–0 points).</li>
          <li><b>Classes:</b> each hazard has its own class (medium from {x((c) => c.susceptibility.medium_from)}, high from {x((c) => c.susceptibility.high_from)} points); the combined class takes the larger. The map can show landslide, flood or combined.</li>
          <li><b>Uncertainty:</b> the class is recomputed with slope ±{x((c) => c.susceptibility.slope_error_deg)}°, HAND ±{x((c) => c.susceptibility.hand_error_m)} m and the land-cover adjustment ±{x((c) => c.susceptibility.landcover_error_points)}; cells whose class changes are marked uncertain (paler on the map).</li>
          <li><b>Wording:</b> the lowest class is always "lower susceptibility, not safe". It ranks places relative to each other; it is not a probability.</li>
        </ul>
        <h3>A2. Slope forest-loss watch</h3>
        <ul>
          <li><b>Data:</b> NASA HLS Vegetation Indices v2.0 NDVI at 30 m (Landsat 8/9 and Sentinel-2), found through NASA's CMR catalogue.</li>
          <li><b>Cloud mask:</b> HLS Fmask bits {x((c) => c.forest_loss.fmask_reject_bits.join(', '))} (cloud, adjacent, shadow, snow/ice, water) are removed; scenes over {x((c) => c.forest_loss.max_scene_cloud_pct)}% tile cloud are skipped.</li>
          <li><b>Comparison:</b> per pixel, the median clear NDVI of the last {x((c) => c.forest_loss.recent_days)} days against the median of the same weeks (±{x((c) => c.forest_loss.baseline_pad_days)} days) in up to {x((c) => c.forest_loss.baseline_years)} prior years; at least {x((c) => c.forest_loss.min_recent_obs)} recent and {x((c) => c.forest_loss.min_baseline_obs)} baseline clear views.</li>
          <li><b>Flag:</b> NDVI fell by at least {x((c) => c.forest_loss.ndvi_drop)} and {x((c) => Math.abs(c.forest_loss.robust_z))} robust sigmas, on slopes over {x((c) => c.forest_loss.min_slope_deg)}°, in patches of at least {x((c) => c.forest_loss.min_patch_ha)} ha. Label: "Possible vegetation loss, cause unconfirmed". <b>Not independently validated</b>: crops, harvest, drought and missed cloud can look the same.</li>
        </ul>
        <h3>A3. Rainfall trigger</h3>
        <ul>
          <li><b>Inputs:</b> forecast rain for the next 24 and 72 h (MET Norway), observed rain over the last 7 available days and root-zone soil wetness (NASA POWER; ~50 km cells, a few days behind). The days between the last observation and today are counted by neither source; the panel says how many.</li>
          <li><b>"Elevated rainfall"</b> (config key <code>watch</code>) if any of: {c ? c.trigger.watch.map(rule).join('; or ') : '…'}.</li>
          <li><b>"High rainfall"</b> (<code>warning</code>) if any of: {c ? c.trigger.warning.map(rule).join('; or ') : '…'}.</li>
          <li>If an input a rule needs is missing (e.g. the forecast service is down) and nothing fires, the result is <b>"could not be evaluated"</b>, never "no trigger".</li>
          <li>Set by judgment for the Santa Ana pilot; not official criteria, not validated elsewhere. The names avoid "Watch"/"Warning", which official services use.</li>
        </ul>
        <h3>A4. Backtest</h3>
        <ul>
          <li>Rules replayed for every day since {x((c) => c.backtest.start_year)} with observed rain standing in for the forecast (a perfect-forecast hindcast); compared with rain-triggered landslides within {x((c) => c.backtest.radius_km)} km (NASA Global Landslide Catalog 2007–2017 export, plus documented local reports). Reports on the same day count as one.</li>
          <li><b>Hit rate</b> = landslide days with an alert within ±{x((c) => c.backtest.match_days)} day ÷ all; <b>alerts with no catalogued landslide</b> = alert episodes with none within ±{x((c) => c.backtest.match_days)} day ÷ all episodes (an upper bound on false alarms). 95% Wilson intervals; rates from fewer than {x((c) => c.backtest.min_events_for_rate)} events greyed out.</li>
          <li>Baselines at the same alert frequency: random days ({x((c) => c.backtest.baseline_draws)} seeded draws) and a rain-only threshold. Earlier (before {x((c) => c.backtest.split_year)}) and later blocks are reported separately; the thresholds weren't fitted, and any future tuning must use only the earlier block.</li>
        </ul>
        <h3>A5. Where to inspect first</h3>
        <ul>
          <li>{x((c) => c.priority.block_m)} m squares holding at least {x((c) => c.priority.min_site_ha)} ha of high susceptibility; slopes (L…) and stream corridors (F…) ranked separately.</li>
          <li>Score = {c ? Object.entries(c.priority.weights).map(([k, w]) => `${w} × ${k.replace('_', ' ')}`).join(' + ') : '…'}. Exposure = built-up share within {x((c) => c.priority.exposure_radius_m)} m (× 2, capped at 1); recent loss = a forest-loss patch within {x((c) => c.priority.loss_radius_m)} m; history = a landslide located to 1 km or better within {x((c) => c.priority.history_radius_m)} m.</li>
          <li>Rain over the last 30 days is reported for the area only (~50 km data can't separate squares).</li>
        </ul>
        <h3>A6. Natural hazards near a place, and A7. before/after checks</h3>
        <ul>
          <li>Cyclones (NOAA IBTrACS, catalogue built {M?.catalogs.ibtracs?.built ?? '…'}), tornadoes (NOAA SPC, US only, built {M?.catalogs.spc_tornadoes?.built ?? '…'}), earthquakes (USGS), EONET events and landslides (GLC, built {M?.catalogs.glc_events?.built ?? '…'}). Catalogues list what was reported.</li>
          <li>Before/after: median clear 30 m HLS views before vs after an event; NDVI drop (wind, tornado, landslide), NBR drop ≥ 0.27 (burn scars; Key &amp; Benson 2006) or NDWI rise ≥ 0.2 (water; threshold by judgment). Labelled "Change after [date], cause unconfirmed"; not independently validated.</li>
        </ul>

        <h2>B. Vegetation anomalies</h2>
        <ul>
          <li><b>Data:</b> MODIS/Terra MOD13Q1 v061 NDVI, 16-day composites at 250 m since 2000 (ORNL DAAC web service), averaged over a small box around the pin.</li>
          <li><b>Quality control:</b> a composite is trusted when ≥ {M ? pct(M.anomaly.trust_good) : '…'} of pixels are rated good, or ≥ {M ? pct(M.anomaly.trust_usable) : '…'} usable and ≤ {M ? pct(M.anomaly.trust_cloudy) : '…'} cloudy; untrusted composites are drawn but never used or flagged.</li>
          <li><b>Normal:</b> leave-one-year-out median of the same and neighbouring 16-day slots; σ = 1.4826 × MAD with a floor of {M?.anomaly.sigma_floor ?? '…'}.</li>
          <li><b>Flags:</b> trusted composites with |z| ≥ {M?.anomaly.z ?? '…'} and at least {M?.anomaly.min_deviation ?? '…'} NDVI from the median; consecutive flags form an event. The threshold method (drop ≥ {M?.anomaly.threshold_drop ?? '…'}) is shown only for comparison.</li>
          <li><b>Explanations:</b> drivers (drought, green-up timing, heat, fire, land-cover change, data artifact) rated supported / possible / not supported with thresholds in <code>explain.toml</code>. Drought, green-up, wet and flood drivers read the same rainfall statistics, so they are <b>not independent</b> evidence. Always "consistent with", never "caused by".</li>
        </ul>

        <h2>Where these numbers come from</h2>
        <p className="muted">"Judgment" means chosen by the author, not fitted and not from the literature. Nothing was fitted to the validation events.</p>
        <div className="bt-table-wrap">
          <table className="bt-table">
            <thead><tr><th>Parameter</th><th>Origin</th><th>Note</th></tr></thead>
            <tbody>
              {M && Object.entries(M.provenance).map(([k, p]) => (
                <tr key={k}><td><code>{k}</code></td><td>{p.origin}</td><td>{p.note}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Limitations</h2>
        <ul>
          <li><b>No geology or soil:</b> landslide susceptibility uses slope, drainage and land cover only. Lithology and soil depth, which drive landslide behaviour, are missing; this is the biggest conceptual limit of the map.</li>
          <li><b>Land cover only on steep ground:</b> the land-cover adjustment applies only to slopes ≥ 15°, so impervious surfaces don't raise flood susceptibility on flat ground.</li>
          <li><b>Mixed resolutions:</b> terrain ~30 m, HLS 30 m, land cover 10 m (2021), MODIS NDVI 250 m (16-day), rain ~50 km (daily, a few days behind). A 0.5 ha patch next to a 50 km rain number should not be over-read.</li>
          <li><b>30 m terrain misses</b> cuts, retaining walls, drains and fills that often decide where slopes fail.</li>
          <li><b>Catalogues are incomplete:</b> the landslide catalogue export ends in 2017 and only lists events that made the news.</li>
          <li><b>Cloud:</b> persistent cloud (e.g. Osa Peninsula) leaves long gaps in optical data.</li>
          <li><b>Speed:</b> outside the pre-loaded places, the first look at a place downloads its satellite record (1–3 minutes).</li>
        </ul>

        <h2>Sources</h2>
        <ul className="refs">
          <li>Didan, K. (2021). MOD13Q1 v061. NASA LP DAAC. doi:10.5067/MODIS/MOD13Q1.061</li>
          <li>Giglio, L. et al. (2021). MCD64A1 v061. doi:10.5067/MODIS/MCD64A1.061</li>
          <li>Friedl, M., Sulla-Menashe, D. (2022). MCD12Q1 v061. doi:10.5067/MODIS/MCD12Q1.061</li>
          <li>NASA LaRC POWER Project, daily weather (MERRA-2 based).</li>
          <li>NASA HLS v2.0 and HLS Vegetation Indices v2.0: doi:10.5067/HLS/HLSL30_VI.002, doi:10.5067/HLS/HLSS30_VI.002. Contains modified Copernicus Sentinel data.</li>
          <li>Zanaga, D. et al. (2022). ESA WorldCover 10 m 2021 v200. doi:10.5281/zenodo.7254221 (CC BY 4.0).</li>
          <li>Terrain Tiles on AWS (Mapzen/Tilezen), mostly SRTM (NASA/USGS) in Costa Rica.</li>
          <li>Barnes, R., Lehman, C., Mulla, D. (2014). Priority-flood. Computers &amp; Geosciences 62:117–127.</li>
          <li>Rennó, C. D. et al. (2008). HAND. Remote Sensing of Environment 112:3469–3481; Nobre, A. D. et al. (2011). J. Hydrology 404:13–29.</li>
          <li>Kirschbaum, D. et al. (2010). Natural Hazards 52:561–575; Kirschbaum, Stanley &amp; Zhou (2015). Geomorphology 249:4–15 (Global Landslide Catalog).</li>
          <li>MET Norway Locationforecast 2.0 (CC BY 4.0).</li>
          <li>Knapp, K. R. et al. (2010). IBTrACS. BAMS 91:363–376; Gahtan, J. et al. (2024). IBTrACS v04r01. doi:10.25921/82ty-9e16</li>
          <li>NOAA/NWS Storm Prediction Center, Severe Weather Database; U.S. Geological Survey, ComCat.</li>
          <li>Key, C. H., Benson, N. C. (2006). Landscape Assessment (dNBR). USDA Forest Service RMRS-GTR-164-CD.</li>
          <li>McFeeters, S. K. (1996). NDWI. Int. J. Remote Sensing 17:1425–1432.</li>
          <li>Wilson, E. B. (1927). Probable inference... J. Am. Stat. Assoc. 22:209–212 (confidence intervals).</li>
          <li>CNE: Informe técnico, deslizamiento Tapezco (2018), via the Municipalidad de Santa Ana open-data portal.</li>
        </ul>
        <p><a {...linkProps('/explore')}>Open the explorer →</a></p>
      </article>
    </PageShell>
  )
}
