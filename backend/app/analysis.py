"""Seasonal statistics and anomaly flags for an NDVI series.

Two detectors run on the same series:

* threshold - flags any composite whose NDVI fell by at least `drop` since the
              previous valid composite.
* seasonal  - a robust z-score against the same 16-day slot in *other* years
              (leave-one-year-out median and 1.4826 x MAD). Flags |z| >= z_flag.

Consecutive flagged composites are grouped into events and described with
summary statistics (NDVI, rainfall and temperature versus their seasonal norms).
This module reports measurements only; it does not attribute causes.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

MIN_USABLE_FRACTION = 0.2  # composites with less clear-sky coverage are left out of the statistics
MIN_BASELINE_YEARS = 4
MAD_TO_SIGMA = 1.4826
MIN_SCALE = {"ndvi": 0.02, "precip": 15.0, "tmax": 0.5}
Z_FLAG = 2.0
THRESHOLD_DROP = 0.10
ANTECEDENT_DAYS = 32  # rainfall window = the 16-day composite plus the preceding 32 days


def loo_seasonal_stats(values: pd.Series, doy: pd.Series, year: pd.Series,
                       min_scale: float) -> tuple[pd.Series, pd.Series]:
    """Leave-one-year-out median and robust sigma for each observation's seasonal slot."""
    med = pd.Series(np.nan, index=values.index)
    sig = pd.Series(np.nan, index=values.index)
    for slot in doy.unique():
        in_slot = doy == slot
        for idx in values.index[in_slot]:
            others = values[in_slot & (year != year[idx])].dropna()
            if len(others) < MIN_BASELINE_YEARS:
                continue
            m = float(others.median())
            mad = float((others - m).abs().median())
            med[idx] = m
            sig[idx] = max(MAD_TO_SIGMA * mad, min_scale)
    return med, sig


def build_frame(composites: list[dict], climate: pd.DataFrame | None) -> pd.DataFrame:
    df = pd.DataFrame(composites)
    df["date"] = pd.to_datetime(df["calendar_date"])
    df["doy"] = df["modis_date"].str[5:].astype(int)
    df["year"] = df["modis_date"].str[1:5].astype(int)
    df["ndvi"] = df["ndvi_mean"].where(df["usable_fraction"] >= MIN_USABLE_FRACTION)
    df = df.sort_values("date").reset_index(drop=True)

    df["ndvi_expected"], df["ndvi_sigma"] = loo_seasonal_stats(df["ndvi"], df["doy"], df["year"], MIN_SCALE["ndvi"])
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
            exp, sig = loo_seasonal_stats(df[col], df["doy"], df["year"], MIN_SCALE[key])
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
    df["flag_below"] = df["ndvi_z"] <= -z_flag
    df["flag_above"] = df["ndvi_z"] >= z_flag
    return df


def group_events(df: pd.DataFrame, column: str, max_gap: int = 1) -> list[list[int]]:
    """Group consecutive flags; tolerate `max_gap` missing (cloudy) composites in between."""
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


def describe_event(df: pd.DataFrame, idx: list[int], direction: str) -> dict:
    """Summary statistics for one event. Measurements only - no interpretation."""
    ev = df.loc[idx]
    last = idx[-1]
    after = df.loc[last + 1: last + 3]
    returned = bool((after["ndvi_z"].abs() < 1).any()) if after["ndvi_z"].notna().any() else None
    precip_pct = None
    if ev["precip_expected"].notna().any() and ev["precip_expected"].sum() > 0:
        precip_pct = float(100 * (ev["precip_mm"].sum() / ev["precip_expected"].sum() - 1))
    z = ev["ndvi_z"]
    return {
        "direction": direction,
        "start": ev["calendar_date"].iloc[0],
        "end": ev["calendar_date"].iloc[-1],
        "composites": len(idx),
        "peak_z": float(z.min() if direction == "below" else z.max()),
        "mean_ndvi": float(ev["ndvi"].mean()),
        "mean_expected": float(ev["ndvi_expected"].mean()),
        "mean_difference": float((ev["ndvi"] - ev["ndvi_expected"]).mean()),
        "usable_fraction": float(ev["usable_fraction"].mean()),
        "precip_pct_vs_median": precip_pct,
        "precip_z": _nan(ev["precip_z"].mean()),
        "tmax_z": _nan(ev["tmax_z"].mean()),
        "within_1sigma_within_3_composites": returned,
        "threshold_flags_in_event": int(ev["flag_threshold"].sum()),
    }


def compare_methods(df: pd.DataFrame) -> dict:
    valid = df["ndvi"].notna() & df["ndvi_z"].notna()
    th = df["flag_threshold"] & valid
    se = df["flag_below"] & valid
    return {
        "composites_evaluated": int(valid.sum()),
        "threshold_flags": int(th.sum()),
        "seasonal_below_flags": int(se.sum()),
        "seasonal_above_flags": int((df["flag_above"] & valid).sum()),
        "both": int((th & se).sum()),
        "threshold_only": int((th & ~se).sum()),
        "seasonal_only": int((se & ~th).sum()),
        "threshold_flags_within_1_5_sigma": int((th & (df["ndvi_z"].abs() < 1.5)).sum()),
    }


def series_records(df: pd.DataFrame) -> list[dict]:
    cols = ["calendar_date", "ndvi", "ndvi_expected", "ndvi_sigma", "ndvi_z", "usable_fraction",
            "precip_mm", "precip_expected", "precip_z", "tmax_c", "tmax_expected", "tmax_z",
            "flag_threshold", "flag_below", "flag_above"]
    out = []
    for _, r in df[cols].iterrows():
        rec = {}
        for c in cols:
            if c.startswith("flag"):
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
    events.sort(key=lambda e: -abs(e["peak_z"]))
    years = df.loc[df["ndvi"].notna(), "year"].nunique()
    return {
        "params": {"z": z_flag, "drop": drop, "min_usable_fraction": MIN_USABLE_FRACTION,
                   "min_baseline_years": MIN_BASELINE_YEARS, "antecedent_days": ANTECEDENT_DAYS},
        "series": series_records(df),
        "events": events,
        "methods": compare_methods(df),
        "warnings": [] if years > MIN_BASELINE_YEARS else [
            f"Only {years} year(s) of valid NDVI: a seasonal normal needs at least {MIN_BASELINE_YEARS} other years, "
            "so z-scores and seasonal flags are unavailable. Choose a longer period."],
        "method_notes": [
            f"Composites with < {MIN_USABLE_FRACTION:.0%} usable pixels are left out of the statistics.",
            "Seasonal median = median NDVI for the same 16-day slot in all other years (leave-one-year-out); "
            "σ = 1.4826 × MAD; normal range = median ± 2σ.",
            f"Seasonal flag: |z| ≥ {z_flag:g}. Threshold flag: NDVI fell by ≥ {drop:g} since the previous valid composite.",
            f"Event rainfall = total over each composite window plus the preceding {ANTECEDENT_DAYS} days, "
            "compared with the same windows in other years.",
        ],
    }
