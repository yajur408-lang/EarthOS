# EarthOS

**Landslide and flash-flood screening from open satellite data, piloted in Santa Ana, Costa Rica, with honest validation.**

> **Screening tool, not an official warning.** For warnings and evacuation orders, follow the national services
> (in Costa Rica: [CNE](https://www.cne.go.cr) and [IMN](https://www.imn.ac.cr/avisos)).

**Live:** https://earthos-ishk.onrender.com · **Pilot:** [/explore?pilot=santa-ana](https://earthos-ishk.onrender.com/explore?pilot=santa-ana) ·
**Backtest:** [/backtest](https://earthos-ishk.onrender.com/backtest) · **Methods:** [/methods](https://earthos-ishk.onrender.com/methods)

<!-- TODO (owner): add a 20-40 s GIF of the Santa Ana pilot here: search, click, Hazards tab, backtest page. -->

For a chosen place, EarthOS maps which ~31 m cells are more susceptible to landslides (slope, land cover) and flash
floods (height above the nearest stream), watches steep forest for possible vegetation loss with 30 m NASA HLS imagery,
and checks rainfall against thresholds that were backtested on past landslides. It ranks 250 m squares to inspect first
and produces field sheets so local experts can check the results on the ground. Every layer names its data, date,
resolution and method. The thresholds were set for the Santa Ana pilot; elsewhere results are labelled "uncalibrated here".

### What is validated

- The **rainfall trigger** for the pilot, against 13 landslide days (2007–2018), with 95% confidence intervals and two
  baselines. It beats random alert days but **does no better than a simple rain-only threshold** (see Results).
- The vegetation **anomaly detector's false-flag rate**, on synthetic undisturbed series.
- The **stability** of the inspection ranking under ±20% weight changes.

### What is not validated

- The **susceptibility map**: only 2 located landslides fall in the pilot box, which is far too few.
- The **forest-loss watch** and the **before/after change checks**: not checked against imagery or on the ground.
- **Field validation** with local experts: the workflow exists, but no inspections have been done yet.
- **Any place other than Santa Ana**: thresholds and weights there are uncalibrated.

## Results so far (Santa Ana pilot)

Produced by `cd backend && python -m scripts.validation_report` (the same code as the live `/api/methods`).
Perfect-forecast hindcast with NASA POWER rain (~50 km cells) against NASA's Global Landslide Catalog (2007–2017
export) and a CNE report, within 25 km. Several reports on one day count as one landslide day.

| Level | Hit rate (95% CI) | Random days, same count | Rain-only rule, same count | Alerts with no catalogued landslide |
|---|---|---|---|---|
| Elevated or High rainfall | 4/13 = 31% (13–58%) | 6% (95% of draws 0–23%) | ≥ 30.9 mm/day: 31% | 37/41 (78–96%) |
| High rainfall only | 1/13 = 8% (1–33%) | 1% (95% of draws 0–8%) | ≥ 55.2 mm/day: 15% | 6/7 (49–97%) |

- Earlier block 2007–2010: Elevated/High 1/4, High 1/4. Later block 2011–2018: Elevated/High 3/9, High 0/9. The
  thresholds were set by judgment, not fitted to these events.
- "Alerts with no catalogued landslide" is an upper bound on false alarms, because catalogues only list slides that made the news.
- **Susceptibility vs located landslides:** n = 2. Both are within 100 m of a high cell, but 63% of the land is too, so
  that happens by chance about 40% of the time.
- **Anomaly detector:** 0.09 false events per point per year on synthetic undisturbed series (a lower bound). Real records give
  0.44 per point per year, an upper bound that includes real anomalies.
- **Inspection ranking:** under ±20% on any one weight, slopes keep 10/10 of their top 10 and stream corridors keep at least 8/10.

The honest reading: at this resolution the extra rainfall inputs (3-day rain, antecedent rain, soil wetness) don't yet
add skill over daily rain alone, and the susceptibility map is untested. Both need more events and field checks.

## What it does

**Hazard screening** (Hazards tab, for the place you click):
- **Susceptibility:** slope (landslide) and height above nearest drainage (HAND, from priority-flood routing on the
  DEM; flood), with ESA WorldCover land cover. Each hazard has its own class, plus a combined one. Cells whose class
  changes within typical input error (slope ±3°, HAND ±2 m, one land-cover step) are marked uncertain; cells whose
  drainage can't be traced are "unassessed", never "lower". The lowest class always reads "lower susceptibility, not safe".
- **Slope forest-loss watch:** HLS VI v2.0 NDVI at 30 m with the Fmask cloud mask; patches ≥ 0.5 ha on slopes > 15°
  that are much less green than the same season in prior years. Labelled "Possible vegetation loss, cause unconfirmed".
  Needs `EARTHDATA_TOKEN` and runs as a background job.
- **Rainfall trigger:** forecast 24/72 h rain (MET Norway), observed 7-day rain and soil wetness (NASA POWER). Levels are
  "Elevated" and "High" rainfall, deliberately not "Watch"/"Warning". If an input is missing the result is "could not be
  evaluated", never "no trigger". Past days are reconstructed from observed rain. Thresholds are in `backend/app/screening/screening.toml`.
- **Where to inspect first:** 250 m squares ranked separately for slopes and stream corridors, each with its reasons, plus
  printable / CSV / GeoJSON field sheets and an import that scores the experts' findings.
- **Backtest:** `/backtest`, as above, with every missed event listed.

**Also available, secondary to the pilot:** a CesiumJS globe with NASA GIBS layers and a date bar; MODIS NDVI anomaly
detection with quality control and "consistent with" explanations; a guided example (Santa Rosa, 2026); natural
hazards near a place (NOAA IBTrACS cyclones, NOAA SPC tornadoes in the US, USGS earthquakes, NASA EONET) with 30 m
before/after checks; street-level photos (KartaView/Mapillary); CSV/JSON/GeoJSON/PDF exports.

## Run it locally

Requirements: Node 20+, Python 3.11+.

```bash
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # macOS/Linux: .venv/bin/pip
cd ../frontend && npm install
npm run dev        # http://localhost:5173 - also starts the FastAPI backend on :8000
```

Keys (in `backend/.env`, never committed): none are needed for the globe, susceptibility, rainfall trigger or backtest.
`EARTHDATA_TOKEN` (free NASA Earthdata account) is needed for the 30 m forest-loss watch and before/after checks.
`MAPILLARY_TOKEN` is optional (more street photos). `NOMINATIM_CONTACT` identifies the app to OpenStreetMap and MET Norway.

Tests: `cd backend && python -m pytest`. CI runs the backend tests and the frontend type-check, lint and build on every push.

The first look at a new place downloads its MODIS record from ORNL DAAC (about 10–20 s per year) and builds the terrain
layers (a few seconds); after that it is cached.

## Deploy

One Docker container (FastAPI serves the API and the built site), deployed with `render.yaml` on Render's free tier.
Set `NOMINATIM_CONTACT`, `EARTHDATA_TOKEN` and optionally `KEEP_WARM_URL` (the site's own URL, so it pings itself and
doesn't sleep). The free tier sleeps after ~15 minutes idle and takes about a minute to wake. The Costa Rica places and
the Santa Ana pilot ship pre-computed in `backend/seed` (regenerate with `python -m scripts.build_seed`); the cache is
otherwise temporary on free hosts, so the forest-loss result is recomputed after each restart (about 2 minutes).

## Architecture

```
backend/app/
  main.py                  API: /api/series, /api/explain, /api/screening (+ /priority, /trigger, /backtest, /forest-loss),
                           /api/hazards (/events, /change), /api/methods, /api/places, /api/terrain, /api/street, /api/health
  analysis.py, explain.py  NDVI anomaly statistics; driver explanations (thresholds in explain.toml)
  screening/               susceptibility, trigger + backtest, forest_loss, change, priority, terrain_grid (priority-flood, HAND),
                           cog (minimal COG reader), disasters, screening.toml (every screening threshold + provenance)
  sources/                 ORNL MODIS, NASA POWER, HLS/CMR, terrain tiles, MET Norway, EONET/USGS, street imagery, Nominatim
backend/scripts/           build_seed, build_hazard_catalogs, flag_rate, validation_report
frontend/src/              React + TypeScript + Vite; Globe.tsx (CesiumJS, no Cesium ion), HazardsPanel, pages/ (Landing,
                           Backtest, Methods, About)
docs/DATA_SOURCES.md       licences and attribution for every source
```

## Data and licensing

All data sources are open; their licences, attribution and commercial-use terms are listed in
[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md). The code is in a **public** repository under an "all rights reserved"
licence ([LICENSE](LICENSE)): anyone can read it, but reuse needs permission.
<!-- TODO (owner): decide deliberately between keeping "all rights reserved" and an open licence (e.g. MIT or Apache-2.0). -->

## How to cite

EarthOS (2026). Landslide and flash-flood screening from open satellite data, Santa Ana pilot.
https://github.com/yajur408-lang/EarthOS. Please also cite the underlying datasets listed on the Methods page.

## Design decisions and what I'd do differently

<!-- TODO (owner): write this section in your own words. Explain, without notes, why 2 sigma and MAD, why 0.5 ha and 15 degrees,
why the larger of the landslide and flood scores, why a 250 m inspection square, and what you'd change with more time or data. -->

## Roadmap

- [x] Globe with GIBS layers, NDVI anomaly detection with quality control and explanations
- [x] Hazard screening for the Santa Ana pilot: susceptibility, 30 m forest-loss watch (HLS VI), rainfall trigger
- [x] Backtest with confidence intervals, baselines and earlier/later blocks
- [x] Deployed on Render (single Docker container)
- [ ] Field validation of the inspection ranking with local experts in Santa Ana
- [ ] Labelled-event evaluation of the vegetation anomaly detectors
- [ ] Check the forest-loss watch against known clearing and non-clearing sites in imagery
- [ ] Higher-resolution rainfall (e.g. GPM IMERG) as a separate, labelled comparison
- [ ] Lithology and soil layers for landslide susceptibility
