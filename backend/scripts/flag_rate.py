"""How often does the vegetation anomaly detector flag something when nothing happened? (Brief item B7)

Run from backend/:  python -m scripts.flag_rate
Writes app/data/flag_rate.json, which the Methods page shows.

Two estimates, both using the real detector (analysis.detect / group_events):
1. Null (no disturbance): for each featured place, synthetic series are built from that place's own seasonal median
   per 16-day slot plus independent noise with its own robust spread (1.4826 x MAD of the residuals). Nothing
   unusual happens in them by construction, so every flag is a false flag. Many draws give flags per point-year.
2. Real data: the same detector on the places' actual 10-year records (seed cache). This includes real anomalies
   (e.g. the 2026 late green-up at Santa Rosa), so it is an upper bound on the false-flag rate, not an estimate of it.

Limitation: independent Gaussian noise ignores autocorrelation and heavy tails in real NDVI, so the null rate is a
lower bound on what real, undisturbed series would show.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parent.parent
os.environ.setdefault("PREWARM_PLACES", "")
sys.path.insert(0, str(BACKEND))

import asyncio  # noqa: E402

from app import analysis  # noqa: E402
from app.places import FEATURED  # noqa: E402
from app.sources import ornl, power  # noqa: E402

DRAWS = 200
SEED = 7


async def load(p: dict, start: int, end: int):
    comps = await ornl.ndvi_series(p["lat"], p["lon"], p["km"], start, end)
    clim = await power.daily_climate(p["lat"], p["lon"], (dt.date(start, 1, 1) - dt.timedelta(days=analysis.ANTECEDENT_DAYS)).isoformat(),
                                     f"{end}-12-31")
    return [asdict(c) for c in comps], clim


def flags(df) -> tuple[int, int, int]:
    """(flagged composites, events, trusted composites) for both directions."""
    n_flag = int(df["flag_below"].sum() + df["flag_above"].sum())
    n_events = len(analysis.group_events(df, "flag_below")) + len(analysis.group_events(df, "flag_above"))
    return n_flag, n_events, int(df["trusted"].sum())


def main():
    year = dt.date.today().year
    start, end = year - 9, year - 1  # complete years only
    rng = np.random.default_rng(SEED)
    out = {"generated": dt.date.today().isoformat(), "years": [start, end], "draws_per_place": DRAWS,
           "params": {"z": analysis.Z_FLAG, "min_deviation": analysis.MIN_DEVIATION}, "places": []}
    null_flags = null_events = null_points = 0
    real_flags = real_events = real_trusted = 0
    for p in FEATURED:
        comps, clim = asyncio.run(load(p, start, end))
        base = analysis.build_frame(comps, clim)
        real = analysis.detect(base.copy())
        rf, re_, rt = flags(real)
        real_flags, real_events, real_trusted = real_flags + rf, real_events + re_, real_trusted + rt
        # Per-slot seasonal median and noise from this place's trusted values.
        t = base[base["trusted"]]
        med = t.groupby("doy")["ndvi"].median()
        resid = t["ndvi"] - t["doy"].map(med)
        sigma = max(1.4826 * float(np.median(np.abs(resid - np.median(resid)))), 0.01)
        pf = pe = 0
        for _ in range(DRAWS):
            syn = base.copy()
            syn["ndvi"] = syn["doy"].map(med) + rng.normal(0, sigma, len(syn))
            syn.loc[~syn["trusted"], "ndvi"] = np.nan
            syn["ndvi_raw"] = syn["ndvi"]
            d = analysis.detect(syn)
            f, e, _n = flags(d)
            pf, pe = pf + f, pe + e
        years_n = end - start + 1
        null_flags, null_events, null_points = null_flags + pf, null_events + pe, null_points + DRAWS * years_n
        out["places"].append({
            "id": p["id"], "name": p["name"], "noise_sigma": round(sigma, 3),
            "null_events_per_year": round(pe / (DRAWS * years_n), 3),
            "real_events_per_year": round(re_ / years_n, 3), "real_flagged_composites": rf, "trusted_composites": rt,
        })
        print(p["name"], out["places"][-1], flush=True)
    n_years = end - start + 1
    out["null"] = {"events_per_point_year": round(null_events / null_points, 3),
                   "flagged_composites_per_point_year": round(null_flags / null_points, 3)}
    out["real"] = {"events_per_point_year": round(real_events / (len(FEATURED) * n_years), 3),
                   "flagged_share_of_trusted_composites": round(real_flags / max(real_trusted, 1), 4)}
    out["method"] = __doc__.split("\n\n", 1)[1].strip()
    dest = BACKEND / "app" / "data" / "flag_rate.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=1))
    print(json.dumps({k: out[k] for k in ("null", "real")}, indent=1))


if __name__ == "__main__":
    main()
