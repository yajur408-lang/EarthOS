"""Relative landslide / flood susceptibility from slope, height above nearest drainage and land cover.

A transparent points scheme, not a calibrated model: every weight is in screening.toml.
Landslide points come from slope (plus a land-cover adjustment on steep ground); flood points come from
height above nearest drainage. The class uses the larger of the two, and cells close to a class boundary
are reported as uncertain between the two classes.
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


def score(slope: np.ndarray, hand: np.ndarray, lc: np.ndarray) -> dict:
    lookup = np.zeros(256)
    for code, group in GROUPS.items():
        lookup[code] = SUSC["landcover_points"].get(group, 0.0)
    adj = lookup[lc.astype(np.uint8)]
    slide, flood, combined = _combined(slope, hand, adj)
    cls = _classify(combined)
    # Uncertain = the class changes when slope, HAND or the land-cover adjustment move by their typical error.
    ds, dh, dl = SUSC["slope_error_deg"], SUSC["hand_error_m"], SUSC["landcover_error_points"]
    lo = _classify(_combined(np.maximum(slope - ds, 0), hand + dh, adj - dl)[2])
    hi = _classify(_combined(slope + ds, np.maximum(hand - dh, 0), adj + dl)[2])
    # Unknown drainage (HAND NaN: flow leaves the grid before meeting a drainage line) is not "no flood hazard".
    # Where the landslide part alone would say "lower", the cell is unassessed rather than lower.
    hand_unknown = ~np.isfinite(hand)
    unassessed = hand_unknown & (cls == 0)
    near = (lo != cls) | (hi != cls) | hand_unknown
    driver = np.where(slide >= flood, 0, 1)  # 0 = slope-driven, 1 = drainage-driven
    return {"slide": slide, "flood": flood, "combined": combined, "class": cls, "uncertain": near,
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
    "two: medium from {med}, high from {high} points. A cell is uncertain if its class changes when slope moves by "
    "+/-{ds} deg, HAND by +/-{dh} m or the land-cover adjustment by +/-{dl} (typical input errors). "
    "Relative ranking only: lower susceptibility is not safe."
).format(slope=SUSC["slope_breaks_deg"], s0=SUSC["slope_breaks_deg"][0], hand=SUSC["hand_breaks_m"],
         area=SUSC["stream_area_km2"], med=SUSC["medium_from"], high=SUSC["high_from"],
         ds=SUSC["slope_error_deg"], dh=SUSC["hand_error_m"], dl=SUSC["landcover_error_points"])
