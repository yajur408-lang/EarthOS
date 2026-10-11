"""Natural hazards that touched a place: what happened, when, how close, and which satellite check fits.

Sources (all open):
- Tropical cyclones: NOAA NCEI IBTrACS v04r01 since 1980 (bundled, see scripts/build_hazard_catalogs.py).
- Tornadoes: NOAA Storm Prediction Center database since 1950 (United States only; bundled).
- Earthquakes: USGS ComCat (FDSN event API), magnitude 4.5+.
- Wildfires, volcanoes, floods, severe storms, drought, landslides: NASA EONET v3 (about 2015 onwards).
- Landslides: NASA Global Landslide Catalog 2007-2017 and local reports (as in the backtest).

Each event says how far its closest point came and suggests the satellite comparison that suits it
(vegetation damage, burn scar or flood water) - it never says what damage happened.
"""

from __future__ import annotations

import csv
import datetime as dt
import gzip
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

from .. import http
from ..cache import cached_json
from . import trigger

DATA = Path(__file__).parent / "data"
EONET = "https://eonet.gsfc.nasa.gov/api/v3/events"
USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"

# How each hazard type is checked from space (index, change direction, windows in days).
CHECKS = {
    "cyclone": {"index": "NDVI", "label": "vegetation damage (NDVI drop)", "before": 60, "after": 45},
    "tornado": {"index": "NDVI", "label": "damage track (NDVI drop)", "before": 60, "after": 45},
    "landslide": {"index": "NDVI", "label": "new bare ground (NDVI drop)", "before": 90, "after": 60},
    "earthquake": {"index": "NDVI", "label": "landslides / bare ground (NDVI drop)", "before": 90, "after": 60},
    "wildfire": {"index": "NBR", "label": "burn scar (NBR drop)", "before": 60, "after": 45},
    "volcano": {"index": "NDVI", "label": "ash or lava cover (NDVI drop)", "before": 90, "after": 60},
    "flood": {"index": "NDWI", "label": "standing water (NDWI rise)", "before": 60, "after": 12},
    "storm": {"index": "NDVI", "label": "vegetation damage (NDVI drop)", "before": 60, "after": 45},
}
TYPE_NAMES = {"cyclone": "Tropical cyclone", "tornado": "Tornado", "earthquake": "Earthquake", "wildfire": "Wildfire",
              "volcano": "Volcano", "flood": "Flood", "landslide": "Landslide", "storm": "Severe storm", "drought": "Drought"}
EONET_TYPES = {"wildfires": "wildfire", "volcanoes": "volcano", "floods": "flood", "severeStorms": "storm",
               "landslides": "landslide", "drought": "drought"}
SOURCES = {
    "cyclone": {"name": "NOAA NCEI IBTrACS v04r01", "url": "https://www.ncei.noaa.gov/products/international-best-track-archive",
                "citation": "Knapp et al. (2010) BAMS 91:363-376; Gahtan et al. (2024) doi:10.25921/82ty-9e16"},
    "tornado": {"name": "NOAA Storm Prediction Center tornado database (US)", "url": "https://www.spc.noaa.gov/wcm/"},
    "earthquake": {"name": "USGS Earthquake Catalog (ComCat)", "url": "https://earthquake.usgs.gov/earthquakes/search/"},
    "eonet": {"name": "NASA EONET v3", "url": "https://eonet.gsfc.nasa.gov/"},
    "landslide": trigger.GLC_SOURCE,
}
RADIUS_KM = {"cyclone": 200, "tornado": 40, "earthquake": 150, "eonet": 100, "landslide": 25}


