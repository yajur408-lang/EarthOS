"""Screening areas: compute once, cache on disk (arrays + overlay PNGs), serve many times.

An area is a square box (half-width `half_km`) around a centre rounded to 0.005 deg, so nearby clicks share it.
Terrain is computed on a slightly larger box so drainage routing doesn't stop at the edge.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import io
import json
import time

import numpy as np
from PIL import Image

from ..cache import CACHE_DIR
from . import forest_loss, susceptibility, terrain_grid
from .landcover import GROUPS, NAMES, SOURCE as LC_SOURCE, landcover
from .settings import AREA, LOSS, SUSC

DIR = CACHE_DIR / "screening"
VERSION = 2  # bump when the layer maths change (cached arrays)
PNG_VERSION = 4  # bump when overlay colours or the uncertainty shading change

_inflight: dict[str, asyncio.Task] = {}
_jobs: dict[str, dict] = {}  # forest-loss jobs: key -> {"status", "progress", "started", "error"}
MAX_PENDING_JOBS = 3  # running + queued satellite jobs; each reads hundreds of NASA files, so the queue is capped


def _queue_full() -> dict | None:
    pending = sum(1 for j in _jobs.values() if j.get("status") in ("running", "queued"))
    if pending >= MAX_PENDING_JOBS:
        return {"status": "busy", "error": f"The server is already running {pending} satellite checks; try again in a few "
                                           "minutes. (The queue is capped so one visitor can't tie it up for everyone.)"}
    return None
_sem: asyncio.Semaphore | None = None
HLS_START = dt.date(2014, 1, 1)  # HLS Landsat 8 VI from Apr 2013; a baseline needs at least one earlier year


def snap(lat: float, lon: float, half_km: float | None) -> tuple[float, float, float]:
    h = AREA["default_half_km"] if half_km is None else min(max(half_km, 1.0), AREA["max_half_km"])
    return round(round(lat / 0.005) * 0.005, 3), round(round(lon / 0.005) * 0.005, 3), round(h, 1)


def area_key(lat: float, lon: float, half_km: float) -> str:
    return f"v{VERSION}_{lat:.3f}_{lon:.3f}_{half_km:.1f}"


# ------------------------------------------------------------------ susceptibility

async def area(lat: float, lon: float, half_km: float) -> dict:
    """Arrays for the area (cached). Inner box only, plus its grid."""
    key = area_key(lat, lon, half_km)
    path = DIR / f"area_{key}.npz"
    if path.exists():
        return _load(path)
    task = _inflight.get(key)
    if task is None:
        task = _inflight[key] = asyncio.ensure_future(_build_area(lat, lon, half_km, path))
        task.add_done_callback(lambda _t: _inflight.pop(key, None))
    return await asyncio.shield(task)


async def _build_area(lat: float, lon: float, half_km: float, path) -> dict:
    t0 = time.time()
    outer = terrain_grid.make_grid(lat, lon, half_km + AREA["buffer_km"], AREA["grid_arcsec"])
    terr = await terrain_grid.terrain_layers(outer, SUSC["stream_area_km2"])
    inner = terrain_grid.make_grid(lat, lon, half_km, AREA["grid_arcsec"])
    # Locate the inner grid inside the outer one (same spacing and centre).
    r0 = int(np.argmin(np.abs(outer.lat - inner.lat[0])))
    c0 = int(np.argmin(np.abs(outer.lon - inner.lon[0])))
    sl = (slice(r0, r0 + len(inner.lat)), slice(c0, c0 + len(inner.lon)))
    lon2, lat2 = inner.mesh()
    lc = await landcover(lat2, lon2)
    a = {
        "lat": inner.lat, "lon": inner.lon, "step": np.array(inner.step_deg),
        "dem": terr["dem"][sl].astype(np.float32), "slope": terr["slope"][sl].astype(np.float32),
        "hand": terr["hand"][sl].astype(np.float32), "stream": terr["stream"][sl],
        "landcover": lc, "built_s": np.array(time.time() - t0),
    }
    DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **a)
    return a


def _load(path) -> dict:
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


def _grid(a: dict) -> terrain_grid.Grid:
    return terrain_grid.Grid(a["lat"], a["lon"], float(a["step"]))


async def susceptibility_result(lat: float, lon: float, half_km: float, at: tuple[float, float] | None) -> dict:
    a = await area(lat, lon, half_km)
    s = susceptibility.score(a["slope"], a["hand"], a["landcover"])
    g = _grid(a)
    inside = a["landcover"] != 80  # skip open water
    point = None
    if at:
        r = int(np.clip(np.searchsorted(-g.lat, -at[0]), 0, len(g.lat) - 1))
        c = int(np.clip(np.searchsorted(g.lon, at[1]), 0, len(g.lon) - 1))
        code = int(a["landcover"][r, c])
        point = susceptibility.at(s, r, c, float(a["slope"][r, c]), float(a["hand"][r, c]), NAMES.get(code, "unknown"))
    lc_codes, lc_counts = np.unique(a["landcover"], return_counts=True)
    return {
        "bounds": g.bounds(),
        "cell_m": round((g.dx_m + g.dy_m) / 2, 1),
        "summary": susceptibility.summary(s, inside),
        "at_point": point,
        "terrain": {
            "elevation_m": [round(float(a["dem"].min())), round(float(a["dem"].max()))],
            "steep_share": round(float((a["slope"] >= 15).mean()), 3),
            "drainage_share": round(float(a["stream"].mean()), 3),
        },
        "land_cover": {NAMES.get(int(k), str(k)): round(float(n) / a["landcover"].size, 3)
                       for k, n in sorted(zip(lc_codes, lc_counts), key=lambda x: -x[1]) if k},
        "method": susceptibility.METHOD,
        "wording": "Lower susceptibility, not safe.",
        "sources": [
            {"name": "Terrain Tiles (Terrarium), mostly SRTM 1 arc-second here", "use": "elevation, slope, drainage, HAND",
             "url": "https://registry.opendata.aws/terrain-tiles/"},
            {**LC_SOURCE, "use": "land cover"},
        ],
        "limits": [
            "A 30 m elevation model misses small cuts, retaining walls, drains and fills that often decide where slopes fail.",
            "Soil type, geology, faults and land-use history are not included.",
            "WorldCover land cover is from 2021 and about 75-80% accurate per pixel.",
            "Relative ranking within this area only; it is not a probability and not an official hazard map.",
        ],
    }


def susceptibility_png(a: dict, mode: str = "combined") -> bytes:
    """Overlay image. mode: combined (larger of the two), landslide (slope + land cover) or flood (HAND)."""
    s = susceptibility.score(a["slope"], a["hand"], a["landcover"])
    colors = np.array([[250, 204, 21, 45], [245, 124, 0, 165], [211, 47, 47, 200]], dtype=np.uint8)
    if mode == "landslide":
        cls, unassessed = s["slide_class"], np.zeros(s["class"].shape, dtype=bool)
    elif mode == "flood":
        cls, unassessed = np.maximum(s["flood_class"], 0), s["flood_class"] < 0
        colors = np.array([[147, 197, 253, 45], [59, 130, 246, 150], [30, 64, 175, 200]], dtype=np.uint8)
    else:
        cls, unassessed = s["class"], s["unassessed"]
    rgba = colors[cls].copy()
    # Uncertain cells (class could change within typical input error) are drawn paler.
    unc = s["uncertain"]
    rgba[unc, 3] = (rgba[unc, 3] * 0.5).astype(np.uint8)
    rgba[unassessed] = [128, 128, 128, 110]  # drainage unknown: grey, never the "lower" colour
    if mode != "landslide":
        rgba[a["stream"]] = [30, 136, 229, 200]
    rgba[a["landcover"] == 80] = [0, 0, 0, 0]
    return _png(rgba)


def preview_png(a: dict) -> bytes:
    """Shaded relief with the susceptibility layer on top (for pages and reports)."""
    g = _grid(a)
    dem = a["dem"].astype(float)
    dzdy, dzdx = np.gradient(dem, g.dy_m, g.dx_m)
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, dzdy)
    az, alt = np.radians(315), np.radians(45)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    grey = (np.clip(shade, 0, 1) * 200 + 40).astype(np.uint8)
    base = Image.fromarray(np.dstack([grey, grey, grey, np.full_like(grey, 255)]), "RGBA")
    over = Image.open(io.BytesIO(susceptibility_png(a)))
    base.alpha_composite(over)
    big = base.resize((base.width * 2, base.height * 2), Image.NEAREST)
    buf = io.BytesIO()
    big.convert("RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ------------------------------------------------------------------ forest loss (background job)

LOSS_VERSION = 5  # bump to recompute stored forest-loss results


def loss_key(lat: float, lon: float, half_km: float, end: dt.date) -> str:
    return f"{area_key(lat, lon, half_km)}_L{LOSS_VERSION}_{end.isoformat()}"


def loss_status(lat: float, lon: float, half_km: float, end: dt.date) -> dict:
    key = loss_key(lat, lon, half_km, end)
    path = DIR / f"loss_{key}.json"
    if path.exists():
        return {"status": "done", **json.loads(path.read_text())}
    job = _jobs.get(key)
    st = {k: v for k, v in job.items() if k != "task"} if job else {"status": "not_started"}
    # While a newer run is pending, offer the latest finished one for this area.
    older = sorted(DIR.glob(f"loss_{area_key(lat, lon, half_km)}_L{LOSS_VERSION}_*.json")) if end >= default_loss_end() else []
    if older:
        prev = json.loads(older[-1].read_text())
        st["previous"] = {"end": older[-1].stem.rsplit("_", 1)[-1], **prev}
    return st


def start_loss(lat: float, lon: float, half_km: float, end: dt.date) -> dict:
    st = loss_status(lat, lon, half_km, end)
    if st["status"] in ("done", "running", "queued", "unavailable"):
        return st
    key = loss_key(lat, lon, half_km, end)
    if (full := _queue_full()) is not None:
        return full
    job = _jobs[key] = {"status": "queued" if _sem and _sem.locked() else "running", "progress": 0.0, "started": time.time()}

    def progress(p: float):
        job["progress"] = round(p, 3)

    async def go():
        global _sem
        _sem = _sem or asyncio.Semaphore(1)  # one job at a time: each holds a few hundred scenes in memory
        async with _sem:
            job["status"] = "running"
            await _run(job, progress)

    async def _run(job, progress):
        try:
            a = await area(lat, lon, half_km)
            g = _grid(a)
            res = await forest_loss.run(a["lat"], a["lon"], a["slope"], g.dx_m * g.dy_m, end, progress)
            mask = res.pop("mask", None)
            if mask is not None:
                rgba = np.zeros(mask.shape + (4,), dtype=np.uint8)
                rgba[mask] = [217, 70, 239, 230]
                (DIR / f"loss_{key}.png").write_bytes(_png(rgba))
            res["bounds"] = g.bounds()
            res["has_overlay"] = mask is not None
            res["computed"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
            DIR.mkdir(parents=True, exist_ok=True)
            (DIR / f"loss_{key}.json").write_text(json.dumps(res))
            _jobs.pop(key, None)
        except forest_loss.NeedsToken as e:
            job.update(status="unavailable", error=str(e))
        except Exception as e:  # noqa: BLE001
            job.update(status="error", error=_safe_error(e))

    job["task"] = asyncio.ensure_future(go())
    return {k: v for k, v in job.items() if k != "task"}


def restart_loss(lat: float, lon: float, half_km: float, end: dt.date) -> dict:
    _jobs.pop(loss_key(lat, lon, half_km, end), None)
    return start_loss(lat, lon, half_km, end)


def loss_png_path(lat: float, lon: float, half_km: float, end: dt.date):
    return DIR / f"loss_{loss_key(lat, lon, half_km, end)}.png"


def default_loss_end() -> dt.date:
    """Most recent Monday at least 5 days ago (HLS takes a few days to process), so results refresh weekly."""
    d = dt.date.today() - dt.timedelta(days=5)
    return d - dt.timedelta(days=d.weekday())


def _safe_error(e: Exception) -> str:
    """Error text for API responses, with URL query strings removed (NASA's signed download links carry temporary
    credentials in them) and any bearer token masked."""
    import re
    text = re.sub(r"\?[^\s'\"]*", "?…", f"{type(e).__name__}: {e}")
    text = re.sub(r"(?i)bearer\s+[a-z0-9._-]+", "Bearer …", text)
    return text[:300]


def loss_end_for(date: dt.date | None) -> tuple[dt.date | None, str | None]:
    """End date of the forest-loss window for a chosen day: recent days use the latest weekly run."""
    latest = default_loss_end()
    if date is None or date >= latest:
        return latest, None
    if date < HLS_START:
        return None, f"The 30 m HLS record starts in 2013, so the forest-loss watch is available from {HLS_START.isoformat()}."
    return date, None


def loss_ready() -> bool:
    from .. import config
    return bool(config.EARTHDATA_TOKEN)


__all__ = ["snap", "area", "susceptibility_result", "susceptibility_png", "start_loss", "loss_status",
           "loss_png_path", "default_loss_end", "LOSS", "GROUPS"]


# ------------------------------------------------------------------ before/after change around an event (background job)

CHANGE_COLORS = {"NDVI": [217, 70, 239, 230], "NBR": [255, 87, 34, 235], "NDWI": [0, 188, 212, 235]}


def change_key(lat: float, lon: float, half_km: float, hazard: str, event: dt.date) -> str:
    return f"{area_key(lat, lon, half_km)}_C{LOSS_VERSION}_{hazard}_{event.isoformat()}"


def change_status(lat: float, lon: float, half_km: float, hazard: str, event: dt.date) -> dict:
    key = change_key(lat, lon, half_km, hazard, event)
    path = DIR / f"change_{key}.json"
    if path.exists():
        return {"status": "done", **json.loads(path.read_text())}
    job = _jobs.get(key)
    return {k: v for k, v in job.items() if k != "task"} if job else {"status": "not_started"}


def change_png_path(lat: float, lon: float, half_km: float, hazard: str, event: dt.date):
    return DIR / f"change_{change_key(lat, lon, half_km, hazard, event)}.png"


def start_change(lat: float, lon: float, half_km: float, hazard: str, event: dt.date) -> dict:
    from . import change
    st = change_status(lat, lon, half_km, hazard, event)
    if st["status"] in ("done", "running", "queued", "unavailable"):
        return st
    key = change_key(lat, lon, half_km, hazard, event)
    if (full := _queue_full()) is not None:
        return full
    job = _jobs[key] = {"status": "queued" if _sem and _sem.locked() else "running", "progress": 0.0, "started": time.time()}

    def progress(p: float):
        job["progress"] = round(p, 3)

    async def go():
        global _sem
        _sem = _sem or asyncio.Semaphore(1)
        async with _sem:
            job["status"] = "running"
            try:
                a = await area(lat, lon, half_km)
                g = _grid(a)
                res = await change.run(a["lat"], a["lon"], a["slope"], g.dx_m * g.dy_m, hazard, event, progress)
                mask = res.pop("mask", None)
                if mask is not None:
                    rgba = np.zeros(mask.shape + (4,), dtype=np.uint8)
                    rgba[mask] = CHANGE_COLORS.get(res["index"], [217, 70, 239, 230])
                    (DIR / f"change_{key}.png").write_bytes(_png(rgba))
                res.update(bounds=g.bounds(), has_overlay=mask is not None,
                           computed=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"))
                DIR.mkdir(parents=True, exist_ok=True)
                (DIR / f"change_{key}.json").write_text(json.dumps(res))
                _jobs.pop(key, None)
            except forest_loss.NeedsToken as e:
                job.update(status="unavailable", error=str(e))
            except Exception as e:  # noqa: BLE001
                job.update(status="error", error=_safe_error(e))

    job["task"] = asyncio.ensure_future(go())
    return {k: v for k, v in job.items() if k != "task"}
