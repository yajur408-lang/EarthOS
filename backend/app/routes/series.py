"""NDVI + climate series with anomaly statistics, and per-event explanations."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
from dataclasses import asdict

import httpx
from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Query

from .. import analysis
from ..cache import cached_json
from ..datasets import DATASETS
from ..sources import ornl
from ..sources import power

from .common import LatQ
from .common import LonQ
from .common import _json_default
from .common import _num
from .common import analysis_sources

router = APIRouter()


async def _analyse(lat, lon, km, start_year, end_year, ndvi, climate, **kw) -> dict:
    """analysis.analyse, memoised on disk: it is CPU-heavy (~10 s for 10 years on a small host) and its inputs
    only change when a new composite or climate day arrives, so the key includes the newest of each."""
    records = [asdict(c) for c in ndvi]
    newest = (records[-1]["calendar_date"] if records else "", len(records),
              str(climate.index.max()) if climate is not None and len(climate) else "")
    key = f"stats_{lat}_{lon}_{km}_{start_year}_{end_year}_{sorted(kw.items())}_{newest}_v{analysis.VERSION}"

    async def compute():
        out = await asyncio.to_thread(analysis.analyse, records, climate, **kw)
        return json.loads(json.dumps(out, default=_json_default))
    return await cached_json(key, compute)

@router.get("/api/series")
async def series(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    km: int = Query(1, ge=0, le=10, description="Half-width of the averaged box in km (0 = single pixel)"),
    start_year: int = Query(dt.date.today().year - 9, ge=2000),
    end_year: int = Query(dt.date.today().year),
    z: float = Query(analysis.Z_FLAG, gt=0, le=10, description="Seasonal flag threshold, |z|"),
    drop: float = Query(analysis.THRESHOLD_DROP, gt=0, le=1, description="Threshold-method NDVI drop"),
):
    if start_year > end_year:
        raise HTTPException(400, "start_year must not be after end_year.")

    ndvi, ndvi_error = [], None
    try:
        ndvi = await ornl.ndvi_series(lat, lon, km, start_year, end_year)
    except httpx.HTTPStatusError as e:
        ndvi_error = ("No MODIS land product for this location (open ocean or outside the land grid)."
                      if e.response.status_code in (400, 404) else f"MODIS service error: {e}")
    except httpx.HTTPError as e:
        ndvi_error = f"MODIS service unavailable: {e}"
    if not ndvi and not ndvi_error:
        ndvi_error = "No MODIS composites for this location and period."

    climate, climate_error = None, None
    try:
        climate = await power.daily_climate(
            lat, lon, (dt.date(start_year, 1, 1) - dt.timedelta(days=analysis.ANTECEDENT_DAYS)).isoformat(),
            f"{end_year}-12-31")
    except httpx.HTTPError as e:
        climate_error = f"NASA POWER unavailable: {e}"

    if not ndvi and climate is None:
        raise HTTPException(502, ndvi_error or climate_error or "No data found.")

    stats = await _analyse(lat, lon, km, start_year, end_year, ndvi, climate, z_flag=z, drop=drop) if ndvi else None

    return {
        "query": {"lat": lat, "lon": lon, "km": km, "start_year": start_year, "end_year": end_year,
                  "z": z, "drop": drop},
        "ndvi": {
            "dataset": "MOD13Q1",
            "pixels_per_composite": ndvi[0].n_pixels if ndvi else 0,
            "note": "Mean NDVI of pixels flagged good or marginal by the product's own pixel-reliability layer.",
            "points": [{"date": c.calendar_date, "ndvi": c.ndvi_mean, "usable_fraction": c.usable_fraction}
                       for c in ndvi],
            "error": ndvi_error,
        },
        "climate": {
            "dataset": "POWER",
            "points": [] if climate is None else _climate_points(climate, start_year),
            "error": climate_error,
        },
        "stats": stats,
        "datasets": DATASETS,
    }

def _climate_points(climate, start_year: int) -> list[dict]:
    df = climate[climate.index.year >= start_year]
    cols = {c: [_num(v) for v in df[c].tolist()] for c in df.columns}
    dates = df.index.strftime("%Y-%m-%d").tolist()
    return [{"date": d, **{c: v[i] for c, v in cols.items()}} for i, d in enumerate(dates)]

@router.get("/api/explain")
async def explain(
    lat: float = LatQ, lon: float = LonQ, km: int = Query(1, ge=0, le=10),
    start_year: int = Query(dt.date.today().year - 9, ge=2000), end_year: int = Query(dt.date.today().year),
    event_start: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"), direction: str = Query(..., pattern="^(below|above)$"),
):
    """Re-check one event with extra evidence: burned area (MCD64A1) and land-cover change (MCD12Q1)."""
    composites = await ornl.ndvi_series(lat, lon, km, start_year, end_year)
    climate = await power.daily_climate(
        lat, lon, (dt.date(start_year, 1, 1) - dt.timedelta(days=analysis.ANTECEDENT_DAYS)).isoformat(), f"{end_year}-12-31")
    stats = await _analyse(lat, lon, km, start_year, end_year, composites, climate)
    ev = next((e for e in stats["events"] if e["start"] == event_start and e["direction"] == direction), None)
    if ev is None:
        raise HTTPException(404, "Event not found for these settings.")

    start, end = dt.date.fromisoformat(ev["start"]), dt.date.fromisoformat(ev["end"]) + dt.timedelta(days=16)
    context: dict = {"burned_pct": None, "landcover_change": None}
    notes = []
    burned, lc = await asyncio.gather(
        ornl.burned_series(lat, lon, km, start.year, end.year),
        ornl.landcover_series(lat, lon, km, start.year - 1, end.year + 1),
        return_exceptions=True)
    if isinstance(burned, list):
        window = [b for b in burned if b["burned_fraction"] is not None
                  and start - dt.timedelta(days=31) <= dt.date.fromisoformat(b["date"]) <= end]
        context["burned_pct"] = round(100 * max((b["burned_fraction"] for b in window), default=0.0), 1)
    else:
        notes.append("Burned-area data unavailable right now.")
    if isinstance(lc, list) and lc:
        before = next((y for y in lc if y["year"] == start.year - 1), None)
        after = next((y for y in reversed(lc) if y["year"] >= end.year), None)
        if before and after and after["year"] != before["year"]:
            classes = set(before["classes"]) | set(after["classes"])
            shift = max(abs(after["classes"].get(c, 0) - before["classes"].get(c, 0)) for c in classes)
            top = lambda y: max(y["classes"], key=y["classes"].get)  # noqa: E731
            context["landcover_change"] = {
                "changed": shift >= 0.15,
                "detail": f"land cover shifted {shift:.0%} between {before['year']} and {after['year']} "
                          f"(main class {top(before).lower()} -> {top(after).lower()})",
            }
        else:
            notes.append("Land cover for the year after this event isn't published yet (MODIS land cover lags ~1-2 years).")
    elif isinstance(lc, list):
        notes.append("Land cover for these years isn't published yet (MODIS land cover lags ~1-2 years).")
    else:
        notes.append("Land-cover data unavailable right now.")
    ev["explanation"] = analysis.explain_event(ev, context)
    return {"event": ev, "context": context, "notes": notes,
            "sources": {k: analysis_sources[k] for k in ("MOD13Q1", "POWER", "MCD64A1", "MCD12Q1")}}
