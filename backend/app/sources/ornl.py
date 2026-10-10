"""MODIS products via the ORNL DAAC MODIS Web Service.

The service returns small pixel subsets around a point, at most 10 dates per
request, so we page through the date list and cache every response on disk.
Docs: https://modis.ornl.gov/data/modis_webservice.html
"""

from __future__ import annotations

import asyncio
import heapq
import itertools
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
import numpy as np

from ..cache import cached_json

BASE = "https://modis.ornl.gov/rst/api/v1"
CHUNK = 10


class _PriorityLimiter:
    """A semaphore that hands free slots to the most urgent waiter (lowest priority value first).

    Slots are handed out a moment after requests arrive, so a whole batch (e.g. both bands of
    a series) is queued and ranked before any slot is given away.
    """

    def __init__(self, slots: int, gather_s: float = 0.02):
        self.free = slots
        self.gather_s = gather_s
        self.waiters: list[tuple[float, int, asyncio.Future]] = []
        self.seq = itertools.count()
        self._dispatch_handle: asyncio.TimerHandle | None = None

    @asynccontextmanager
    async def slot(self, priority: float = 0):
        fut = asyncio.get_running_loop().create_future()
        heapq.heappush(self.waiters, (priority, next(self.seq), fut))
        self._schedule()
        try:
            await fut
        except asyncio.CancelledError:
            if fut.done() and not fut.cancelled():
                self._release()  # handed a slot just as we were cancelled
            raise
        try:
            yield
        finally:
            self._release()

    def _schedule(self):
        if self._dispatch_handle is None:
            self._dispatch_handle = asyncio.get_running_loop().call_later(self.gather_s, self._dispatch)

    def _dispatch(self):
        self._dispatch_handle = None
        while self.free > 0 and self.waiters:
            _, _, fut = heapq.heappop(self.waiters)
            if not fut.done():
                self.free -= 1
                fut.set_result(None)

    def _release(self):
        self.free += 1
        self._schedule()


# Shared across every request so parallel chart loads don't hammer the service. ORNL's own
# latency (20-60 s per request) dominates; more parallelism mostly earns 502s. Newer chunks
# go first (across all bands), so the quick recent-years view is never stuck behind old years.
_LIMIT = _PriorityLimiter(8)

NDVI_SCALE = 0.0001
VI_FILL = -3000
# MOD13Q1 pixel reliability: 0 = good, 1 = marginal, 2 = snow/ice, 3 = cloudy, -1 = fill
USABLE_RELIABILITY = (0, 1)

IGBP_CLASSES = {
    1: "Evergreen needleleaf forest", 2: "Evergreen broadleaf forest", 3: "Deciduous needleleaf forest",
    4: "Deciduous broadleaf forest", 5: "Mixed forest", 6: "Closed shrubland", 7: "Open shrubland",
    8: "Woody savanna", 9: "Savanna", 10: "Grassland", 11: "Permanent wetland", 12: "Cropland",
    13: "Urban and built-up", 14: "Cropland/natural mosaic", 15: "Snow and ice", 16: "Barren", 17: "Water",
}


@dataclass
class Composite:
    modis_date: str  # e.g. "A2020017"
    calendar_date: str  # "2020-01-17"
    ndvi_mean: float | None  # mean NDVI over usable pixels
    usable_fraction: float  # share of pixels that passed the QA mask
    n_pixels: int


def _key(*parts: object) -> str:
    return "_".join(str(p) for p in parts)


async def _get(client: httpx.AsyncClient, product: str, path: str, params: dict, priority: float = 0) -> dict:
    for attempt in range(4):
        try:
            async with _LIMIT.slot(priority):
                r = await client.get(f"{BASE}/{product}/{path}", params=params,
                                     headers={"Accept": "application/json"}, timeout=90)
            if r.status_code >= 500:  # ORNL sheds load with 502/503 under pressure; retry those
                raise httpx.HTTPStatusError(f"ORNL {r.status_code}", request=r.request, response=r)
            r.raise_for_status()
            return r.json()
        except (httpx.TransportError, httpx.HTTPStatusError, ValueError) as e:
            retriable = not isinstance(e, httpx.HTTPStatusError) or e.response.status_code >= 500
            if attempt == 3 or not retriable:
                raise
            await asyncio.sleep(2 ** attempt + 1)
    raise RuntimeError("unreachable")


async def available_dates(client: httpx.AsyncClient, product: str, lat: float, lon: float) -> list[dict]:
    async def fetch():
        return (await _get(client, product, "dates", {"latitude": lat, "longitude": lon}))["dates"]

    # The MODIS grid is the same everywhere, so round the key to share it.
    return await cached_json(_key("dates", product, round(lat, 1), round(lon, 1)), fetch, max_age_days=8)


