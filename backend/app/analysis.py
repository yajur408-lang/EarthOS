"""Seasonal statistics, quality-controlled anomaly flags and per-event validation for an NDVI series.

Quality control (the part that matters most in cloudy tropics):

* A composite is *trusted* only if enough of its pixels are rated "good" by MODIS
  (pixel reliability 0), or if it is nearly cloud-free. "Marginal" pixels often sit on
  cloud edges, so a composite built mostly from them is shown but never flagged.

Seasonal normal:

* For each composite, the expected NDVI is the median of the *same and neighbouring*
  16-day slots in all *other* years (leave-one-year-out, ~27 values for 10 years),
  with sigma = 1.4826 x MAD and a floor, so a very stable season can't turn a small
  wobble into an extreme z-score.

Flags:

* seasonal - trusted, |z| >= z_flag AND |NDVI - median| >= MIN_DEVIATION (a real change, not just
             a statistically unusual small one).
* threshold - the naive baseline: NDVI fell by >= drop since the previous trusted composite.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .explain import explain_event

__all__ = ["analyse", "explain_event"]

MIN_USABLE_FRACTION = 0.2  # below this the composite is not even shown as a value
TRUST_GOOD = 0.3  # trusted if at least this share of pixels is rated "good"...
TRUST_USABLE, TRUST_CLOUDY = 0.8, 0.05  # ...or nearly all pixels usable and almost none cloudy
MIN_BASELINE_YEARS = 4
MAD_TO_SIGMA = 1.4826
MIN_SCALE = {"ndvi": 0.03, "precip": 15.0, "tmax": 0.5}
MIN_DEVIATION = 0.05  # NDVI units; smaller departures are not flagged however unusual
POOL_SLOTS = 1  # also use the neighbouring 16-day slot on each side of the season
# Bump when the statistics change, so memoised results (and the seed) are recomputed.
VERSION = 2
Z_FLAG = 2.0
THRESHOLD_DROP = 0.10
ANTECEDENT_DAYS = 32  # rainfall window = the 16-day composite plus the preceding 32 days
SLOTS = list(range(1, 366, 16))  # MOD13Q1 composite start days


def _neighbour_slots(doy: int, pool: int) -> set[int]:
    i = SLOTS.index(doy) if doy in SLOTS else min(range(len(SLOTS)), key=lambda k: abs(SLOTS[k] - doy))
    return {SLOTS[(i + k) % len(SLOTS)] for k in range(-pool, pool + 1)}


def loo_seasonal_stats(values: pd.Series, doy: pd.Series, year: pd.Series, min_scale: float,
                       pool: int = 0) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Leave-one-year-out median, robust sigma and sample count for each observation's season."""
    med = pd.Series(np.nan, index=values.index)
    sig = pd.Series(np.nan, index=values.index)
    n = pd.Series(0, index=values.index)
    years_ok = values.notna()
    for slot in doy.unique():
        in_season = doy.isin(_neighbour_slots(int(slot), pool)) if pool else doy == slot
        for idx in values.index[doy == slot]:
            others = values[in_season & years_ok & (year != year[idx])]
            if others.groupby(year[others.index]).size().size < MIN_BASELINE_YEARS:
                continue
            m = float(others.median())
            mad = float((others - m).abs().median())
            med[idx] = m
            sig[idx] = max(MAD_TO_SIGMA * mad, min_scale)
            n[idx] = len(others)
    return med, sig, n


