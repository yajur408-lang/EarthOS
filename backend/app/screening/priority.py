"""Where to inspect first: ranked sites that combine terrain, drainage, land cover, rainfall, recent vegetation loss,
past landslides and nearby buildings - each with the reasons it is listed and the evidence behind them.

Sites are ranked in two lists - slopes (landslide, IDs L01...) and stream corridors (flash flood, F01...) - because
their scores aren't comparable. A site is a square of block_m x block_m (default 250 m) holding at least min_site_ha of high-susceptibility ground -
small enough for a team to walk. Its score is a weighted sum of parts that each run 0-1 (weights in screening.toml):
- susceptibility: mean combined susceptibility points of its high cells / 3
- exposure: share of built-up land (WorldCover) within exposure_radius_m, doubled and capped at 1
- recent_loss: 1 if a forest-loss patch from the latest run lies within loss_radius_m
- history: 1 if a reported landslide (location accurate to 1 km or better) lies within history_radius_m
- size: high-susceptibility area in the square / its full area
Rainfall comes from ~50 km cells, so it is the same for every site and is reported for the area, not used to rank.

The susceptibility map is also tested against past landslide locations: what share of them fall in high or medium
cells, compared with the share of the area in those classes.
"""

from __future__ import annotations

import datetime as dt
import math

import numpy as np

from . import forest_loss, susceptibility, trigger
from .landcover import NAMES, SOURCE as LC_SOURCE
from .settings import CFG

P = CFG["priority"]
METHOD = (__doc__ or "").split(chr(10) * 2, 1)[-1].strip()  # the docstring after its first paragraph
ACCURATE = {"exact", "1km"}


def _cells_within(g, radius_m: float) -> int:
    return max(1, int(round(radius_m / ((g.dx_m + g.dy_m) / 2))))


def _nearest_km(lat: float, lon: float, pts: list[tuple[float, float]]) -> float | None:
    if not pts:
        return None
    k = math.cos(math.radians(lat))
    return min(math.hypot((p[0] - lat) * 110.6, (p[1] - lon) * 111.3 * k) for p in pts)


