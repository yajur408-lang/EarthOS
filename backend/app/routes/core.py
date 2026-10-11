"""Places, geocoding, terrain, extra MODIS series, street imagery, weather, events, sharp imagery, health."""

from __future__ import annotations

import asyncio
import datetime as dt

import httpx
from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Path
from fastapi import Query
from fastapi import Request
from fastapi.responses import Response

from .. import config
from .. import http
from ..datasets import DATASETS
from ..places import PLACES
from ..ratelimit import client_ip
from ..sources import events
from ..sources import hls
from ..sources import nominatim
from ..sources import ornl
from ..sources import street
from ..sources import terrain
from ..sources import weather

from .common import LatQ
from .common import LonQ

router = APIRouter()


@router.get("/api/health")
def health(request: Request):
    # xff_entries: how many X-Forwarded-For entries this request arrived with. Sent without the header, it equals the
    # number of proxies in front of the app, which is what TRUSTED_PROXY_HOPS must be set to for the rate limiter.
    # rate_limited_as: the address the rate limiter uses for this caller, last part masked, so the hop count can be
    # checked (it should be the caller's own address even when they send a forged X-Forwarded-For).
    fwd = request.headers.get("x-forwarded-for", "")
    ip = client_ip(request, config.TRUSTED_PROXY_HOPS)
    masked = ip.rsplit(".", 1)[0] + ".x" if ip.count(".") == 3 else ip.rsplit(":", 2)[0] + ":x"
    return {"ok": True, "keys": config.key_status(), "xff_entries": len([h for h in fwd.split(",") if h.strip()]),
            "rate_limited_as": masked}

@router.get("/api/places")
def places():
    return PLACES

@router.get("/api/geocode")
async def geocode(q: str = Query(..., min_length=2, max_length=200)):
    try:
        return await nominatim.search(q)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Place search unavailable: {e}") from e

@router.get("/api/reverse")
async def reverse(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    try:
        return await nominatim.reverse(lat, lon)
    except httpx.HTTPError:
        return None  # a missing place name never blocks the data view

@router.get("/api/datasets")
def datasets():
    return DATASETS

@router.get("/api/terrain")
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

@router.get("/api/extra/{kind}")
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

@router.get("/api/street")
async def street_nearby(lat: float = LatQ, lon: float = LonQ):
    return await street.nearby(lat, lon)

@router.get("/api/street/image/{provider}/{image_id}")
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

@router.get("/api/street/sequence/{provider}/{sequence}/{index}")
async def street_sequence(provider: str = Path(..., pattern="^(kartaview|mapillary)$"),
                          sequence: str = Path(..., pattern=r"^[0-9A-Za-z_-]{1,64}$"), index: int = Path(..., ge=0)):
    return await street.sequence_neighbours(provider, sequence, index)

@router.get("/api/weather")
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

@router.get("/api/events")
async def nearby_events(lat: float = LatQ, lon: float = LonQ):
    """Nearby natural events and earthquakes (optional context, hidden by default in the UI)."""
    (nat, e1), (eq, e2) = await asyncio.gather(_safe(events.natural_events(lat, lon)), _safe(events.earthquakes(lat, lon)))
    return {
        "natural": nat, "earthquakes": eq,
        "errors": {k: v for k, v in {"natural": e1, "earthquakes": e2}.items() if v},
        "attribution": "NASA EONET · USGS Earthquake Hazards Program",
    }

@router.get("/api/sharp-imagery")
async def sharp_imagery(lat: float = LatQ, lon: float = LonQ,
                        date: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$")):
    """30 m HLS passes over a point around a date (default today), with granule cloud cover."""
    try:
        around = dt.date.fromisoformat(date) if date else dt.date.today()
        return {"passes": await hls.passes(lat, lon, around),
                "attribution": "NASA HLS v2.0 (Landsat 8/9 OLI, Sentinel-2 MSI) via NASA GIBS; contains modified Copernicus Sentinel data"}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"NASA CMR unavailable: {e}") from e
