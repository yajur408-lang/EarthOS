"""Before/after satellite change around an event date, from 30 m HLS vegetation and water indices.

For each grid cell: the median of clear observations in the weeks before the event vs the median of clear
observations in the weeks after it. Cells flagged where the index moved past a threshold AND by at least
|robust_z| robust sigmas of the pre-event variability; flagged cells are grouped into patches of at least
`min_patch_ha`. Which index and direction depend on the hazard:

- NDVI drop: wind damage (cyclones, tornadoes, storms), landslides, ash/lava.
- NBR drop: burn scars (dNBR >= 0.27 is "moderate" severity in USGS/MTBS practice).
- NDWI rise: newly wet ground / standing water after floods (clouds often hide the flood peak).

Every result is labelled "Change after <date>, cause unconfirmed".
"""

from __future__ import annotations

import asyncio
import datetime as dt
import math

import numpy as np

from .. import config, http
from . import forest_loss
from .disasters import CHECKS
from .settings import LOSS

PARAMS = {
    "NDVI": {"sign": -1, "threshold": 0.15, "name": "NDVI", "meaning": "vegetation greenness"},
    "NBR": {"sign": -1, "threshold": 0.27, "name": "NBR (normalized burn ratio)", "meaning": "burn signal"},
    "NDWI": {"sign": 1, "threshold": 0.20, "name": "NDWI (McFeeters water index)", "meaning": "surface wetness"},
}
ROBUST_Z = 2.0
MIN_BEFORE_OBS = 2
MIN_AFTER_OBS = 1


