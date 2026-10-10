"""EarthOS API - environmental data and seasonal statistics for any land point on Earth.
It reports measurements and statistics; it does not attribute causes or draw conclusions.

Run:  uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import datetime as dt
import logging
import math
import mimetypes
from pathlib import Path as FsPath
from dataclasses import asdict

import httpx
from . import http
from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from . import analysis, config
from .cache import cached_json
from .ratelimit import RateLimit
from .datasets import DATASETS
from .places import PLACES
from .sources import events, hls, nominatim, ornl, power, street, terrain, weather

log = logging.getLogger("uvicorn.error")


def _seed_cache():
    """Copy the pre-computed featured-place data into the cache (keeps original timestamps, so
    time-limited entries like the MODIS date list still refresh on schedule)."""
    import shutil
    if not config.SEED_DIR.is_dir():
        return 0
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in config.SEED_DIR.rglob("*"):
        if f.is_file():
            dest = config.CACHE_DIR / f.relative_to(config.SEED_DIR)
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dest)
                n += 1
    return n


async def _keep_warm():
    """Ping our own public URL so a free-tier host doesn't sleep (only when KEEP_WARM_URL is set)."""
    if not config.KEEP_WARM_URL:
        return
    async with http.client(timeout=30) as client:
        while True:
            await asyncio.sleep(600)
            try:
                await client.get(f"{config.KEEP_WARM_URL}/api/health")
            except httpx.HTTPError:
                pass


async def _prewarm():
    """Refresh the featured places' newest composites in the background (the seed covers the rest)."""
    await asyncio.sleep(3)
    year = dt.date.today().year
    for pid in config.PREWARM_PLACES:
        p = next((p for p in PLACES if p["id"] == pid.strip()), None)
        if not p:
            continue
        try:
            await asyncio.gather(
                ornl.ndvi_series(p["lat"], p["lon"], p["km"], year - 9, year),
                power.daily_climate(p["lat"], p["lon"], (dt.date(year - 9, 1, 1) - dt.timedelta(days=analysis.ANTECEDENT_DAYS)).isoformat(), f"{year}-12-31"),
            )
            log.info("prewarmed %s", pid)
        except Exception as e:  # best effort: a slow upstream must never block startup
            log.warning("prewarm %s failed: %s", pid, e)


@contextlib.asynccontextmanager
async def lifespan(_app):
    seeded = _seed_cache()
    if seeded:
        log.info("seeded %d cached files for featured places", seeded)
    tasks = [asyncio.create_task(_prewarm()), asyncio.create_task(_keep_warm())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="EarthOS API", version="0.3.0", lifespan=lifespan)
# Compress API JSON and the multi-MB JS bundles (roughly 4x smaller on the wire).
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)
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


async def _analyse(lat, lon, km, start_year, end_year, ndvi, climate, **kw) -> dict:
    """analysis.analyse, memoised on disk: it is CPU-heavy (~10 s for 10 years on a small host) and its inputs
    only change when a new composite or climate day arrives, so the key includes the newest of each."""
    records = [asdict(c) for c in ndvi]
    newest = (records[-1]["calendar_date"] if records else "", len(records),
              str(climate.index.max()) if climate is not None and len(climate) else "")
    key = f"stats_{lat}_{lon}_{km}_{start_year}_{end_year}_{sorted(kw.items())}_{newest}_v{analysis.VERSION}"

    async def compute():
        out = await asyncio.to_thread(analysis.analyse, records, climate, **kw)
        return json.loads(json.dumps(out, default=_json_default))
    return await cached_json(key, compute)


def _json_default(o):
    if hasattr(o, "item"):  # numpy scalars
        return o.item()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    raise TypeError(type(o))


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

    stats = await _analyse(lat, lon, km, start_year, end_year, ndvi, climate, z_flag=z, drop=drop) if ndvi else None

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
            "points": [] if climate is None else _climate_points(climate, start_year),
            "error": climate_error,
        },
        "stats": stats,
        "datasets": DATASETS,
    }


def _climate_points(climate, start_year: int) -> list[dict]:
    df = climate[climate.index.year >= start_year]
    cols = {c: [_num(v) for v in df[c].tolist()] for c in df.columns}
    dates = df.index.strftime("%Y-%m-%d").tolist()
    return [{"date": d, **{c: v[i] for c, v in cols.items()}} for i, d in enumerate(dates)]


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
        async with http.client(follow_redirects=True, headers={"User-Agent": config.USER_AGENT}) as client:
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
async def nearby_events(lat: float = LatQ, lon: float = LonQ):
    """Nearby natural events and earthquakes (optional context, hidden by default in the UI)."""
    (nat, e1), (eq, e2) = await asyncio.gather(_safe(events.natural_events(lat, lon)), _safe(events.earthquakes(lat, lon)))
    return {
        "natural": nat, "earthquakes": eq,
        "errors": {k: v for k, v in {"natural": e1, "earthquakes": e2}.items() if v},
        "attribution": "NASA EONET · USGS Earthquake Hazards Program",
    }


@app.get("/api/sharp-imagery")
async def sharp_imagery(lat: float = LatQ, lon: float = LonQ,
                        date: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$")):
    """30 m HLS passes over a point around a date (default today), with granule cloud cover."""
    try:
        around = dt.date.fromisoformat(date) if date else dt.date.today()
        return {"passes": await hls.passes(lat, lon, around),
                "attribution": "NASA HLS v2.0 (Landsat 8/9 OLI, Sentinel-2 MSI) via NASA GIBS; contains modified Copernicus Sentinel data"}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"NASA CMR unavailable: {e}") from e



