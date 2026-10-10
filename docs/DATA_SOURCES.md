# Data sources, licences and commercial-use review

Last verified: **2026-10-10**. Re-check before any paid launch, because terms change.
The in-app panel (`frontend/src/licences.ts`) mirrors this file.

## Decision checklist

| Item | Decision | Status |
|---|---|---|
| HLS vegetation-index product | **HLS VI v2.0**: `HLSL30_VI` (Landsat 8/9, doi:10.5067/HLS/HLSL30_VI.002) + `HLSS30_VI` (Sentinel-2A/B/C, doi:10.5067/HLS/HLSS30_VI.002), 30 m, NDVI band. LP DAAC says the data are shared "without restriction" under EOSDIS Data Use and Citation Guidance. The Sentinel-2 product also carries the Copernicus attribution duty. | In use: slope forest-loss watch (NDVI + HLS Fmask), read from LP DAAC with `EARTHDATA_TOKEN`. |
| GIBS attribution and service terms | NASA asks clients to show: *"We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."* The app shows this as a permanent credit on the globe. `Reference_Labels_15m` and `Coastlines_15m` are OSM-derived (their GIBS titles say "OSM"), so they also need **© OpenStreetMap contributors** (ODbL). That credit is attached to those layers. | Done |
| Independently licensed forest-loss dataset | **Hansen/UMD Global Forest Change v1.13 (2000–2025)**, **CC BY 4.0**. Direct GeoTIFF tiles at `storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/`. Global coverage as 10°×10° tiles named by their top-left corner (e.g. `20N_090W`). Chosen over the GFW Data API, which adds an API key and platform terms. | Chosen, URL verified. Integration planned. |
| Private API keys on the backend | Keys are read only by `backend/app/config.py` from `backend/.env` (git-ignored) or host env vars. The browser only calls `/api/*`. `/api/health` reports whether each key is set, never its value. No `VITE_*` variable holds a secret, because Vite inlines those into public JS. The MVP needs no keys at all. | Done |

## Sources in use

| Source | Use in EarthOS | Licence | Commercial use | Required attribution |
|---|---|---|---|---|
| NASA GIBS WMTS/WMS | Globe imagery and visual layers | NASA open data, no restrictions | Yes | GIBS acknowledgement (above) |
| GIBS OSM layers | Labels, coastlines | ODbL 1.0 | Yes, with attribution. Share-alike applies only if you publish a derived *database*; rendered map images are "produced works". | © OpenStreetMap contributors |
| MOD13Q1 v061 via ORNL DAAC MODIS Web Service | NDVI time-series chart and CSV for any land point | NASA open data, no restrictions | Yes | Didan, K. (2021). MOD13Q1 … V061. doi:10.5067/MODIS/MOD13Q1.061 |
| OpenStreetMap Nominatim (public server) | Place search (on Enter only) and names for dropped pins | Data ODbL 1.0; server use under the OSMF usage policy | Yes, within the policy: ≤ 1 req/s, no autocomplete, cache results, identifying User-Agent, proxied by our backend | © OpenStreetMap contributors |
| Terrain Tiles (Mapzen/AWS, Terrarium) | 3D terrain; elevation, slope, aspect, profile | Mixed open sources (public domain, CC BY, OGL; see attribution list) | Yes, with attribution | Full block: github.com/tilezen/joerd/blob/master/docs/attribution.md |
| MODIS MOD11A2 / MCD64A1 / MCD12Q1 v061 (ORNL DAAC) | Land surface temperature, burned area, land cover charts | NASA open data | Yes | Cite each product DOI (10.5067/MODIS/MOD11A2.061, …/MCD64A1.061, …/MCD12Q1.061) |
| KartaView | Street-level photos and panoramas | CC BY-SA 4.0 | Yes, with attribution (share-alike applies to adapted images) | KartaView contributors, CC BY-SA 4.0 |
| Mapillary (optional, `MAPILLARY_TOKEN`) | More street-level coverage | Images CC BY-SA 4.0; API free quota under developer terms | Yes, with attribution; contact Mapillary above the free quota | Mapillary contributors + link to image |
| MET Norway Locationforecast 2.0 | Forecast | CC BY 4.0 | Yes; identify with User-Agent, cache, don't overload | MET Norway, CC BY 4.0 |
| NASA EONET v3 | Natural events | NASA open data | Yes | NASA EONET |
| USGS earthquake catalogue | Earthquakes | US public domain | Yes | USGS |
| NASA HLS v2.0 true colour (GIBS `HLS_S30/L30_Nadir_BRDF_Adjusted_Reflectance`) + NASA CMR granule search | Sharp 30 m imagery when zoomed in; CMR cloud-cover metadata picks the clearest recent pass | NASA open data; Sentinel-2 part also Copernicus terms | Yes, with attribution | NASA HLS v2.0 via NASA GIBS; "Contains modified Copernicus Sentinel data [year]" |
| NASA POWER daily point API | Daily weather charts and CSV; observed 7-day rain and root-zone soil wetness (GWETROOT) for the rainfall trigger and backtest | NASA open data | Yes | "Data obtained from the NASA Langley Research Center (LaRC) POWER Project funded through the NASA Earth Science/Applied Science Program." |
| HLS VI v2.0 (`HLSL30_VI`, `HLSS30_VI`) + HLS Fmask, via NASA CMR and LP DAAC | Slope forest-loss watch (30 m NDVI) | NASA: no restriction. Sentinel part: Copernicus terms (free, attribution). | Yes, with attribution | Cite both DOIs; "Contains modified Copernicus Sentinel data [year]". Needs a free Earthdata token (`EARTHDATA_TOKEN`, backend only). |
| ESA WorldCover 10 m 2021 v200 (COGs on AWS Open Data) | Land cover for the susceptibility layer | CC BY 4.0 | Yes, with attribution | © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium; Zanaga et al. 2022, doi:10.5281/zenodo.7254221 |
| Terrain Tiles (as above) | Slope, drainage lines and HAND for the susceptibility layer | as above | Yes, with attribution | as above |
| NASA Global Landslide Catalog export (2007–2017), bundled as `backend/app/screening/glc_events.csv.gz` | Past landslides for the backtest | NASA open data (data.gov listing); export notes refer to GLC terms: cite the papers | Yes, with attribution | Kirschbaum et al. 2010 (*Nat. Hazards* 52:561–575); Kirschbaum, Stanley & Zhou 2015 (*Geomorphology* 249:4–15) |
| CNE technical report, Tapezco landslide (2018), Municipalidad de Santa Ana open-data portal | One local event in the Santa Ana backtest (date, place, link) | Public report; cited and linked, not redistributed | Yes, as a citation | CNE, via datosabiertos.santaana.go.cr |