def build_frame(composites: list[dict], climate: pd.DataFrame | None) -> pd.DataFrame:
    df = pd.DataFrame(composites)
    # Older cached data may lack the finer QA fields: fall back to the usable share and assume no cloud.
    df["good_fraction"] = (df["good_fraction"] if "good_fraction" in df else pd.Series(np.nan, index=df.index)).fillna(df["usable_fraction"])
    df["cloudy_fraction"] = (df["cloudy_fraction"] if "cloudy_fraction" in df else pd.Series(np.nan, index=df.index)).fillna(0.0)
    df["date"] = pd.to_datetime(df["calendar_date"])
    df["doy"] = df["modis_date"].str[5:].astype(int)
    df["year"] = df["modis_date"].str[1:5].astype(int)
    df = df.sort_values("date").reset_index(drop=True)
    shown = df["usable_fraction"] >= MIN_USABLE_FRACTION
    df["trusted"] = shown & ((df["good_fraction"] >= TRUST_GOOD)
                             | ((df["usable_fraction"] >= TRUST_USABLE) & (df["cloudy_fraction"] <= TRUST_CLOUDY)))
    df["ndvi_raw"] = df["ndvi_mean"].where(shown)
    df["ndvi"] = df["ndvi_mean"].where(df["trusted"])  # statistics and flags use trusted composites only

    df["ndvi_expected"], df["ndvi_sigma"], df["baseline_n"] = loo_seasonal_stats(
        df["ndvi"], df["doy"], df["year"], MIN_SCALE["ndvi"], pool=POOL_SLOTS)
    df["ndvi_z"] = (df["ndvi"] - df["ndvi_expected"]) / df["ndvi_sigma"]

    if climate is not None and not climate.empty:
        precip, tmax = [], []
        for d in df["date"]:
            p = climate["precip_mm"].loc[d - pd.Timedelta(days=ANTECEDENT_DAYS): d + pd.Timedelta(days=15)]
            t = climate["tmax_c"].loc[d: d + pd.Timedelta(days=15)]
            precip.append(p.sum() if p.count() >= 40 else np.nan)  # only (nearly) complete windows
            tmax.append(t.mean() if t.count() >= 12 else np.nan)
        df["precip_mm"] = precip
        df["tmax_c"] = tmax
        for col, key in (("precip_mm", "precip"), ("tmax_c", "tmax")):
            exp, sig, _ = loo_seasonal_stats(df[col], df["doy"], df["year"], MIN_SCALE[key], pool=POOL_SLOTS)
            df[f"{key}_expected"] = exp
            df[f"{key}_z"] = (df[col] - exp) / sig
    else:
        for c in ("precip_mm", "tmax_c", "precip_expected", "tmax_expected", "precip_z", "tmax_z"):
            df[c] = np.nan
    return df


def detect(df: pd.DataFrame, z_flag: float = Z_FLAG, drop: float = THRESHOLD_DROP) -> pd.DataFrame:
    df = df.copy()
    prev = df["ndvi"].ffill().shift(1)
    df["ndvi_change"] = df["ndvi"] - prev
    df["flag_threshold"] = df["ndvi_change"] <= -drop
    big = (df["ndvi"] - df["ndvi_expected"]).abs() >= MIN_DEVIATION
    df["flag_below"] = (df["ndvi_z"] <= -z_flag) & big
    df["flag_above"] = (df["ndvi_z"] >= z_flag) & big
    return df


def group_events(df: pd.DataFrame, column: str, max_gap: int = 1) -> list[list[int]]:
    """Group consecutive flags; tolerate `max_gap` untrusted (cloudy) composites in between."""
    events: list[list[int]] = []
    current: list[int] = []
    gap = 0
    for i, row in df.iterrows():
        if row[column]:
            current.append(i)
            gap = 0
        elif current and pd.isna(row["ndvi"]) and gap < max_gap:
            gap += 1
        elif current:
            events.append(current)
            current, gap = [], 0
    if current:
        events.append(current)
    return events


def _nan(x):
    return None if x is None or pd.isna(x) else float(x)


