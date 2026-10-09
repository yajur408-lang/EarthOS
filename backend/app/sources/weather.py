"""Weather forecast from MET Norway Locationforecast 2.0 (global, CC BY 4.0).

Terms: https://api.met.no/doc/TermsOfService - identify with a User-Agent, cache, respect Expires.
"""

from __future__ import annotations

import httpx

from .. import config
from ..cache import cached_json

URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"


async def forecast(lat: float, lon: float) -> dict:
    # MET asks for coordinates truncated to 4 decimals; 2 is plenty and caches better.
    lat, lon = round(lat, 2), round(lon, 2)

    async def fetch():
        async with httpx.AsyncClient() as client:
            r = await client.get(URL, params={"lat": lat, "lon": lon},
                                 headers={"User-Agent": config.USER_AGENT}, timeout=20)
            r.raise_for_status()
            return r.json()

    data = await cached_json(f"metno_{lat}_{lon}", fetch, max_age_days=1 / 24)  # hourly refresh
    props = data["properties"]
    hours = []
    for t in props["timeseries"]:
        inst = t["data"]["instant"]["details"]
        nxt = t["data"].get("next_1_hours") or t["data"].get("next_6_hours") or {}
        hours.append({
            "time": t["time"],
            "temp_c": inst.get("air_temperature"),
            "humidity_pct": inst.get("relative_humidity"),
            "wind_m_s": inst.get("wind_speed"),
            "wind_from_deg": inst.get("wind_from_direction"),
            "cloud_pct": inst.get("cloud_area_fraction"),
            "pressure_hpa": inst.get("air_pressure_at_sea_level"),
            "precip_mm": (nxt.get("details") or {}).get("precipitation_amount"),
            "precip_hours": 1 if "next_1_hours" in t["data"] else 6,
            "symbol": (nxt.get("summary") or {}).get("symbol_code"),
        })
    return {
        "updated": props["meta"]["updated_at"],
        "hours": hours,
        "attribution": "Forecast: MET Norway (api.met.no), CC BY 4.0",
    }