def build(a: dict, grid, loss: dict | None, events: list[dict], area_center: tuple[float, float]) -> dict:
    s = susceptibility.score(a["slope"], a["hand"], a["landcover"])
    cell_ha = grid.dx_m * grid.dy_m / 10_000
    min_cells = math.ceil(P["min_site_ha"] / cell_ha)
    high = s["class"] == 2
    rows, cols = high.shape
    step = max(2, int(round(P["block_m"] / ((grid.dx_m + grid.dy_m) / 2))))
    blocks = []
    for br in range(0, rows, step):
        for bc in range(0, cols, step):
            rr, cc = np.nonzero(high[br:br + step, bc:bc + step])
            if len(rr) >= min_cells:
                blocks.append((br, bc, [(br + r, bc + c) for r, c in zip(rr, cc)]))
    built = a["landcover"] == 50
    r_exp = _cells_within(grid, P["exposure_radius_m"])
    loss_pts = [(p["lat"], p["lon"]) for p in (loss or {}).get("patches", [])]
    slides = [e for e in events if e.get("accuracy") in ACCURATE]
    w = P["weights"]
    sites = []
    for br, bc, cells in blocks:
        rr = np.array([c[0] for c in cells])
        cc = np.array([c[1] for c in cells])
        lat, lon = float(a["lat"][rr].mean()), float(a["lon"][cc].mean())
        r0, r1 = max(rr.min() - r_exp, 0), min(rr.max() + r_exp + 1, rows)
        c0, c1 = max(cc.min() - r_exp, 0), min(cc.max() + r_exp + 1, cols)
        exposure = float(built[r0:r1, c0:c1].mean())
        slope = float(a["slope"][rr, cc].mean())
        hand = a["hand"][rr, cc]
        hand_med = float(np.nanmedian(hand)) if np.isfinite(hand).any() else None
        flood_driven = float((s["driver"][rr, cc] == 1).mean()) > 0.5
        codes, counts = np.unique(a["landcover"][rr, cc], return_counts=True)
        main_lc = NAMES.get(int(codes[np.argmax(counts)]), "unknown")
        d_loss = _nearest_km(lat, lon, loss_pts)
        near_loss = d_loss is not None and d_loss * 1000 <= P["loss_radius_m"]
        d_slide = _nearest_km(lat, lon, [(e["lat"], e["lon"]) for e in slides])
        near_slide = d_slide is not None and d_slide * 1000 <= P["history_radius_m"]
        area_ha = len(cells) * cell_ha
        parts = {
            "susceptibility": float(s["combined"][rr, cc].mean()) / 3,
            "exposure": min(exposure * 2, 1.0),
            "recent_loss": 1.0 if near_loss else 0.0,
            "history": 1.0 if near_slide else 0.0,
            "size": min(len(cells) / (step * step), 1.0),
        }
        score = sum(w[k] * v for k, v in parts.items())
        reasons = []
        if flood_driven:
            reasons.append(f"stream corridor: median {hand_med:.1f} m above the nearest drainage line" if hand_med is not None
                           else "stream corridor (low height above drainage)")
        else:
            reasons.append(f"steep ground: mean slope {slope:.0f}°")
        reasons.append(f"land cover mostly {main_lc.lower()}")
        if exposure >= 0.05:
            reasons.append(f"built-up land covers {exposure:.0%} of the ground within {P['exposure_radius_m']} m")
        if near_loss:
            win = (loss or {}).get("recent_window") or ["?", "?"]
            reasons.append(f"possible vegetation loss ({win[0]} to {win[1]}) within {round(d_loss * 1000)} m, cause unconfirmed")
        if near_slide:
            ev = min(slides, key=lambda e: _nearest_km(lat, lon, [(e["lat"], e["lon"])]))
            reasons.append(f"landslide reported {ev['date']} about {d_slide:.1f} km away ({ev['origin']})")
        uncertain = float(s["uncertain"][rr, cc].mean())
        sites.append({
            "lat": round(lat, 5), "lon": round(lon, 5), "area_ha": round(area_ha, 2),
            "high_share": round(len(cells) / (step * step), 2),
            "kind": "stream corridor" if flood_driven else "slope",
            "score": round(score, 3), "parts": {k: round(v, 2) for k, v in parts.items()},
            "reasons": reasons, "uncertain_share": round(uncertain, 2),
            # The square itself (south, north, west, east), for maps and field sheets.
            "bbox": [float(a["lat"][min(br + step, rows) - 1]), float(a["lat"][br]),
                     float(a["lon"][bc]), float(a["lon"][min(bc + step, cols) - 1])],
            "square_m": P["block_m"],
        })
    # Slopes (landslides) and stream corridors (flash floods) score on different scales, so each gets its own ranking.
    out, totals = [], {}
    for kind, prefix in (("slope", "L"), ("stream corridor", "F")):
        group = sorted((x for x in sites if x["kind"] == kind), key=lambda x: -x["score"])
        totals[kind] = len(group)
        for i, site in enumerate(group[:P["max_sites"]]):
            site["rank"] = i + 1
            site["id"] = f"{prefix}{i + 1:02d}"
            out.append(site)
    return {"sites": out, "total_sites": totals, "validation": validate(a, s, events, grid)}


