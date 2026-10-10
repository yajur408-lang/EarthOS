# EarthOS

**A 3D globe for exploring satellite and climate data anywhere on Earth, with seasonal anomaly statistics.**
EarthOS measures and flags. It does not interpret: it never attributes a cause or tells you what a change means.

The interface works like Google Maps and Google Earth:
- **Search** (press `/`) for a place name or coordinates such as `-3.1, -60.0` or `9.9N 84.1W`.
- **Click anywhere** to drop a pin. A place card opens with an Overview, Charts and Anomalies.
- **Layers** (bottom-left) shows map types and data layers as thumbnails. The **date bar** (bottom) steps through days and has a split-screen Compare mode.
- **Controls** (bottom-right): help, street-level figure, compass with rotate arrows, 3D tilt, orbit, 3D terrain, my location, and zoom.
- **Google Earth-style movement**: real 3D terrain, tilted fly-to, double-click zoom, Ctrl/middle-drag tilt, and keyboard flying (W A S D / arrows; Q/E rotate; R/F tilt; +/- zoom).
- **Street level**: open CC BY-SA photos and 360° panoramas from KartaView (plus Mapillary with a free token), with forward/back along the route and an "other dates" strip to compare years.
- **Sharp imagery**: zoom in and EarthOS layers NASA HLS 30 m Landsat/Sentinel-2 imagery from the clearest recent pass. NASA's catalogue cloud cover picks the pass, and the chip at the top lets you choose another date. It also renders at full device pixel density.
- **Tutorial**: a guided tour runs on first visit; press **Tutorial** (top-right) to replay it.
- **Save and share**: star places (they appear under "Saved places" in search, downloadable as GeoJSON), copy a link that reopens the exact view, and download CSV, a full JSON bundle, GeoJSON, map and chart PNGs, or a printable PDF report.
- **Place card tabs**: Overview (readings, terrain and elevation profile), Charts (12 charts covering vegetation, temperature, rain, sunlight, humidity, soil moisture, wind, fire and land cover), Anomalies, Street, Weather (MET Norway forecast) and News (nearby natural events, earthquakes, WHO outbreak notices, and environment headlines via GDELT). News and events are listed as published, not interpreted.

| Part | What it shows |
|---|---|
| **Map layers** | A CesiumJS globe with NASA GIBS imagery: MODIS/VIIRS true colour, NDVI, EVI, land-surface temperature, IMERG rain, VIIRS fires, plus OSM labels and coastlines. Includes a date picker and a split-screen comparison of two dates. |
| **Location data** | Any land point (click the globe, type coordinates, or use an example place). Charts MODIS NDVI (250 m, 16-day) with its seasonal normal range, NASA POWER rain and max temperature, raw readings at the chosen date, NDVI statistics at compare dates A and B, and a CSV export with citations. |
| **Anomalies** | Two detectors side by side: a threshold detector (NDVI drop ≥ 0.10) and a seasonal detector (\|z\| ≥ 2 against the same 16-day period in other years). Shows a method-comparison table and below/above-normal events described only by statistics: NDVI vs seasonal median, z-score, usable pixels, rainfall and temperature versus their seasonal norms, and whether NDVI returned within ±1σ. Both thresholds are adjustable. |

## Research question

> Can seasonal anomaly detection combined with multiple environmental data sources identify unusual
> vegetation changes more reliably than simple threshold-based methods?