async def run(grid_lat, grid_lon, slope, cell_m2: float, hazard: str, event: dt.date, progress=None) -> dict:
    if not config.EARTHDATA_TOKEN:
        raise forest_loss.NeedsToken("Set EARTHDATA_TOKEN on the server to enable 30 m change checks.")
    chk = CHECKS[hazard]
    index = chk["index"]
    p = PARAMS[index]
    before = (event - dt.timedelta(days=chk["before"]), event - dt.timedelta(days=1))
    after = (event + dt.timedelta(days=1), min(event + dt.timedelta(days=chk["after"]), dt.date.today()))
    if after[0] > after[1]:
        return _empty(hazard, index, before, after, "No imagery after the event yet.")
    lon2, lat2 = np.meshgrid(grid_lon, grid_lat)
    bbox = (float(grid_lon.min()), float(grid_lat.min()), float(grid_lon.max()), float(grid_lat.max()))
    bits = [b for b in LOSS["fmask_reject_bits"] if not (index == "NDWI" and b == 5)]  # keep water when looking for it
    reject = sum(1 << b for b in bits)
    headers = {"Authorization": f"Bearer {config.EARTHDATA_TOKEN}"}
    async with http.client() as client:
        jobs = [("before", g) for g in await forest_loss._granules(client, bbox, *before)]
        jobs += [("after", g) for g in await forest_loss._granules(client, bbox, *after)]
        sem = asyncio.Semaphore(4)
        done = 0

        async def one(kind, g):
            nonlocal done
            async with sem:
                try:
                    arr = await forest_loss._read_granule(client, g, lat2, lon2, headers, reject, index)
                    arr = None if arr is None else forest_loss.pack(arr)
                except Exception as e:  # noqa: BLE001
                    arr, g["error"] = None, str(e)[:200]
            done += 1
            if progress:
                progress(done / max(len(jobs), 1))
            return kind, g, arr

        results = await asyncio.gather(*(one(k, g) for k, g in jobs))
    stacks = {"before": [], "after": []}
    dates = {"before": [], "after": []}
    for kind, g, arr in results:
        if arr is not None and (arr != forest_loss.NODATA16).any():
            stacks[kind].append(arr)
            dates[kind].append(g["date"])
    diag = forest_loss._diagnostics(results, sum(1 for k, _ in jobs if k == "before"), sum(1 for k, _ in jobs if k == "after"))
    if not stacks["before"] or not stacks["after"]:
        side = "before" if not stacks["before"] else "after"
        return {**_empty(hazard, index, before, after, f"No clear 30 m views {side} the event (cloud or no passes)."),
                "diagnostics": diag}
    b_med, mad, n_b = forest_loss.stack_stats(stacks["before"], mad=True)
    a_med, _, n_a = forest_loss.stack_stats(stacks["after"])
    stacks.clear()
    diff = (a_med - b_med) * p["sign"]  # positive = change in the hazard direction
    z = diff / np.maximum(1.4826 * np.nan_to_num(mad), 0.03)
    judged = (n_b >= MIN_BEFORE_OBS) & (n_a >= MIN_AFTER_OBS)
    flag = judged & (diff >= p["threshold"]) & (z >= ROBUST_Z)
    if hazard == "landslide":
        flag &= slope >= LOSS["min_slope_deg"]
    min_cells = math.ceil(LOSS["min_patch_ha"] * 10_000 / cell_m2)
    keep = np.zeros(flag.shape, dtype=bool)
    patches = []
    label = f"Change after {event.isoformat()}, cause unconfirmed"
    for k, cells in enumerate(sorted(forest_loss._patches(flag, min_cells), key=len, reverse=True)):
        rr = np.array([c[0] for c in cells])
        cc = np.array([c[1] for c in cells])
        keep[rr, cc] = True
        patches.append({
            "id": k + 1, "label": label,
            "lat": round(float(grid_lat[rr].mean()), 5), "lon": round(float(grid_lon[cc].mean()), 5),
            "area_ha": round(len(cells) * cell_m2 / 10_000, 2), "pixels": len(cells),
            "mean_slope_deg": round(float(slope[rr, cc].mean()), 1),
            "before": round(float(np.nanmean(b_med[rr, cc])), 3), "after": round(float(np.nanmean(a_med[rr, cc])), 3),
            "change": round(float(np.nanmean(a_med[rr, cc] - b_med[rr, cc])), 3),
            "robust_z": round(float(np.nanmedian(z[rr, cc])), 1),
        })
    return {
        "hazard": hazard, "event_date": event.isoformat(), "index": index, "index_name": p["name"],
        "looks_for": chk["label"], "label": label, "patches": patches, "mask": keep,
        "flagged_ha": round(float(keep.sum()) * cell_m2 / 10_000, 1),
        "judged_share": round(float(judged.mean()), 3),
        "before_window": [before[0].isoformat(), before[1].isoformat()],
        "after_window": [after[0].isoformat(), after[1].isoformat()],
        "scenes": {"before": len(stacks["before"]), "after": len(stacks["after"])},
        "scene_dates": {k: sorted(v) for k, v in dates.items()},
        "qa": forest_loss._qa_text() + (" Water pixels are kept for the flood check." if index == "NDWI" else ""),
        "thresholds": {"change": p["threshold"], "robust_z": ROBUST_Z, "min_patch_ha": LOSS["min_patch_ha"],
                       "min_before_obs": MIN_BEFORE_OBS, "min_after_obs": MIN_AFTER_OBS},
        "diagnostics": diag,
        "source": forest_loss.SOURCE,
        "method": (f"Median clear {p['name']} in {chk['before']} days before vs up to {chk['after']} days after the event; "
                   f"flagged where it moved by at least {p['threshold']} in the {('drop' if p['sign'] < 0 else 'rise')} direction and "
                   f"{ROBUST_Z} robust sigmas of the pre-event variability, in patches of at least {LOSS['min_patch_ha']} ha. "
                   "Harvests, construction, seasonal change, irrigation and missed cloud can produce the same signal."),
    }


def _empty(hazard, index, before, after, note):
    return {"hazard": hazard, "index": index, "patches": [], "mask": None, "note": note,
            "label": "Change after the event, cause unconfirmed", "looks_for": CHECKS[hazard]["label"],
            "before_window": [before[0].isoformat(), before[1].isoformat()],
            "after_window": [after[0].isoformat(), after[1].isoformat()],
            "scenes": {"before": 0, "after": 0}, "qa": forest_loss._qa_text(), "source": forest_loss.SOURCE}