@app.get("/api/explain")
async def explain(
    lat: float = LatQ, lon: float = LonQ, km: int = Query(1, ge=0, le=10),
    start_year: int = Query(dt.date.today().year - 9, ge=2000), end_year: int = Query(dt.date.today().year),
    event_start: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"), direction: str = Query(..., pattern="^(below|above)$"),
):
    """Re-check one event with extra evidence: burned area (MCD64A1) and land-cover change (MCD12Q1)."""
    composites = await ornl.ndvi_series(lat, lon, km, start_year, end_year)
    climate = await power.daily_climate(
        lat, lon, (dt.date(start_year, 1, 1) - dt.timedelta(days=analysis.ANTECEDENT_DAYS)).isoformat(), f"{end_year}-12-31")
    stats = await _analyse(lat, lon, km, start_year, end_year, composites, climate)
    ev = next((e for e in stats["events"] if e["start"] == event_start and e["direction"] == direction), None)
    if ev is None:
        raise HTTPException(404, "Event not found for these settings.")

    start, end = dt.date.fromisoformat(ev["start"]), dt.date.fromisoformat(ev["end"]) + dt.timedelta(days=16)
    context: dict = {"burned_pct": None, "landcover_change": None}
    notes = []
    burned, lc = await asyncio.gather(
        ornl.burned_series(lat, lon, km, start.year, end.year),
        ornl.landcover_series(lat, lon, km, start.year - 1, end.year + 1),
        return_exceptions=True)
    if isinstance(burned, list):
        window = [b for b in burned if b["burned_fraction"] is not None
                  and start - dt.timedelta(days=31) <= dt.date.fromisoformat(b["date"]) <= end]
        context["burned_pct"] = round(100 * max((b["burned_fraction"] for b in window), default=0.0), 1)
    else:
        notes.append("Burned-area data unavailable right now.")
    if isinstance(lc, list) and lc:
        before = next((y for y in lc if y["year"] == start.year - 1), None)
        after = next((y for y in reversed(lc) if y["year"] >= end.year), None)
        if before and after and after["year"] != before["year"]:
            classes = set(before["classes"]) | set(after["classes"])
            shift = max(abs(after["classes"].get(c, 0) - before["classes"].get(c, 0)) for c in classes)
            top = lambda y: max(y["classes"], key=y["classes"].get)  # noqa: E731
            context["landcover_change"] = {
                "changed": shift >= 0.15,
                "detail": f"land cover shifted {shift:.0%} between {before['year']} and {after['year']} "
                          f"(main class {top(before).lower()} -> {top(after).lower()})",
            }
        else:
            notes.append("Land cover for the year after this event isn't published yet (MODIS land cover lags ~1-2 years).")
    elif isinstance(lc, list):
        notes.append("Land cover for these years isn't published yet (MODIS land cover lags ~1-2 years).")
    else:
        notes.append("Land-cover data unavailable right now.")
    ev["explanation"] = analysis.explain_event(ev, context)
    return {"event": ev, "context": context, "notes": notes,
            "sources": {k: analysis_sources[k] for k in ("MOD13Q1", "POWER", "MCD64A1", "MCD12Q1")}}


analysis_sources = {
    "MOD13Q1": {"name": "MODIS/Terra Vegetation Indices 16-Day 250 m v061", "doi": "10.5067/MODIS/MOD13Q1.061"},
    "POWER": {"name": "NASA POWER daily weather", "doi": None, "url": "https://power.larc.nasa.gov/"},
    "MCD64A1": {"name": "MODIS Burned Area Monthly 500 m v061", "doi": "10.5067/MODIS/MCD64A1.061"},
    "MCD12Q1": {"name": "MODIS Land Cover Type Yearly 500 m v061", "doi": "10.5067/MODIS/MCD12Q1.061"},
}

# ---------- serve the built frontend (production: one service, one URL) ----------
if (config.FRONTEND_DIST / "index.html").exists():
    _DIST = config.FRONTEND_DIST.resolve()
    class _CachedStatic(StaticFiles):
        """Vite assets have content hashes in their names, so browsers may cache them for a year."""

        def __init__(self, *a, max_age: int, **kw):
            super().__init__(*a, **kw)
            self.max_age = max_age

        async def get_response(self, path, scope):
            # Serve a pre-compressed .gz twin (made at Docker build time) when the browser accepts gzip.
            accepts = b"gzip" in dict(scope.get("headers", [])).get(b"accept-encoding", b"")
            gz = FsPath(self.directory) / f"{path}.gz"
            if accepts and gz.is_file() and FsPath(self.directory).resolve() in gz.resolve().parents:
                media = mimetypes.guess_type(path)[0] or "application/octet-stream"
                resp = FileResponse(gz, media_type=media, headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
            else:
                resp = await super().get_response(path, scope)
            if resp.status_code == 200:
                resp.headers["Cache-Control"] = f"public, max-age={self.max_age}" + (", immutable" if self.max_age > 86400 else "")
            return resp

    app.mount("/assets", _CachedStatic(directory=_DIST / "assets", max_age=31_536_000), name="assets")
    app.mount("/cesiumStatic", _CachedStatic(directory=_DIST / "cesiumStatic", max_age=7 * 86400), name="cesium")

    # GET and HEAD: hosts and uptime monitors probe the site with HEAD requests.
    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        f = (_DIST / path).resolve()
        if path and f.is_file() and _DIST in f.parents:
            return FileResponse(f)
        return FileResponse(_DIST / "index.html", headers={"Cache-Control": "no-cache"})