def validate_event(df: pd.DataFrame, idx: list[int], ev: dict) -> list[dict]:
    """Data-quality checks for one event: can it be trusted as a real change on the ground?"""
    rows = df.loc[idx]
    good = float(rows["good_fraction"].mean())
    neighbours = df.loc[[i for i in (idx[0] - 1, idx[-1] + 1) if 0 <= i < len(df)]]
    cloudy_nb = float(neighbours["cloudy_fraction"].max()) if len(neighbours) else 0.0
    baseline = int(rows["baseline_n"].min())
    diff = abs(ev["mean_difference"])
    checks = [
        {"check": "Cloud-free pixels", "status": "pass" if good >= 0.6 else "warn" if good >= 0.3 else "fail",
         "detail": f"{good:.0%} of pixels rated good by MODIS QA during the event"},
        {"check": "Persistence", "status": "pass" if ev["composites"] >= 2 else "warn",
         "detail": f"{ev['composites']} consecutive 16-day composite{'s' if ev['composites'] > 1 else ''}"
                   + ("" if ev["composites"] >= 2 else " - a single composite can be noise")},
        {"check": "Size of change", "status": "pass" if diff >= 0.1 else "warn",
         "detail": f"NDVI {ev['mean_difference']:+.2f} vs the seasonal median"},
        {"check": "Clear neighbouring composites", "status": "pass" if cloudy_nb < 0.3 else "warn",
         "detail": "adjacent composites were mostly clear" if cloudy_nb < 0.3
         else f"an adjacent composite was {cloudy_nb:.0%} cloudy - residual cloud is possible"},
        {"check": "Depth of baseline", "status": "pass" if baseline >= 15 else "warn",
         "detail": f"seasonal normal from {baseline} values in other years"},
    ]
    return checks


def describe_event(df: pd.DataFrame, idx: list[int], direction: str) -> dict:
    ev_rows = df.loc[idx]
    last = idx[-1]
    after = df.loc[last + 1: last + 3]
    returned = bool((after["ndvi_z"].abs() < 1).any()) if after["ndvi_z"].notna().any() else None
    precip_pct = None
    if ev_rows["precip_expected"].notna().any() and ev_rows["precip_expected"].sum() > 0:
        precip_pct = float(100 * (ev_rows["precip_mm"].sum() / ev_rows["precip_expected"].sum() - 1))
    z = ev_rows["ndvi_z"]
    ev = {
        "direction": direction,
        "start": ev_rows["calendar_date"].iloc[0],
        "end": ev_rows["calendar_date"].iloc[-1],
        "composites": len(idx),
        "peak_z": float(z.min() if direction == "below" else z.max()),
        "mean_ndvi": float(ev_rows["ndvi"].mean()),
        "mean_expected": float(ev_rows["ndvi_expected"].mean()),
        "mean_difference": float((ev_rows["ndvi"] - ev_rows["ndvi_expected"]).mean()),
        "usable_fraction": float(ev_rows["usable_fraction"].mean()),
        "good_fraction": float(ev_rows["good_fraction"].mean()),
        "precip_pct_vs_median": precip_pct,
        "precip_z": _nan(ev_rows["precip_z"].mean()),
        "tmax_z": _nan(ev_rows["tmax_z"].mean()),
        "within_1sigma_within_3_composites": returned,
        "threshold_flags_in_event": int(ev_rows["flag_threshold"].sum()),
    }
    # Context just before the event: was the season ramping up (green-up), and was it dry beforehand?
    prev_rows = df.loc[max(idx[0] - 2, 0): idx[0] - 1]
    first = ev_rows.iloc[0]
    if len(prev_rows) and pd.notna(first["ndvi_expected"]) and prev_rows["ndvi_expected"].notna().any():
        ev["seasonal_rise"] = float(first["ndvi_expected"] - prev_rows["ndvi_expected"].dropna().iloc[0])
    else:
        ev["seasonal_rise"] = None
    if prev_rows["precip_expected"].notna().any() and prev_rows["precip_expected"].sum() > 0:
        ev["prior_precip_pct"] = float(100 * (prev_rows["precip_mm"].sum() / prev_rows["precip_expected"].sum() - 1))
    else:
        ev["prior_precip_pct"] = None
    ev["checks"] = validate_event(df, idx, ev)
    ev["explanation"] = explain_event(ev)  # climate + data quality; /api/explain adds fire and land cover
    return ev