def _km(lat1, lon1, lat2, lon2):
    """Haversine distance (km); works on numpy arrays."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(np.asarray(lon2) - lon1) / 2) ** 2
    return 6371 * 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


@lru_cache(maxsize=1)
def _cyclones():
    with gzip.open(DATA / "ibtracs.csv.gz", "rt", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return {
        "sid": np.array([r["sid"] for r in rows]),
        "name": np.array([r["name"] for r in rows]),
        "time": np.array([r["time"] for r in rows]),
        "lat": np.array([float(r["lat"]) for r in rows]),
        "lon": np.array([float(r["lon"]) for r in rows]),
        "wind": np.array([float(r["wind_kt"]) if r["wind_kt"] else np.nan for r in rows]),
        "sshs": np.array([float(r["sshs"]) if r["sshs"] else np.nan for r in rows]),
    }


@lru_cache(maxsize=1)
def _tornadoes():
    with gzip.open(DATA / "spc_tornadoes.csv.gz", "rt", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    cols = {k: np.array([float(r[k]) for r in rows]) for k in ("slat", "slon", "elat", "elon", "len_mi", "wid_yd")}
    return {**cols, "date": np.array([r["date"] for r in rows]), "state": np.array([r["state"] for r in rows]),
            "ef": np.array([int(float(r["ef"])) for r in rows]), "fat": np.array([int(float(r["fatalities"])) for r in rows]),
            "inj": np.array([int(float(r["injuries"])) for r in rows])}


def _category(wind_kt: float) -> str:
    if not wind_kt == wind_kt:
        return "intensity unknown"
    if wind_kt >= 64:
        cat = 1 if wind_kt < 83 else 2 if wind_kt < 96 else 3 if wind_kt < 113 else 4 if wind_kt < 137 else 5
        return f"hurricane-strength, Saffir-Simpson category {cat} winds"
    return "tropical storm" if wind_kt >= 34 else "tropical depression"


def cyclones_near(lat: float, lon: float, radius: float, start: dt.date, end: dt.date) -> list[dict]:
    c = _cyclones()
    box = (np.abs(c["lat"] - lat) < radius / 100) & (np.abs(((c["lon"] - lon + 180) % 360) - 180) < radius / (100 * max(math.cos(math.radians(lat)), 0.2)))
    idx = np.nonzero(box)[0]
    if not len(idx):
        return []
    d = _km(lat, lon, c["lat"][idx], c["lon"][idx])
    near = idx[d <= radius]
    dist = d[d <= radius]
    out: dict[str, dict] = {}
    for i, km in zip(near, dist):
        day = c["time"][i][:10]
        if not (start.isoformat() <= day <= end.isoformat()):
            continue
        sid = c["sid"][i]
        e = out.get(sid)
        wind = c["wind"][i]
        if e is None or km < e["distance_km"]:
            out[sid] = {**(e or {}), "distance_km": float(km), "date": day, "lat": float(c["lat"][i]), "lon": float(c["lon"][i]),
                        "wind_at_closest_kt": None if wind != wind else float(wind), "sid": sid, "name": c["name"][i]}
        e = out[sid]
        if wind == wind:
            e["max_wind_nearby_kt"] = max(e.get("max_wind_nearby_kt") or 0, float(wind))
    events = []
    for e in out.values():
        name = e["name"] if e["name"] and e["name"].lower() not in ("not_named", "unnamed") else "Unnamed system"
        mw = e.get("max_wind_nearby_kt")
        events.append({
            "type": "cyclone", "title": f"{name} ({e['date'][:4]})", "date": e["date"], "lat": e["lat"], "lon": e["lon"],
            "distance_km": round(e["distance_km"], 1),
            "detail": (f"closest approach {round(e['distance_km'])} km; strongest winds within {radius} km: "
                       f"{round(mw * 1.852) if mw else '?'} km/h, {_category(mw or float('nan'))}"),
            "severity": mw or 0, "source": "cyclone", "id": e["sid"],
        })
    return events


def tornadoes_near(lat: float, lon: float, radius: float, start: dt.date, end: dt.date) -> list[dict]:
    t = _tornadoes()
    sel = (np.abs(t["slat"] - lat) < radius / 90) & (np.abs(t["slon"] - lon) < radius / (90 * max(math.cos(math.radians(lat)), 0.2)))
    sel &= (t["date"] >= start.isoformat()) & (t["date"] <= end.isoformat())
    events = []
    for i in np.nonzero(sel)[0]:
        # Distance from the place to the straight start-end path.
        ys, xs = t["slat"][i], t["slon"][i]
        ye, xe = t["elat"][i], t["elon"][i]
        k = math.cos(math.radians(lat))
        ax, ay, bx, by = (xs - lon) * k, ys - lat, (xe - lon) * k, ye - lat
        dx, dy = bx - ax, by - ay
        u = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        px, py = ax + u * dx, ay + u * dy
        km = math.hypot(px, py) * 111.2
        if km > radius:
            continue
        ef = int(t["ef"][i])
        scale = "EF" if t["date"][i] >= "2007-02-01" else "F"
        events.append({
            "type": "tornado", "title": f"{scale}{ef if ef >= 0 else '?'} tornado, {t['state'][i]}", "date": t["date"][i],
            "lat": float(lat + py), "lon": float(lon + px / k), "distance_km": round(km, 1),
            "detail": f"path {t['len_mi'][i] * 1.609:.1f} km long, {t['wid_yd'][i] * 0.914:.0f} m wide; "
                      f"{int(t['fat'][i])} deaths, {int(t['inj'][i])} injuries reported",
            "severity": ef, "source": "tornado",
            "path": [[float(ys), float(xs)], [float(ye), float(xe)]],
        })
    return events


async def earthquakes_near(lat: float, lon: float, radius: float, start: dt.date, end: dt.date) -> list[dict]:
    async def fetch():
        async with http.client() as client:
            r = await client.get(USGS, params={
                "format": "geojson", "latitude": lat, "longitude": lon, "maxradiuskm": radius,
                "starttime": start.isoformat(), "endtime": end.isoformat(), "minmagnitude": 4.5,
                "orderby": "magnitude", "limit": 100}, timeout=60)
            r.raise_for_status()
            return r.json()
    data = await cached_json(f"usgsq_{lat:.2f}_{lon:.2f}_{radius}_{start}_{end}", fetch,
                             max_age_days=None if end < dt.date.today() - dt.timedelta(days=30) else 0.25)
    out = []
    for f in data.get("features", []):
        p = f["properties"]
        qlon, qlat, depth = f["geometry"]["coordinates"]
        out.append({
            "type": "earthquake", "title": f"M{p['mag']:.1f} - {p.get('place') or 'earthquake'}",
            "date": dt.datetime.fromtimestamp(p["time"] / 1000, dt.timezone.utc).date().isoformat(),
            "lat": qlat, "lon": qlon, "distance_km": round(float(_km(lat, lon, qlat, qlon)), 1),
            "detail": f"magnitude {p['mag']}, depth {depth:.0f} km" + (f"; felt reports: {p['felt']}" if p.get("felt") else ""),
            "severity": p["mag"], "source": "earthquake", "link": p.get("url"),
        })
    return out


async def eonet_near(lat: float, lon: float, radius: float, start: dt.date, end: dt.date) -> list[dict]:
    dlat = radius / 111
    dlon = radius / (111 * max(math.cos(math.radians(lat)), 0.2))

    async def fetch():
        async with http.client() as client:
            r = await client.get(EONET, params={
                "status": "all", "start": start.isoformat(), "end": end.isoformat(), "limit": 500,
                "bbox": f"{lon - dlon},{lat + dlat},{lon + dlon},{lat - dlat}"}, timeout=60)
            r.raise_for_status()
            return r.json()
    data = await cached_json(f"eonetq_{lat:.2f}_{lon:.2f}_{radius}_{start}_{end}", fetch,
                             max_age_days=None if end < dt.date.today() - dt.timedelta(days=30) else 0.25)
    out = []
    for e in data.get("events", []):
        kind = EONET_TYPES.get(e["categories"][0]["id"]) if e.get("categories") else None
        if not kind:
            continue
        best = None
        for g in e.get("geometry", []):
            if g.get("type") != "Point":
                continue
            glon, glat = g["coordinates"][:2]
            km = float(_km(lat, lon, glat, glon))
            if best is None or km < best[0]:
                best = (km, glat, glon, g["date"][:10])
        if not best or best[0] > radius:
            continue
        src = (e.get("sources") or [{}])[0]
        out.append({
            "type": kind, "title": e["title"], "date": best[3], "lat": best[1], "lon": best[2],
            "distance_km": round(best[0], 1), "detail": f"reported by {src.get('id', 'EONET')}", "severity": 0,
            "source": "eonet", "link": src.get("url"),
        })
    return out


def landslides_near(lat: float, lon: float, radius: float, start: dt.date, end: dt.date) -> list[dict]:
    out = []
    for e in trigger.events_near(lat, lon, radius):
        if start.isoformat() <= e["date"] <= end.isoformat():
            out.append({
                "type": "landslide", "title": e["title"], "date": e["date"], "lat": e["lat"], "lon": e["lon"],
                "distance_km": e["distance_km"], "severity": float(e["fatalities"] or 0),
                "detail": f"trigger: {e['trigger'] or 'unknown'}" + (f"; {e['fatalities']} deaths reported" if e["fatalities"] not in ("", "0") else ""),
                "source": "landslide", "link": e["source"] if e["source"].startswith("http") else None,
            })
    return out


async def near(lat: float, lon: float, start: dt.date, end: dt.date) -> dict:
    import asyncio
    errors = []
    parts = [cyclones_near(lat, lon, RADIUS_KM["cyclone"], start, end),
             tornadoes_near(lat, lon, RADIUS_KM["tornado"], start, end),
             landslides_near(lat, lon, RADIUS_KM["landslide"], start, end)]
    remote = await asyncio.gather(earthquakes_near(lat, lon, RADIUS_KM["earthquake"], start, end),
                                  eonet_near(lat, lon, RADIUS_KM["eonet"], start, end), return_exceptions=True)
    for name, res in zip(("USGS earthquakes", "NASA EONET"), remote):
        if isinstance(res, Exception):
            errors.append(f"{name} unavailable: {type(res).__name__}")
        else:
            parts.append(res)
    events = [e for p in parts for e in p]
    for e in events:
        e["type_name"] = TYPE_NAMES.get(e["type"], e["type"])
        chk = CHECKS.get(e["type"])
        e["satellite_check"] = None if not chk or e["date"] < "2013-06-01" else chk["label"]
    events.sort(key=lambda e: e["date"], reverse=True)
    counts: dict[str, int] = {}
    for e in events:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    return {
        "period": [start.isoformat(), end.isoformat()],
        "radius_km": RADIUS_KM,
        "counts": counts,
        "events": events[:300],
        "errors": errors,
        "sources": SOURCES,
        "coverage": [
            "Tornado records cover the United States only (NOAA SPC). Elsewhere, look for damage tracks with the 30 m change check.",
            "Cyclone tracks are 6-hourly centre positions; strong winds can extend well beyond the listed closest approach.",
            "NASA EONET lists notable events from about 2015 and is not complete.",
            "Satellite checks need HLS imagery, which starts in 2013 (Landsat 8) and 2015 (Sentinel-2).",
        ],
    }