## Planned

| Source | Licence | Notes |
|---|---|---|
| Hansen GFC v1.13 | CC BY 4.0 | Cite Hansen et al. 2013, *Science* 342:850–853. |
| NASA FIRMS active fire API | NASA open data | Needs a free `MAP_KEY` (backend only). |

## Rejected for monetisation reasons

| Source | Why |
|---|---|
| Open-Meteo free API | Its terms limit the free tier to non-commercial use, and that explicitly covers apps with subscriptions or ads. It was the first climate source and was replaced by NASA POWER. A paid Open-Meteo plan would also work. |
| Cesium ion (terrain, Bing imagery, geocoder) | Not used, so there is no ion account or plan to manage. CesiumJS itself is Apache-2.0. |
| EOxCloudless (Sentinel-2 10 m mosaic) | Sharper than HLS, but commercial use needs a paid EOX licence ("EOX Commercial Attribution-RestrictedUse"). NASA HLS at 30 m is used instead. Revisit if you buy a licence. |
| Google Street View | Its terms forbid showing Street View with or near a non-Google map, and EarthOS uses a CesiumJS globe. Replaced by KartaView and Mapillary (CC BY-SA 4.0). |
| GFW Data API | Unnecessary: the same Hansen data is available directly under CC BY 4.0. |

## Monetisation guard-rails

1. **No NASA endorsement.** NASA data can be used commercially, but the NASA name, "meatball" insignia and logos must not imply endorsement. Don't put NASA logos in EarthOS branding. Credit lines are fine.
2. **Attribution must stay visible** in every paid tier and every export (PNGs, CSVs and any future reports). The CSV export already appends dataset citations.
3. **Nominatim's public server is for light use.** Its policy limits it to 1 request/second with caching and forbids autocomplete. EarthOS follows this: it proxies through the backend, serialises requests, caches everything, and searches only on Enter. For a paid product with real traffic, set `NOMINATIM_URL` to a self-hosted Nominatim or a commercial geocoder, and set `NOMINATIM_CONTACT`.
4. **ORNL MODIS Web Service is a convenience service.** For a paid product with many users, mirror MOD13Q1 from LP DAAC (same licence) instead of relying on a free public endpoint for capacity.
5. **Keep the third-party code licences** (Apache-2.0 for CesiumJS; MIT/BSD for the rest) in your distribution notices. None of them restrict commercial use.
6. **Your own code is "All rights reserved"** (see `LICENSE`), which keeps every option open: SaaS, licensing, or open-sourcing later. If you open-source it for a portfolio, pick the licence deliberately. AGPL/BSL keeps commercial leverage; MIT gives it away.
