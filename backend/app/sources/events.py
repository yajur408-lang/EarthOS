"""Nearby natural events and earthquakes, listed by date and distance (optional context).

* NASA EONET v3     - natural events (wildfires, storms, floods, volcanoes ...). NASA open data.
* USGS FDSN events  - earthquakes. US public domain.
"""

from __future__ import annotations

import datetime as dt
import math
import re

import httpx
from .. import http

from .. import config
from ..cache import cached_json

EONET = "https://eonet.gsfc.nasa.gov/api/v3/events"
USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"



def _dist_km(lat1, lon1, lat2, lon2) -> float:
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12_742 * math.asin(math.sqrt(a))


def _client() -> httpx.AsyncClient:
    return http.client(headers={"User-Agent": config.USER_AGENT}, timeout=30)


async def natural_events(lat: float, lon: float, radius_km: float = 500, days: int = 365) -> list[dict]:
    d = radius_km / 111
    dl = d / max(math.cos(math.radians(lat)), 0.05)
    bbox = f"{lon - dl},{lat + d},{lon + dl},{lat - d}"  # EONET order: minLon,maxLat,maxLon,minLat

    async def fetch():
        async with _client() as c:
            r = await c.get(EONET, params={"bbox": bbox, "status": "all", "days": days, "limit": 100})
            r.raise_for_status()
            return r.json().get("events", [])

    events = await cached_json(f"eonet_{round(lat, 1)}_{round(lon, 1)}_{radius_km}_{days}", fetch, max_age_days=0.25)
    out = []
    for e in events:
        geoms = [g for g in e.get("geometry", []) if g.get("type") == "Point"]
        if not geoms:
            continue
        nearest = min(geoms, key=lambda g: _dist_km(lat, lon, g["coordinates"][1], g["coordinates"][0]))
        out.append({
            # EONET titles end with an internal id ("Flood in Costa Rica 1104003"); drop it.
            "title": re.sub(r"\s+\d{5,}$", "", e["title"]),
            "category": ", ".join(c["title"] for c in e.get("categories", [])),
            "date": geoms[-1]["date"][:10],
            "first_date": geoms[0]["date"][:10],
            "closed": (e.get("closed") or "")[:10] or None,
            "distance_km": round(_dist_km(lat, lon, nearest["coordinates"][1], nearest["coordinates"][0])),
            "lat": nearest["coordinates"][1], "lon": nearest["coordinates"][0],
            "url": (e.get("sources") or [{}])[0].get("url") or e.get("link"),
            "source": "NASA EONET",
        })
    return sorted(out, key=lambda e: e["date"], reverse=True)


async def earthquakes(lat: float, lon: float, radius_km: float = 300, days: int = 365) -> list[dict]:
    start = (dt.date.today() - dt.timedelta(days=days)).isoformat()

    async def fetch():
        async with _client() as c:
            r = await c.get(USGS, params={"format": "geojson", "latitude": lat, "longitude": lon,
                                          "maxradiuskm": radius_km, "starttime": start, "minmagnitude": 3,
                                          "orderby": "time", "limit": 50})
            r.raise_for_status()
            return r.json().get("features", [])

    feats = await cached_json(f"usgs_{round(lat, 1)}_{round(lon, 1)}_{radius_km}_{start}", fetch, max_age_days=0.25)
    return [{
        "title": f["properties"]["title"],
        "magnitude": f["properties"]["mag"],
        "date": dt.datetime.fromtimestamp(f["properties"]["time"] / 1000, dt.UTC).strftime("%Y-%m-%d"),
        "distance_km": round(_dist_km(lat, lon, f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])),
        "depth_km": f["geometry"]["coordinates"][2],
        "lat": f["geometry"]["coordinates"][1], "lon": f["geometry"]["coordinates"][0],
        "url": f["properties"]["url"],
        "source": "USGS",
    } for f in feats]
