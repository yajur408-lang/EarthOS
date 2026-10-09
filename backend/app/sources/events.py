"""Nearby natural events, earthquakes, disease-outbreak notices and news headlines.

Listed by distance/date as published - EarthOS does not link them to the
environmental data or draw conclusions from them.

* NASA EONET v3       - natural events (wildfires, storms, floods, volcanoes ...). NASA open data.
* USGS FDSN events    - earthquakes. US public domain.
* WHO Disease Outbreak News - titles and links only (WHO content is copyrighted; we link out).
* GDELT DOC 2.0       - news headlines and links. Free for any use with citation.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import math
import time

import httpx

from .. import config
from ..cache import cached_json

EONET = "https://eonet.gsfc.nasa.gov/api/v3/events"
USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"
WHO = "https://www.who.int/api/news/diseaseoutbreaknews"
GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"

_gdelt_lock = asyncio.Lock()
_gdelt_last = 0.0


def _dist_km(lat1, lon1, lat2, lon2) -> float:
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12_742 * math.asin(math.sqrt(a))


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}, timeout=30)


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
            "title": e["title"],
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


async def outbreaks(country: str | None, limit: int = 40) -> list[dict]:
    async def fetch():
        async with _client() as c:
            r = await c.get(WHO, params={"$top": limit, "$orderby": "PublicationDate desc",
                                         "$select": "Title,PublicationDate,ItemDefaultUrl,UrlName"})
            r.raise_for_status()
            return r.json().get("value", [])

    items = await cached_json(f"who_don_{limit}", fetch, max_age_days=0.5)
    out = []
    for i in items:
        title = i.get("Title") or ""
        slug = i.get("ItemDefaultUrl") or i.get("UrlName") or ""
        out.append({
            "title": title,
            "date": (i.get("PublicationDate") or "")[:10],
            "url": f"https://www.who.int/emergencies/disease-outbreak-news/item{slug if slug.startswith('/') else '/' + slug}",
            "matches_country": bool(country) and country.lower() in title.lower(),
            "source": "WHO Disease Outbreak News",
        })
    # Newest first, with notices naming the country floated to the top.
    out.sort(key=lambda i: i["date"], reverse=True)
    out.sort(key=lambda i: not i["matches_country"])
    return out


ENV_TERMS = ("drought OR flood OR flooding OR wildfire OR heatwave OR \"heat wave\" OR deforestation OR pollution "
             "OR hurricane OR cyclone OR landslide OR outbreak OR epidemic OR \"crop\" OR storm")


async def news(place: str | None, country: str | None, days: int = 30) -> list[dict]:
    """Recent environment-related headlines mentioning the place or country (GDELT allows ~1 request / 5 s)."""
    names = [n for n in dict.fromkeys([place, country]) if n]
    where = " OR ".join(f'"{n}"' for n in names)
    query = f"({where}) ({ENV_TERMS})" if len(names) > 1 else f"{where} ({ENV_TERMS})"

    async def fetch():
        global _gdelt_last
        async with _gdelt_lock:
            wait = 5.5 - (time.monotonic() - _gdelt_last)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                async with _client() as c:
                    for attempt in range(2):
                        r = await c.get(GDELT, params={"query": query, "mode": "artlist", "format": "json",
                                                       "maxrecords": 40, "timespan": f"{days}d", "sort": "datedesc"})
                        body = r.text.strip()
                        if r.status_code != 429:
                            r.raise_for_status()
                        if r.status_code == 200 and body.startswith("{"):
                            return r.json().get("articles", [])
                        if r.status_code == 200 and not body:
                            return []  # GDELT answers an empty body when nothing matches
                        await asyncio.sleep(6)  # plain-text reply = rate limited; retry once
                    # Raising (not returning []) keeps the refusal out of the cache.
                    raise ValueError("GDELT is limiting requests from this network right now; try again in a few minutes.")
            finally:
                _gdelt_last = time.monotonic()

    arts = await cached_json(f"gdelt_{'_'.join(names).lower()}_{days}", fetch, max_age_days=0.25)
    seen, out = set(), []
    for a in arts:
        t = (a.get("title") or "").strip()
        if not t or t.lower() in seen:
            continue
        seen.add(t.lower())
        sd = a.get("seendate") or ""
        out.append({"title": t, "url": a.get("url"), "domain": a.get("domain"), "language": a.get("language"),
                    "date": f"{sd[:4]}-{sd[4:6]}-{sd[6:8]}" if len(sd) >= 8 else None, "source": "GDELT"})
    return out
