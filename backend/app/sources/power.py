"""Daily weather and surface variables from NASA POWER (MERRA-2 / CERES based, 0.5° x 0.625°).

Chosen over the free Open-Meteo tier because NASA POWER data carry no
commercial-use restriction. Docs: https://power.larc.nasa.gov/docs/services/api/
"""

from __future__ import annotations

import datetime as dt

import httpx
import numpy as np
import pandas as pd

from ..cache import cached_json

URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
FILL = -999.0

# POWER parameter -> column name
PARAMS = {
    "PRECTOTCORR": "precip_mm",
    "T2M_MAX": "tmax_c",
    "T2M_MIN": "tmin_c",
    "RH2M": "humidity_pct",
    "ALLSKY_SFC_SW_DWN": "solar_kwh_m2",  # all-sky surface shortwave, kWh/m²/day
    "CLOUD_AMT": "cloud_pct",
    "WS2M": "wind_m_s",
    "GWETROOT": "soil_wetness",  # root-zone soil wetness, 0-1
}


async def daily_climate(lat: float, lon: float, start: str, end: str) -> pd.DataFrame:
    latest = (dt.date.today() - dt.timedelta(days=3)).isoformat()
    end = min(end, latest)

    async def fetch():
        async with httpx.AsyncClient() as client:
            r = await client.get(URL, params={
                "parameters": ",".join(PARAMS),
                "community": "AG",
                "latitude": lat, "longitude": lon,
                "start": start.replace("-", ""), "end": end.replace("-", ""),
                "format": "JSON",
            }, timeout=120)
            r.raise_for_status()
            return r.json()["properties"]["parameter"]

    p = await cached_json(f"power8_{round(lat, 2)}_{round(lon, 2)}_{start}_{end}", fetch, max_age_days=7)
    df = pd.DataFrame({col: p[key] for key, col in PARAMS.items() if key in p})
    df.index = pd.to_datetime(df.index, format="%Y%m%d")
    return df.astype(float).replace(FILL, np.nan)
