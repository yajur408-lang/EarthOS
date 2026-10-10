"""Place search and reverse geocoding via OpenStreetMap Nominatim.

Follows the usage policy (https://operations.osmfoundation.org/policies/nominatim/):
server-side proxy, identifying User-Agent, <= 1 request/second, every result cached,
search only on explicit submit (no autocomplete), ODbL attribution in the UI.
For a high-traffic or paid deployment, switch NOMINATIM_URL to a self-hosted instance
or a commercial provider.
"""

from __future__ import annotations

import asyncio
import time

import httpx
from .. import http

from .. import config
from ..cache import cached_json

_lock = asyncio.Lock()
_last = 0.0


async def _request(path: str, params: dict) -> list | dict:
    global _last
    async with _lock:  # serialise and space requests >= 1 s apart
        wait = 1.0 - (time.monotonic() - _last)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with http.client() as client:
                r = await client.get(f"{config.NOMINATIM_URL}/{path}",
                                     params={**params, "format": "jsonv2"},
                                     headers={"User-Agent": config.USER_AGENT}, timeout=20)
                r.raise_for_status()
                return r.json()
        finally:
            _last = time.monotonic()


def _bbox(item: dict) -> list[float] | None:
    b = item.get("boundingbox")
    return [float(b[0]), float(b[1]), float(b[2]), float(b[3])] if b else None  # south, north, west, east


async def search(q: str) -> list[dict]:
    q = " ".join(q.split())[:200]

    async def fetch():
        return await _request("search", {"q": q, "limit": 6, "accept-language": "en"})

    items = await cached_json(f"geo_search_{q.lower()}", fetch, max_age_days=30)
    return [{"name": i.get("name") or i["display_name"].split(",")[0],
             "label": i["display_name"],
             "type": i.get("type"),
             "lat": float(i["lat"]), "lon": float(i["lon"]),
             "bbox": _bbox(i)} for i in items]


async def reverse(lat: float, lon: float) -> dict | None:
    lat, lon = round(lat, 3), round(lon, 3)  # ~100 m: plenty for a place label and keeps the cache small

    async def fetch():
        return await _request("reverse", {"lat": lat, "lon": lon, "zoom": 10, "accept-language": "en"})

    item = await cached_json(f"geo_reverse_{lat}_{lon}", fetch, max_age_days=90)
    if not item or "error" in item:
        return None
    a = item.get("address", {})
    locality = a.get("city") or a.get("town") or a.get("village") or a.get("county") or a.get("state_district")
    region = a.get("state") or a.get("region")
    return {"name": locality or region or item.get("name") or "Unnamed area",
            "label": ", ".join(x for x in [locality, region, a.get("country")] if x),
            "country": a.get("country")}
