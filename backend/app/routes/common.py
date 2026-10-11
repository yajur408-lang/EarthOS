"""Shared query parameters and helpers for the API routers."""

from __future__ import annotations

import math

from fastapi import Query



def _num(x: float) -> float | None:
    return None if math.isnan(x) else round(float(x), 2)

def _json_default(o):
    if hasattr(o, "item"):  # numpy scalars
        return o.item()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    raise TypeError(type(o))

LatQ = Query(..., ge=-90, le=90)

LonQ = Query(..., ge=-180, le=180)

SCREENING_NOTICE = "Screening tool, not an official warning."

def _official_links(country: str | None) -> list[dict]:
    links = []
    if country == "Costa Rica":
        links += [
            {"name": "CNE - Comisión Nacional de Prevención de Riesgos y Atención de Emergencias", "url": "https://www.cne.go.cr"},
            {"name": "IMN - Instituto Meteorológico Nacional (avisos)", "url": "https://www.imn.ac.cr/avisos"},
        ]
    links += [
        {"name": "WMO Severe Weather Information Centre (national services worldwide)", "url": "https://severeweather.wmo.int"},
        {"name": "GDACS - Global Disaster Alert and Coordination System", "url": "https://www.gdacs.org"},
    ]
    return links

def _in_pilot(lat: float, lon: float) -> bool:
    """Inside the Santa Ana pilot box, where the rainfall thresholds were set (they aren't validated elsewhere)."""
    from ..places import PILOT
    return abs(lat - PILOT["lat"]) <= PILOT["screen_km"] / 110.6 and abs(lon - PILOT["lon"]) <= PILOT["screen_km"] / 109.0

def _screen_area(lat: float, lon: float, half_km: float | None):
    from ..places import PILOT
    from ..screening import service
    if half_km is None and abs(lat - PILOT["lat"]) < 0.03 and abs(lon - PILOT["lon"]) < 0.03:
        return service.snap(PILOT["lat"], PILOT["lon"], PILOT["screen_km"])
    return service.snap(lat, lon, half_km)

def DateQ(description: str = "YYYY-MM-DD"):  # noqa: N802 - a fresh Query per parameter (FastAPI can't share one)
    return Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$", description=description)

analysis_sources = {
    "MOD13Q1": {"name": "MODIS/Terra Vegetation Indices 16-Day 250 m v061", "doi": "10.5067/MODIS/MOD13Q1.061"},
    "POWER": {"name": "NASA POWER daily weather", "doi": None, "url": "https://power.larc.nasa.gov/"},
    "MCD64A1": {"name": "MODIS Burned Area Monthly 500 m v061", "doi": "10.5067/MODIS/MCD64A1.061"},
    "MCD12Q1": {"name": "MODIS Land Cover Type Yearly 500 m v061", "doi": "10.5067/MODIS/MCD12Q1.061"},
}
