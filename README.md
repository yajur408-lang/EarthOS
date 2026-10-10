# EarthOS

**Landslide and flash-flood screening from open satellite data: piloted in Santa Ana, Costa Rica, and usable anywhere on Earth. Plus a 3D globe for unusual vegetation changes, with quality-controlled statistics and the evidence behind each one.**

> Screening tool, not an official warning. For alerts, follow the national services (in Costa Rica: CNE and IMN).

Pages: `/` (landing, Santa Ana pilot), `/explore` (the globe; `/explore?pilot=santa-ana` opens the pilot), `/backtest`
(rainfall trigger vs past landslides), `/methods` (how every number is computed) and `/about`.

### Hazard screening (Hazards tab, any place)
- **Susceptibility:** slope, height above nearest drainage (HAND, derived from the DEM by priority-flood routing) and
  ESA WorldCover land cover give each ~31 m cell a lower / medium / high class. Cells whose class changes within typical
  input error (slope ±3°, HAND ±2 m, one land-cover step) are marked uncertain. "Lower susceptibility, not safe."
- **Slope forest-loss watch:** 30 m HLS VI NDVI with the Fmask cloud mask; patches ≥ 0.5 ha on slopes > 15° whose recent
  NDVI is far below the same season in prior years. Labelled "Possible vegetation loss, cause unconfirmed", with date
  range, QA and number of baseline years. Needs `EARTHDATA_TOKEN`; runs as a background job and is cached.
- **Rainfall trigger:** forecast 24/72 h rain (MET Norway), observed 7-day rain and root-zone soil wetness (NASA POWER)
  → Watch / Warning. All thresholds are in `backend/app/screening/screening.toml`.
- **Backtest:** the rules replayed over daily rain since 2001 and scored against NASA's Global Landslide Catalog and
  local reports (hit rate, false-alarm rate).

The interface works like Google Maps and Google Earth:
- **Search** (press `/`) for a place name or coordinates such as `-3.1, -60.0` or `9.9N 84.1W`.
- **Click anywhere** to drop a pin. A place card opens with an Overview, Charts and Anomalies.
- **Layers** (bottom-left) shows map types and data layers as thumbnails. The **date bar** (bottom) steps through days and has a split-screen Compare mode.
- **Google Earth-style movement**: 3D terrain, tilted fly-to, double-click zoom, Ctrl/middle-drag tilt, and keyboard flying (W A S D / arrows; Q/E rotate; R/F tilt; +/- zoom).
- **Street level**: open CC BY-SA photos and 360° panoramas from KartaView (plus Mapillary with a free token).
- **Sharp imagery**: zoomed in, EarthOS layers NASA HLS 30 m Landsat/Sentinel-2 imagery from the clearest pass near the date-bar date, and says how many days off it is.
- **Guided example**: a six-step walk-through of the 2026 late rainy season at Santa Rosa, Guanacaste (`/explore?story=santa-rosa`).
- **Save and share**: star places, copy a link that reopens the exact view, and download CSV, JSON, GeoJSON, PNG or a printable PDF report.
- **Optional context**: weather (MET Norway) and nearby natural events and earthquakes (NASA EONET, USGS) are off by default; switch them on in Layers.

## How anomalies are found and explained

- **Quality control:** each MOD13Q1 composite is trusted only if ≥ 30% of its pixels are rated "good", or ≥ 80% are usable and ≤ 5% cloudy. Untrusted composites are drawn faintly but never used.
- **Normal range:** leave-one-year-out median of the same and neighbouring 16-day slots, σ = 1.4826 × MAD (floor 0.03); normal = median ± 2σ.
- **Flags:** |z| ≥ 2 **and** an NDVI difference of at least 0.05.
- **Validation:** every event gets five checks (clear pixels, persistence, size of change, cloudy neighbours, baseline depth) and a confidence level.
- **Explanation:** `/api/explain` weighs possible drivers (drought, late/early green-up, heat, fire from MCD64A1, land-cover change from MCD12Q1, data artifact) as supported / possible / not supported. Wording is "most consistent with", never "caused by".

See the Methods page for details and limitations.

## Run it locally

Requirements: Node 20+, Python 3.11+.

```bash
# one-time setup
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
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
- The free tier sleeps after ~15 minutes idle; the first visit afterwards takes about a minute to wake up (a loading screen
  says so). Set `KEEP_WARM_URL` to the site's own URL and it pings itself every 10 minutes to stay awake.
- The Costa Rica featured places ship pre-computed in `backend/seed` (copied into the cache at startup), so they open
  instantly. Refresh it with `python -m scripts.build_seed` from `backend/`.
- The cache (`CACHE_DIR`) is temporary on free hosts, so the first look at other places re-downloads their satellite record.
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
