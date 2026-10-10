"""EarthOS API - environmental data and seasonal statistics for any land point on Earth.
It reports measurements and statistics; it does not attribute causes or draw conclusions.

Run:  uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import datetime as dt
import math
from dataclasses import asdict

import httpx
from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from . import analysis, config
from .ratelimit import RateLimit
from .datasets import DATASETS
from .places import PLACES
from .sources import events, hls, nominatim, ornl, power, street, terrain, weather

app = FastAPI(title="EarthOS API", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=config.ALLOWED_ORIGINS, allow_methods=["GET"], allow_headers=["*"])
app.add_middleware(RateLimit, per_minute=config.RATE_LIMIT_PER_MINUTE)


@app.get("/api/health")
def health():
    return {"ok": True, "keys": config.key_status()}


@app.get("/api/places")
def places():
    return PLACES


@app.get("/api/geocode")
async def geocode(q: str = Query(..., min_length=2, max_length=200)):
    try:
        return await nominatim.search(q)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Place search unavailable: {e}") from e


@app.get("/api/reverse")
async def reverse(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    try:
        return await nominatim.reverse(lat, lon)
    except httpx.HTTPError:
        return None  # a missing place name never blocks the data view


@app.get("/api/datasets")
def datasets():
    return DATASETS


def _num(x: float) -> float | None:
    return None if math.isnan(x) else round(float(x), 2)


@app.get("/api/series")
async def series(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    km: int = Query(1, ge=0, le=10, description="Half-width of the averaged box in km (0 = single pixel)"),
    start_year: int = Query(dt.date.today().year - 9, ge=2000),
    end_year: int = Query(dt.date.today().year),
    z: float = Query(analysis.Z_FLAG, gt=0, le=10, description="Seasonal flag threshold, |z|"),
    drop: float = Query(analysis.THRESHOLD_DROP, gt=0, le=1, description="Threshold-method NDVI drop"),
):
    if start_year > end_year:
        raise HTTPException(400, "start_year must not be after end_year.")

    ndvi, ndvi_error = [], None
    try:
        ndvi = await ornl.ndvi_series(lat, lon, km, start_year, end_year)
    except httpx.HTTPStatusError as e:
        ndvi_error = ("No MODIS land product for this location (open ocean or outside the land grid)."
                      if e.response.status_code in (400, 404) else f"MODIS service error: {e}")
    except httpx.HTTPError as e:
        ndvi_error = f"MODIS service unavailable: {e}"
    if not ndvi and not ndvi_error:
        ndvi_error = "No MODIS composites for this location and period."

    climate, climate_error = None, None
    try:
        climate = await power.daily_climate(
            lat, lon, (dt.date(start_year, 1, 1) - dt.timedelta(days=analysis.ANTECEDENT_DAYS)).isoformat(),
            f"{end_year}-12-31")
    except httpx.HTTPError as e:
        climate_error = f"NASA POWER unavailable: {e}"

    if not ndvi and climate is None:
        raise HTTPException(502, ndvi_error or climate_error or "No data found.")

    stats = analysis.analyse([asdict(c) for c in ndvi], climate, z_flag=z, drop=drop) if ndvi else None

    return {
        "query": {"lat": lat, "lon": lon, "km": km, "start_year": start_year, "end_year": end_year,
                  "z": z, "drop": drop},
        "ndvi": {
            "dataset": "MOD13Q1",
            "pixels_per_composite": ndvi[0].n_pixels if ndvi else 0,
            "note": "Mean NDVI of pixels flagged good or marginal by the product's own pixel-reliability layer.",
            "points": [{"date": c.calendar_date, "ndvi": c.ndvi_mean, "usable_fraction": c.usable_fraction}
                       for c in ndvi],
            "error": ndvi_error,
        },
        "climate": {
            "dataset": "POWER",
            "points": [] if climate is None else [
                {"date": d.strftime("%Y-%m-%d"), **{c: _num(row[c]) for c in climate.columns}}
                for d, row in climate.iterrows()
                if d.year >= start_year
            ],
            "error": climate_error,
        },
        "stats": stats,
        "datasets": DATASETS,
    }


LatQ = Query(..., ge=-90, le=90)
LonQ = Query(..., ge=-180, le=180)


@app.get("/api/terrain")
async def terrain_info(lat: float = LatQ, lon: float = LonQ, km: float = Query(1, ge=0, le=10)):
    try:
        return await terrain.terrain(lat, lon, km)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Terrain tiles unavailable: {e}") from e


EXTRA = {
    "evi": ornl.evi_series,
    "lst": ornl.lst_series,
    "burned": ornl.burned_series,
    "landcover": ornl.landcover_series,
}


@app.get("/api/extra/{kind}")
async def extra(
    kind: str = Path(..., pattern="^(evi|lst|burned|landcover)$"),
    lat: float = LatQ, lon: float = LonQ, km: int = Query(1, ge=0, le=10),
    start_year: int = Query(dt.date.today().year - 9, ge=2000), end_year: int = Query(dt.date.today().year),
):
    try:
        return {"kind": kind, "points": await EXTRA[kind](lat, lon, km, start_year, end_year)}
    except httpx.HTTPStatusError as e:
        if e.response.status_code in (400, 404):
            return {"kind": kind, "points": [], "error": "No MODIS land product for this location."}
        raise HTTPException(502, f"MODIS service error: {e}") from e
    except httpx.HTTPError as e:
        raise HTTPException(502, f"MODIS service unavailable: {e}") from e


@app.get("/api/street")
async def street_nearby(lat: float = LatQ, lon: float = LonQ):
    return await street.nearby(lat, lon)


@app.get("/api/street/image/{provider}/{image_id}")
async def street_image(provider: str = Path(..., pattern="^(kartaview|mapillary)$"),
                       image_id: str = Path(..., pattern=r"^[0-9]{1,24}$"),
                       size: str = Query("full", pattern="^(thumb|full)$")):
    try:
        url = await street.image_url(provider, image_id, size)
        if not url:
            raise HTTPException(404, "Image not found.")
        async with httpx.AsyncClient(follow_redirects=True, headers={"User-Agent": config.USER_AGENT}) as client:
            r = await client.get(url, timeout=40)
            r.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Image unavailable: {e}") from e
    return Response(r.content, media_type=r.headers.get("content-type", "image/jpeg"),
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/street/sequence/{provider}/{sequence}/{index}")
async def street_sequence(provider: str = Path(..., pattern="^(kartaview|mapillary)$"),
                          sequence: str = Path(..., pattern=r"^[0-9A-Za-z_-]{1,64}$"), index: int = Path(..., ge=0)):
    return await street.sequence_neighbours(provider, sequence, index)


@app.get("/api/weather")
async def weather_forecast(lat: float = LatQ, lon: float = LonQ):
    try:
        return await weather.forecast(lat, lon)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Forecast unavailable: {e}") from e


async def _safe(coro):
    try:
        return await coro, None
    except (httpx.HTTPError, ValueError, KeyError) as e:
        return [], str(e) or e.__class__.__name__


@app.get("/api/events")
async def nearby_events(lat: float = LatQ, lon: float = LonQ,
                        place: str | None = Query(None, max_length=120), country: str | None = Query(None, max_length=80)):
    """Natural events, earthquakes, outbreak notices and news headlines - listed, not interpreted."""
    (nat, e1), (eq, e2), (who, e3), (headlines, e4) = await asyncio.gather(
        _safe(events.natural_events(lat, lon)),
        _safe(events.earthquakes(lat, lon)),
        _safe(events.outbreaks(country)),
        _safe(events.news(place, country)) if (place or country) else _noop(),
    )
    return {
        "natural": nat, "earthquakes": eq, "outbreaks": who, "news": headlines,
        "errors": {k: v for k, v in {"natural": e1, "earthquakes": e2, "outbreaks": e3, "news": e4}.items() if v},
        "attribution": "NASA EONET · USGS Earthquake Hazards Program · WHO Disease Outbreak News (links) · The GDELT Project",
    }


async def _noop():
    return [], None


@app.get("/api/sharp-imagery")
async def sharp_imagery(lat: float = LatQ, lon: float = LonQ, days: int = Query(180, ge=7, le=730)):
    """Recent 30 m HLS passes over a point with granule cloud cover (for picking a clear one)."""
    try:
        return {"passes": await hls.passes(lat, lon, days),
                "attribution": "NASA HLS v2.0 (Landsat 8/9 OLI, Sentinel-2 MSI) via NASA GIBS; contains modified Copernicus Sentinel data"}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"NASA CMR unavailable: {e}") from e


# ---------- serve the built frontend (production: one service, one URL) ----------
if (config.FRONTEND_DIST / "index.html").exists():
    _DIST = config.FRONTEND_DIST.resolve()
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")
    app.mount("/cesiumStatic", StaticFiles(directory=_DIST / "cesiumStatic"), name="cesium")

    # GET and HEAD: hosts and uptime monitors probe the site with HEAD requests.
    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        f = (_DIST / path).resolve()
        if path and f.is_file() and _DIST in f.parents:
            return FileResponse(f)
        return FileResponse(_DIST / "index.html", headers={"Cache-Control": "no-cache"})