async def band_series(product: str, band: str, lat: float, lon: float, km: int,
                      start_year: int, end_year: int) -> list[tuple[str, str, np.ndarray]]:
    """[(modis_date, calendar_date, pixel values)] for every date in the year range."""
    lat, lon = round(lat, 4), round(lon, 4)
    async with httpx.AsyncClient() as client:
        all_dates = await available_dates(client, product, lat, lon)
        # Chunk on fixed positions in the product's full date list, so any year range reuses the same
        # cached chunks (a quick 2-year view and the 10-year record share their overlap).
        blocks = [all_dates[i:i + CHUNK] for i in range(0, len(all_dates), CHUNK)]
        in_range = lambda d: start_year <= int(d["modis_date"][1:5]) <= end_year  # noqa: E731
        chunks = [b for b in blocks if any(in_range(d) for d in b)]
        dates = [d for d in all_dates if in_range(d)]

        async def chunk(c):
            async def fetch():
                data = await _get(client, product, "subset", {
                    "latitude": lat, "longitude": lon, "band": band,
                    "startDate": c[0]["modis_date"], "endDate": c[-1]["modis_date"],
                    "kmAboveBelow": km, "kmLeftRight": km,
                }, priority=-int(c[-1]["modis_date"][1:]))  # A2026161 -> -2026161: newest first
                return data["subset"]
            return await cached_json(_key("subset", lat, lon, km, band, c[0]["modis_date"], c[-1]["modis_date"]), fetch)

        # Newest first: the quick recent-years view shares these chunks, so it finishes as early as possible.
        results = await asyncio.gather(*(chunk(c) for c in reversed(chunks)))
    by_date = {s["modis_date"]: s for r in results for s in r}
    return [(d["modis_date"], d["calendar_date"], np.asarray(by_date[d["modis_date"]]["data"], dtype=float))
            for d in dates if d["modis_date"] in by_date]


async def _vi_series(band: str, lat, lon, km, start_year, end_year) -> list[Composite]:
    vi, rel = await asyncio.gather(
        band_series("MOD13Q1", band, lat, lon, km, start_year, end_year),
        band_series("MOD13Q1", "250m_16_days_pixel_reliability", lat, lon, km, start_year, end_year),
    )
    rel_by = {md: v for md, _, v in rel}
    out = []
    for md, cd, values in vi:
        mask = values != VI_FILL
        if md in rel_by:
            mask &= np.isin(rel_by[md], USABLE_RELIABILITY)
        good = values[mask] * NDVI_SCALE
        out.append(Composite(md, cd, float(good.mean()) if good.size else None,
                             float(mask.mean()) if values.size else 0.0, int(values.size)))
    return out


async def ndvi_series(lat: float, lon: float, km: int, start_year: int, end_year: int) -> list[Composite]:
    """Box-mean NDVI per 16-day composite, using the product pixel-reliability mask."""
    return await _vi_series("250m_16_days_NDVI", lat, lon, km, start_year, end_year)


async def evi_series(lat, lon, km, start_year, end_year) -> list[dict]:
    return [{"date": c.calendar_date, "value": c.ndvi_mean, "usable_fraction": c.usable_fraction}
            for c in await _vi_series("250m_16_days_EVI", lat, lon, km, start_year, end_year)]


async def lst_series(lat, lon, km, start_year, end_year) -> list[dict]:
    """MOD11A2 8-day land surface temperature (°C), day and night. Value 0 = no data."""
    day, night = await asyncio.gather(
        band_series("MOD11A2", "LST_Day_1km", lat, lon, km, start_year, end_year),
        band_series("MOD11A2", "LST_Night_1km", lat, lon, km, start_year, end_year),
    )
    night_by = {md: v for md, _, v in night}

    def mean_c(v):
        v = v[v > 0]
        return round(float(v.mean() * 0.02 - 273.15), 2) if v.size else None

    return [{"date": cd, "day_c": mean_c(v), "night_c": mean_c(night_by[md]) if md in night_by else None}
            for md, cd, v in day]


async def burned_series(lat, lon, km, start_year, end_year) -> list[dict]:
    """MCD64A1 monthly burned area: share of mapped land pixels with a burn date."""
    out = []
    for _, cd, v in await band_series("MCD64A1", "Burn_Date", lat, lon, km, start_year, end_year):
        mapped = v[v >= 0]  # -1 unmapped, -2 water
        out.append({"date": cd, "burned_fraction": float((mapped > 0).mean()) if mapped.size else None,
                    "pixels": int(mapped.size)})
    return out


async def landcover_series(lat, lon, km, start_year, end_year) -> list[dict]:
    """MCD12Q1 annual IGBP land-cover composition (fraction of pixels per class)."""
    out = []
    for _, cd, v in await band_series("MCD12Q1", "LC_Type1", lat, lon, km, start_year, end_year):
        v = v[(v >= 1) & (v <= 17)].astype(int)
        if not v.size:
            continue
        counts = np.bincount(v, minlength=18)
        out.append({"year": int(cd[:4]),
                    "classes": {IGBP_CLASSES[c]: round(float(counts[c] / v.size), 4) for c in range(1, 18) if counts[c]}})
    return out
