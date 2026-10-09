"""Street-level imagery from open, CC BY-SA 4.0 sources.

* KartaView (Grab) - public API, no key.  https://kartaview.org
* Mapillary (Meta) - used when MAPILLARY_TOKEN is set in backend/.env.  https://www.mapillary.com

Google Street View is deliberately not used: its terms forbid showing it with a non-Google map.
Images are proxied by id only (never by caller-supplied URL), which keeps tokens server-side.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import math

import httpx

from .. import config
from ..cache import cached_json

KV = "https://api.openstreetcam.org/2.0"
MLY = "https://graph.mapillary.com"
MLY_FIELDS = "id,captured_at,compass_angle,is_pano,geometry,sequence,thumb_256_url,thumb_2048_url,creator"


def _dist_m(lat1, lon1, lat2, lon2) -> float:
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12_742_000 * math.asin(math.sqrt(a))


def _kv_item(d: dict, lat: float, lon: float) -> dict:
    return {
        "provider": "kartaview", "id": str(d["id"]),
        "lat": float(d["lat"]), "lon": float(d["lng"]),
        "distance_m": round(_dist_m(lat, lon, float(d["lat"]), float(d["lng"])), 1),
        "captured": (d.get("shotDate") or d.get("dateAdded") or "")[:10],
        "heading": float(d["heading"]) if d.get("heading") not in (None, "") else None,
        "pano": (d.get("projection") or "").upper() == "SPHERE",
        "sequence": str(d.get("sequenceId")), "sequence_index": int(d.get("sequenceIndex") or 0),
        "author": None,
        "page": f"https://kartaview.org/details/{d.get('sequenceId')}/{d.get('sequenceIndex')}",
    }


def _mly_item(d: dict, lat: float, lon: float) -> dict:
    lon2, lat2 = d["geometry"]["coordinates"]
    return {
        "provider": "mapillary", "id": str(d["id"]), "lat": lat2, "lon": lon2,
        "distance_m": round(_dist_m(lat, lon, lat2, lon2), 1),
        "captured": dt.datetime.fromtimestamp(d["captured_at"] / 1000, dt.UTC).strftime("%Y-%m-%d"),
        "heading": d.get("compass_angle"), "pano": bool(d.get("is_pano")),
        "sequence": d.get("sequence"), "sequence_index": None,
        "author": (d.get("creator") or {}).get("username"),
        "page": f"https://www.mapillary.com/app/?pKey={d['id']}",
    }


async def _kartaview_near(client: httpx.AsyncClient, lat: float, lon: float) -> list[dict]:
    # The API times out on wide searches, so widen the radius step by step.
    for radius in (60, 200, 600):
        async def fetch(radius=radius):
            r = await client.get(f"{KV}/photo/", params={"lat": lat, "lng": lon, "radius": radius, "itemsPerPage": 100,
                                                         "orderBy": "distance"}, timeout=25)
            r.raise_for_status()
            return (r.json().get("result") or {}).get("data") or []
        try:
            data = await cached_json(f"kv_{round(lat, 4)}_{round(lon, 4)}_{radius}", fetch, max_age_days=14)
        except (httpx.HTTPError, ValueError):
            continue
        if data:
            return [_kv_item(d, lat, lon) for d in data]
    return []


async def _mapillary_near(client: httpx.AsyncClient, lat: float, lon: float) -> list[dict]:
    if not config.MAPILLARY_TOKEN:
        return []
    for half in (0.0005, 0.002, 0.006):  # ~50 m, 200 m, 600 m
        async def fetch(half=half):
            r = await client.get(f"{MLY}/images", params={
                "bbox": f"{lon - half},{lat - half},{lon + half},{lat + half}", "fields": MLY_FIELDS, "limit": 200,
            }, headers={"Authorization": f"OAuth {config.MAPILLARY_TOKEN}"}, timeout=25)
            r.raise_for_status()
            return r.json().get("data") or []
        try:
            data = await cached_json(f"mly_{round(lat, 4)}_{round(lon, 4)}_{half}", fetch, max_age_days=7)
        except (httpx.HTTPError, ValueError):
            return []
        if data:
            return [_mly_item(d, lat, lon) for d in data]
    return []


async def nearby(lat: float, lon: float) -> dict:
    async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}) as client:
        kv, mly = await asyncio.gather(_kartaview_near(client, lat, lon), _mapillary_near(client, lat, lon))
    items = sorted(kv + mly, key=lambda i: i["distance_m"])[:150]
    names = [n for p, n in (("kartaview", "KartaView"), ("mapillary", "Mapillary")) if any(i["provider"] == p for i in items)]
    return {
        "items": items,
        "providers": {"kartaview": True, "mapillary": bool(config.MAPILLARY_TOKEN)},
        "attribution": f"Street-level imagery: {' and '.join(n + ' contributors' for n in names) or 'KartaView and Mapillary'}, CC BY-SA 4.0",
    }


async def image_url(provider: str, image_id: str, size: str) -> str | None:
    """Resolve an image id to its CDN URL via the provider API (cached)."""
    async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}) as client:
        if provider == "kartaview":
            async def fetch():
                r = await client.get(f"{KV}/photo/{image_id}", timeout=25)
                r.raise_for_status()
                return (r.json().get("result") or {}).get("data") or {}
            d = await cached_json(f"kvimg_{image_id}", fetch, max_age_days=30)
            return d.get("imageThUrl") if size == "thumb" else (d.get("imageProcUrl") or d.get("imageLthUrl"))
        if provider == "mapillary" and config.MAPILLARY_TOKEN:
            async def fetch():
                r = await client.get(f"{MLY}/{image_id}", params={"fields": "thumb_256_url,thumb_2048_url"},
                                     headers={"Authorization": f"OAuth {config.MAPILLARY_TOKEN}"}, timeout=25)
                r.raise_for_status()
                return r.json()
            # Mapillary CDN links expire, so keep this cache short.
            d = await cached_json(f"mlyimg_{image_id}", fetch, max_age_days=0.5)
            return d.get("thumb_256_url") if size == "thumb" else d.get("thumb_2048_url")
    return None


async def sequence_neighbours(provider: str, sequence: str, index: int) -> dict:
    """Previous/next images in a KartaView sequence (drive forward/back like Street View)."""
    if provider != "kartaview":
        return {"prev": None, "next": None}
    async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}) as client:
        async def get(i):
            async def fetch():
                r = await client.get(f"{KV}/photo/", params={"sequenceId": sequence, "sequenceIndex": i}, timeout=25)
                r.raise_for_status()
                data = (r.json().get("result") or {}).get("data") or []
                return data[0] if data else None
            try:
                d = await cached_json(f"kvseq_{sequence}_{i}", fetch, max_age_days=30)
            except (httpx.HTTPError, ValueError):
                return None
            return _kv_item(d, float(d["lat"]), float(d["lng"])) if d else None
        prev, nxt = await asyncio.gather(get(index - 1), get(index + 1)) if index > 0 else (None, await get(index + 1))
    return {"prev": prev, "next": nxt}