def validate(a: dict, s: dict, events: list[dict], grid) -> dict:
    """Do past landslides fall in the higher classes more often than the area as a whole?"""
    b = grid.bounds()
    inside = [e for e in events if b["south"] <= e["lat"] <= b["north"] and b["west"] <= e["lon"] <= b["east"]]
    usable = [e for e in inside if e.get("accuracy") in ACCURATE]
    land = a["landcover"] != 80
    assessed = land & ~s["unassessed"]
    area_share = {c: float(((s["class"] == k) & assessed).sum()) / max(int(land.sum()), 1)
                  for k, c in enumerate(susceptibility.CLASSES)}
    area_share["unassessed"] = float((land & s["unassessed"]).sum()) / max(int(land.sum()), 1)
    r_win = _cells_within(grid, 100)  # 100 m: a reported point is rarely exactly on the scar
    rows, cols = s["class"].shape
    checked = []
    for e in usable:
        r = int(np.clip(np.searchsorted(-a["lat"], -e["lat"]), 0, rows - 1))
        c = int(np.clip(np.searchsorted(a["lon"], e["lon"]), 0, cols - 1))
        k_point = int(s["class"][r, c])
        k_near = int(s["class"][max(r - r_win, 0):r + r_win + 1, max(c - r_win, 0):c + r_win + 1].max())
        checked.append({"date": e["date"], "title": e["title"], "lat": e["lat"], "lon": e["lon"], "accuracy": e["accuracy"],
                        "origin": e["origin"],
                        "class_at_point": "unassessed" if s["unassessed"][r, c] else susceptibility.CLASSES[k_point],
                        "highest_within_100m": susceptibility.CLASSES[k_near]})
    n = len(checked)
    in_high = sum(1 for c in checked if c["highest_within_100m"] == "high")
    in_med_or_high = sum(1 for c in checked if c["highest_within_100m"] in ("medium", "high"))
    return {
        "events_in_area": len(inside), "events_usable": n,
        "excluded_vague_location": len(inside) - n,
        "share_in_high": round(in_high / n, 2) if n else None,
        "share_in_medium_or_high": round(in_med_or_high / n, 2) if n else None,
        "area_share": {k: round(v, 3) for k, v in area_share.items()},
        "missed": [c for c in checked if c["highest_within_100m"] == "lower"],
        "events": checked,
        "method": ("Each reported landslide with a location accurate to 1 km or better is given the highest class within "
                   "100 m of its point. If the map is informative, a larger share of past landslides should fall in high "
                   "or medium cells than the share of the area in those classes. Landslides that fall only in 'lower' "
                   "cells are listed as missed."),
        "caveat": ("Very few located landslides: this is a sanity check, not a validated accuracy. Reported points can be "
                   "hundreds of metres from the actual scar; field checks by local experts are the real test."),
    }


async def rainfall_context(lat: float, lon: float) -> dict:
    """Rain over the last 30 available days vs the same 30 days in other years (NASA POWER, ~50 km)."""
    today = dt.date.today()
    rec_start = dt.date(CFG["backtest"]["start_year"], 1, 1)
    clim = await trigger.power.daily_climate(round(lat, 3), round(lon, 3), (rec_start - dt.timedelta(days=10)).isoformat(), today.isoformat())
    rain = clim["precip_mm"].dropna()
    if len(rain) < 400:
        return {"available": False}
    end = rain.index.max()
    start = end - dt.timedelta(days=29)
    recent = float(rain.loc[start:end].sum())
    totals = []
    for y in range(rain.index.min().year + 1, end.year):
        try:
            a, b = start.replace(year=y), end.replace(year=y)
        except ValueError:
            continue
        seg = rain.loc[a:b]
        if len(seg) >= 28:
            totals.append(float(seg.sum()))
    normal = float(np.median(totals)) if totals else None
    return {
        "available": True, "window": [start.date().isoformat(), end.date().isoformat()],
        "rain_mm": round(recent, 1), "normal_mm": None if normal is None else round(normal, 1),
        "percent_of_normal": None if not normal else round(100 * recent / normal),
        "years_compared": len(totals),
        "note": "NASA POWER rain is a ~50 km average, so it is the same for every site in the area and isn't used to rank them.",
    }


def evidence(loss: dict | None) -> list[dict]:
    out = [
        {"layer": "Slope, drainage lines, height above drainage", "source": "Terrain Tiles (mostly SRTM 1 arc-second)",
         "date": "elevation surveyed Feb 2000 (SRTM)", "resolution": "~30 m (analysed on a 31 m grid)"},
        {"layer": "Land cover and built-up exposure", "source": LC_SOURCE["name"], "date": "2021", "resolution": "10 m (sampled at 31 m)"},
        {"layer": "Rainfall and soil wetness", "source": "NASA POWER daily", "date": "daily, a few days behind", "resolution": "~50 km"},
        {"layer": "Past landslides", "source": "NASA Global Landslide Catalog; CNE reports", "date": "2007-2018 (per event)",
         "resolution": "points; only locations accurate to 1 km or better are used"},
    ]
    if loss and loss.get("recent_window"):
        out.insert(2, {"layer": "Recent vegetation loss", "source": "NASA HLS VI v2.0 (Landsat 8/9, Sentinel-2)",
                       "date": f"{loss['recent_window'][0]} to {loss['recent_window'][1]} vs the same weeks in "
                               f"{', '.join(str(y) for y in loss.get('baseline_years_used', []))}",
                       "resolution": "30 m"})
    return out