def compare_methods(df: pd.DataFrame) -> dict:
    valid = df["ndvi"].notna() & df["ndvi_z"].notna()
    th = df["flag_threshold"] & valid
    se = df["flag_below"] & valid
    return {
        "composites_evaluated": int(valid.sum()),
        "composites_excluded_quality": int((df["ndvi_raw"].notna() & df["ndvi"].isna()).sum()),
        "threshold_flags": int(th.sum()),
        "seasonal_below_flags": int(se.sum()),
        "seasonal_above_flags": int((df["flag_above"] & valid).sum()),
        "both": int((th & se).sum()),
        "threshold_only": int((th & ~se).sum()),
        "seasonal_only": int((se & ~th).sum()),
        "threshold_flags_within_1_5_sigma": int((th & (df["ndvi_z"].abs() < 1.5)).sum()),
    }


def series_records(df: pd.DataFrame) -> list[dict]:
    cols = ["calendar_date", "ndvi", "ndvi_raw", "ndvi_expected", "ndvi_sigma", "ndvi_z", "usable_fraction",
            "good_fraction", "cloudy_fraction", "trusted",
            "precip_mm", "precip_expected", "precip_z", "tmax_c", "tmax_expected", "tmax_z",
            "flag_threshold", "flag_below", "flag_above"]
    out = []
    for _, r in df[cols].iterrows():
        rec = {}
        for c in cols:
            if c.startswith("flag") or c == "trusted":
                rec[c] = bool(r[c])
            elif c == "calendar_date":
                rec["date"] = r[c]
            else:
                rec[c] = _nan(r[c])
        out.append(rec)
    return out


def analyse(composites: list[dict], climate: pd.DataFrame | None,
            z_flag: float = Z_FLAG, drop: float = THRESHOLD_DROP) -> dict:
    df = detect(build_frame(composites, climate), z_flag=z_flag, drop=drop)
    events = ([describe_event(df, i, "below") for i in group_events(df, "flag_below")]
              + [describe_event(df, i, "above") for i in group_events(df, "flag_above")])
    # Most trustworthy, largest changes first.
    rank = {"high": 0, "medium": 1, "low": 2}
    events.sort(key=lambda e: (rank[e["explanation"]["confidence"]], -abs(e["mean_difference"])))
    years = df.loc[df["ndvi"].notna(), "year"].nunique()
    return {
        "params": {"z": z_flag, "drop": drop, "min_usable_fraction": MIN_USABLE_FRACTION,
                   "min_baseline_years": MIN_BASELINE_YEARS, "antecedent_days": ANTECEDENT_DAYS,
                   "min_deviation": MIN_DEVIATION},
        "series": series_records(df),
        "events": events,
        "methods": compare_methods(df),
        "warnings": [] if years > MIN_BASELINE_YEARS else [
            f"Only {years} year(s) of trusted NDVI: a seasonal normal needs at least {MIN_BASELINE_YEARS} other years, "
            "so z-scores and seasonal flags are unavailable. Choose a longer period."],
        "method_notes": [
            f"A composite is trusted when at least {TRUST_GOOD:.0%} of its pixels are rated 'good' by MODIS QA, or it is "
            f"nearly cloud-free; others are drawn faintly and never flagged.",
            "Seasonal median = median NDVI of the same and neighbouring 16-day periods in all other years "
            "(leave-one-year-out); σ = 1.4826 × MAD with a floor of 0.03; normal range = median ± 2σ.",
            f"Seasonal flag: |z| ≥ {z_flag:g} and NDVI at least {MIN_DEVIATION} away from the median. "
            f"Threshold flag: NDVI fell by ≥ {drop:g} since the previous trusted composite.",
            f"Event rainfall = total over each composite window plus the preceding {ANTECEDENT_DAYS} days, "
            "compared with the same windows in other years.",
            "Explanations rank which drivers the available data are consistent with. They are evidence checks, "
            "not proof of cause.",
        ],
    }
