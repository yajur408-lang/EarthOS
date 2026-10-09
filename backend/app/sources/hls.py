"""Find recent, low-cloud 30 m Harmonized Landsat Sentinel-2 (HLS) passes over a point.

Uses the public NASA CMR granule search (metadata only, no login). The imagery itself is
displayed from NASA GIBS (HLS_S30 / HLS_L30 Nadir BRDF-Adjusted Reflectance layers).
Cloud cover is reported per ~110 km granule, so it is a guide rather than a guarantee.
"""

from __future__ import annotations

import asyncio
import datetime as dt

import httpx

from .. import config
from ..cache import cached_json

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
PRODUCTS = {"S30": "HLSS30", "L30": "HLSL30"}


async def _granules(client: httpx.AsyncClient, short_name: str, lat: float, lon: float, since: str) -> list[dict]:
    r = await client.get(CMR, params={
        "short_name": short_name, "version": "2.0", "point": f"{lon},{lat}",
        "temporal": f"{since}T00:00:00Z,", "sort_key": "-start_date", "page_size": 100,
    }, timeout=40)
    r.raise_for_status()
    return r.json()["feed"]["entry"]


async def passes(lat: float, lon: float, days: int = 180) -> list[dict]:
    lat, lon = round(lat, 2), round(lon, 2)
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()

    async def fetch():
        async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}) as client:
            results = await asyncio.gather(*(_granules(client, p, lat, lon, since) for p in PRODUCTS.values()))
        out = {}
        for sensor, entries in zip(PRODUCTS, results):
            for e in entries:
                date = e["time_start"][:10]
                cloud = float(e.get("cloud_cover") or 100)
                key = (sensor, date)
                # A point can sit in two overlapping granules; keep the clearer one.
                if key not in out or cloud < out[key]["cloud_pct"]:
                    out[key] = {"sensor": sensor, "date": date, "cloud_pct": cloud}
        return sorted(out.values(), key=lambda p: p["date"], reverse=True)

    return await cached_json(f"hls_{lat}_{lon}_{since}", fetch, max_age_days=0.25)