- **Seasonal median:** median NDVI of the same 16-day slot in all *other* years (leave-one-year-out), with σ = 1.4826 × MAD.
- **Normal range:** median ± 2σ.
- **Quality filter:** composites with < 20% usable pixels (by the product's own reliability flags) are left out of the statistics.
- **Rainfall window:** each composite window plus the 32 days before it, compared with the same windows in other years.
- **Evaluating accuracy** needs labelled events (e.g. Hansen loss years, FIRMS fires). The app reports agreement counts only.

## Run it locally

Requirements: Node 20+, Python 3.11+.

```bash
# one-time setup
cd backend
python -m venv .venv
.venv\Scriptsctivate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cd ../frontend
npm install

# run everything (website + API) with one command
npm run dev                      # http://localhost:5173
```

`npm run dev` starts the FastAPI backend on port 8000 automatically and restarts it when you edit
backend code. If a backend is already running on :8000 it reuses that one. Set `BACKEND_AUTOSTART=0`
to manage the backend yourself (`uvicorn app.main:app --port 8000` from `backend/`).

The first request for a new location downloads every MODIS composite for those years from ORNL DAAC
(about 10–20 s per year). After that it is cached in `backend/data/cache/`. No API keys are needed.

Tests: `cd backend && pip install -r requirements-dev.txt && python -m pytest`

## Deploy (share it online)

EarthOS ships as **one Docker container**: FastAPI serves both the API and the built website, so you get one URL
and no CORS setup. Any Docker host works. The steps below use **Render** (free tier, no card needed).

1. Push this folder to a GitHub repository (it can be **private**, which keeps the proprietary code private).
2. In [Render](https://render.com): **New → Blueprint**, then connect the repository. Render reads `render.yaml`.
3. When asked for environment variables:
   - `NOMINATIM_CONTACT`: your email or website. OpenStreetMap and MET Norway require apps to identify themselves.
   - `MAPILLARY_TOKEN` (optional): a free Mapillary client token for more street-level photos.
4. Deploy. The site appears at `https://earthos-xxxx.onrender.com`. Pushing to the repository redeploys automatically.

Notes:
- The free tier sleeps after ~15 minutes idle; the first visit afterwards takes about a minute to wake up.
- The cache (`CACHE_DIR`) is temporary on free hosts, so the first look at each place re-downloads its satellite record.
- Each visitor is rate-limited (`RATE_LIMIT_PER_MINUTE`, default 240 "points"; heavy endpoints cost more) so one user
  can't get the server blocked by the free public data services.
- Other hosts: `docker build -t earthos . && docker run -p 8000:8000 -e NOMINATIM_CONTACT=you@example.com earthos`
  works the same on Railway, Fly.io, Google Cloud Run or a Hugging Face Docker Space.

## Architecture

```
frontend/  React + TypeScript + Vite
  src/components/Globe.tsx   CesiumJS viewer, GIBS WMTS/WMS layers, split compare, point picking
  src/components/Chart.tsx   Plotly charts of NDVI, rain and max temperature
  src/layers.ts              GIBS layer catalogue (ids verified against WMTSCapabilities)
  src/licences.ts            in-app data-licence register
backend/   FastAPI
  app/main.py                /api/series, /api/places, /api/datasets, /api/health
  app/analysis.py            seasonal statistics, anomaly flags, event statistics (no attribution)
  app/sources/ornl.py        MOD13Q1 NDVI + pixel-reliability flags via ORNL MODIS Web Service
  app/sources/power.py       NASA POWER daily rain / Tmax
  app/config.py              server-only secrets (.env)
docs/DATA_SOURCES.md         licences, attribution, commercial-use review
```

Notes:
- **GIBS EPSG:4326 tiling quirk:** level-0 tiles are 288° wide, so Cesium needs a tiling scheme whose
  rectangle is (−180, −198, 396, 90). See `Globe.tsx`.
- **No Cesium ion:** every pixel comes from NASA GIBS, so there is no token and no ion plan.

## Data and licensing

Every data source in use allows commercial use with attribution. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
EarthOS's own code is proprietary, "all rights reserved" (see [LICENSE](LICENSE)).

## Roadmap

- [x] Global globe with GIBS layers and two-date comparison
- [x] NDVI, rain and temperature time series for any land point, with CSV export
- [x] Threshold vs seasonal anomaly detection with event statistics
- [ ] Labelled-event evaluation of the two detectors
- [ ] HLS VI 30 m NDVI time series
- [ ] Hansen GFC v1.13 tree-cover-loss layer and FIRMS fire counts per location
- [ ] Deploy (Vercel frontend + Python host)
