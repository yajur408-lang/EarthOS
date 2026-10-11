"""EarthOS API - environmental data and seasonal statistics for any land point on Earth.
It reports measurements and statistics; it does not attribute causes or draw conclusions.

Run:  uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import logging
import mimetypes
from pathlib import Path as FsPath

import httpx
from . import http
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from . import analysis, config
from .ratelimit import RateLimit
from .places import PLACES
from .sources import ornl, power

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
            if p.get("pilot"):
                from .screening import service
                clat, clon, h = service.snap(p["lat"], p["lon"], p["screen_km"])
                await service.area(clat, clon, h)
                if service.loss_ready():
                    service.start_loss(clat, clon, h, service.default_loss_end())
            log.info("prewarmed %s", pid)
            if p.get("pilot"):
                from .routes.methods import methods_info
                await methods_info()  # the Methods and landing pages read this; compute it before the first visitor
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
app.add_middleware(RateLimit, per_minute=config.RATE_LIMIT_PER_MINUTE, proxy_hops=config.TRUSTED_PROXY_HOPS)

from .routes import core, hazards, methods, screening, series  # noqa: E402
from .routes.common import SCREENING_NOTICE, _in_pilot, _screen_area  # noqa: E402,F401  (re-exported for tests and scripts)

for _r in (core.router, series.router, screening.router, hazards.router, methods.router):
    app.include_router(_r)


# ---------- hazard screening (landslides and flash floods) ----------


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
