"""Relative landslide / flood susceptibility from slope, height above nearest drainage and land cover.

A transparent points scheme, not a calibrated model: every weight is in screening.toml.
Landslide points come from slope (plus a land-cover adjustment on steep ground); flood points come from
height above nearest drainage. The class uses the larger of the two. Input errors are simulated (seeded Monte
Carlo, typical error sizes from screening.toml); cells that change class in too many draws are reported as uncertain.
"""

from __future__ import annotations

import numpy as np

from .landcover import GROUPS
from .settings import SUSC

CLASSES = ["lower", "medium", "high"]


def _points(values: np.ndarray, breaks: list[float], rising: bool) -> np.ndarray:
    idx = np.digitize(values, breaks)  # 0..len(breaks); NaN -> len(breaks), i.e. 0 points when falling
    return idx.astype(float) if rising else (len(breaks) - idx).astype(float)


def _combined(slope: np.ndarray, hand: np.ndarray, adj: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    slide = _points(slope, SUSC["slope_breaks_deg"], rising=True)
    steep = slope >= SUSC["slope_breaks_deg"][0]
    slide = np.where(steep, np.clip(slide + adj, 0, 3), slide)
    flood = _points(hand, SUSC["hand_breaks_m"], rising=False)
    return slide, flood, np.maximum(slide, flood)


def _classify(combined: np.ndarray) -> np.ndarray:
    return np.where(combined >= SUSC["high_from"], 2, np.where(combined >= SUSC["medium_from"], 1, 0))


def _stability(slope: np.ndarray, hand: np.ndarray, adj: np.ndarray, cls: np.ndarray):
    """Share of simulated input errors under which each cell keeps its class, plus the lowest and highest class seen.

    Slope and HAND get independent normal errors with the configured standard deviations; the land-cover label is
    wrong with probability 1 - accuracy, which moves the adjustment one step up or down. Seeded, so the map is the
    same on every run. Errors are drawn per cell (DEM errors are spatially correlated in reality, which this ignores).
    """
    rng = np.random.default_rng(SUSC["uncertainty_seed"])
    draws = SUSC["uncertainty_draws"]
    wrong = 1.0 - SUSC["landcover_accuracy"]
    kept = np.zeros(cls.shape, dtype=np.int16)
    lo = cls.copy()
    hi = cls.copy()
    for _ in range(draws):
        s = np.maximum(slope + rng.normal(0.0, SUSC["slope_error_deg"], slope.shape), 0.0)
        h = np.maximum(hand + rng.normal(0.0, SUSC["hand_error_m"], hand.shape), 0.0)
        flip = rng.random(adj.shape) < wrong
        step = np.where(rng.random(adj.shape) < 0.5, -1.0, 1.0) * SUSC["landcover_error_points"]
        k = _classify(_combined(s, h, np.where(flip, adj + step, adj))[2])
        kept += k == cls
        np.minimum(lo, k, out=lo)
        np.maximum(hi, k, out=hi)
    return kept / draws, lo, hi


def score(slope: np.ndarray, hand: np.ndarray, lc: np.ndarray) -> dict:
    lookup = np.zeros(256)
    for code, group in GROUPS.items():
        lookup[code] = SUSC["landcover_points"].get(group, 0.0)
    adj = lookup[lc.astype(np.uint8)]
    slide, flood, combined = _combined(slope, hand, adj)
    cls = _classify(combined)
    stability, lo, hi = _stability(slope, hand, adj, cls)
    # Unknown drainage (HAND NaN: flow leaves the grid before meeting a drainage line) is not "no flood hazard".
    # Where the landslide part alone would say "lower", the cell is unassessed rather than lower.
    hand_unknown = ~np.isfinite(hand)
    unassessed = hand_unknown & (cls == 0)
    near = (stability < SUSC["stable_share"]) | hand_unknown
    driver = np.where(slide >= flood, 0, 1)  # 0 = slope-driven, 1 = drainage-driven
    return {"slide": slide, "flood": flood, "combined": combined, "class": cls, "uncertain": near, "stability": stability,
            "low": lo, "high": hi, "driver": driver, "hand_unknown": hand_unknown, "unassessed": unassessed,
            # Landslide and flood are different hazards with different responses: each also gets its own class.
            "slide_class": _classify(slide), "flood_class": np.where(hand_unknown, -1, _classify(flood))}


def summary(s: dict, inside: np.ndarray) -> dict:
    cls, unc = s["class"][inside], s["uncertain"][inside]
    una = s["unassessed"][inside]
    n = max(int(inside.sum()), 1)
    out = {}
    for k, name in enumerate(CLASSES):
        sel = (cls == k) & ~una
        out[name] = {"share": round(float(sel.sum()) / n, 3), "uncertain_share": round(float((sel & unc).sum()) / n, 3)}
    return {
        "classes": out,
        "uncertain_share": round(float(unc.sum()) / n, 3),
        # Drainage couldn't be traced and the slope part alone says "lower": shown as unassessed, not lower.
        "unassessed_share": round(float(una.sum()) / n, 3),
        "hand_unknown_share": round(float(s["hand_unknown"][inside].sum()) / n, 3),
        "by_hazard": {
            "landslide": {name: round(float((s["slide_class"][inside] == k).sum()) / n, 3) for k, name in enumerate(CLASSES)},
            "flood": {**{name: round(float((s["flood_class"][inside] == k).sum()) / n, 3) for k, name in enumerate(CLASSES)},
                      "unknown": round(float((s["flood_class"][inside] == -1).sum()) / n, 3)},
        },
        "slope_driven_share_of_high": round(float(((cls == 2) & (s["driver"][inside] == 0)).sum()) / max(int((cls == 2).sum()), 1), 3),
    }


def at(s: dict, r: int, c: int, slope: float, hand: float, lc_name: str) -> dict:
    """The class at one cell, with the inputs that produced it."""
    k = int(s["class"][r, c])
    return {
        "class": "unassessed" if s["unassessed"][r, c] else CLASSES[k],
        "uncertain": bool(s["uncertain"][r, c]),
        "stability": round(float(s["stability"][r, c]), 2),
        "range": [CLASSES[int(s["low"][r, c])], CLASSES[int(s["high"][r, c])]],
        "landslide_class": CLASSES[int(s["slide_class"][r, c])],
        "flood_class": "unknown" if s["flood_class"][r, c] < 0 else CLASSES[int(s["flood_class"][r, c])],
        "driver": "slope (landslide)" if s["driver"][r, c] == 0 else "drainage (flood)",
        "landslide_points": float(s["slide"][r, c]),
        "flood_points": float(s["flood"][r, c]),
        "slope_deg": round(slope, 1),
        "hand_m": None if hand != hand else round(hand, 1),  # NaN: drains out of the area before a stream
        "land_cover": lc_name,
    }


METHOD = (
    "Landslide points from slope ({slope} deg breaks), adjusted by land cover on slopes >= {s0} deg; flood points "
    "from height above nearest drainage ({hand} m breaks; drainage = >= {area} km2 upstream). Class = larger of the "
    "two: medium from {med}, high from {high} points. Input errors are simulated {n} times (slope sd {ds} deg, HAND "
    "sd {dh} m, land-cover label wrong {wrong:.0%} of the time, moving the adjustment by {dl}); a cell is uncertain if "
    "it keeps its class in fewer than {stable:.0%} of the draws. "
    "Relative ranking only: lower susceptibility is not safe."
).format(slope=SUSC["slope_breaks_deg"], s0=SUSC["slope_breaks_deg"][0], hand=SUSC["hand_breaks_m"],
         area=SUSC["stream_area_km2"], med=SUSC["medium_from"], high=SUSC["high_from"],
         ds=SUSC["slope_error_deg"], dh=SUSC["hand_error_m"], dl=SUSC["landcover_error_points"],
         n=SUSC["uncertainty_draws"], wrong=1 - SUSC["landcover_accuracy"], stable=SUSC["stable_share"])
