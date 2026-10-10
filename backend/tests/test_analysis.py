"""Synthetic checks for the seasonal statistics."""

import numpy as np
import pandas as pd

from app import analysis


def synthetic(years=range(2014, 2024), shift_year=None, shift_doys=(), shift=-0.3):
    rng = np.random.default_rng(0)
    rows = []
    for y in years:
        for doy in range(1, 366, 16):
            # Dry-forest style: green-up near DOY 150, abrupt dry-season decline near DOY 345
            ndvi = 0.4 + 0.4 / (1 + np.exp(-(doy - 150) / 8)) - 0.4 / (1 + np.exp(-(doy - 345) / 8))
            ndvi += rng.normal(0, 0.01)
            if y == shift_year and doy in shift_doys:
                ndvi += shift
            date = (pd.Timestamp(y, 1, 1) + pd.Timedelta(days=doy - 1)).strftime("%Y-%m-%d")
            rows.append({"modis_date": f"A{y}{doy:03d}", "calendar_date": date, "ndvi_mean": ndvi,
                         "usable_fraction": 0.9, "n_pixels": 81})
    return rows


def test_regular_seasonal_cycle_is_not_flagged():
    out = analysis.analyse(synthetic(), None)
    assert out["methods"]["seasonal_below_flags"] == 0
    assert out["methods"]["threshold_flags"] > 0  # the naive method fires on the seasonal decline


def test_out_of_season_drop_is_one_below_event():
    # Mid-season (stable) slots, so the pooled seasonal window doesn't straddle the green-up.
    out = analysis.analyse(synthetic(shift_year=2020, shift_doys=(225, 241, 257)), None)
    below = [e for e in out["events"] if e["direction"] == "below"]
    assert len(below) == 1 and below[0]["composites"] == 3 and below[0]["start"].startswith("2020")


def test_above_normal_event_detected():
    out = analysis.analyse(synthetic(shift_year=2019, shift_doys=(33, 49), shift=+0.3), None)
    assert any(e["direction"] == "above" for e in out["events"])


def test_cloudy_composites_are_left_out():
    rows = synthetic()
    rows[10]["usable_fraction"] = 0.05
    assert analysis.analyse(rows, None)["series"][10]["ndvi"] is None


def test_events_carry_checks_and_hedged_explanations():
    out = analysis.analyse(synthetic(shift_year=2020, shift_doys=(225, 241, 257)), None)
    ev = out["events"][0]
    assert {c["check"] for c in ev["checks"]} >= {"Cloud-free pixels", "Persistence", "Size of change"}
    x = ev["explanation"]
    assert x["confidence"] in {"high", "medium", "low"} and x["drivers"]
    assert "caused by" not in x["summary"].lower()


def test_cloudy_composite_is_shown_but_never_flagged():
    rows = synthetic()
    i = next(k for k, r in enumerate(rows) if r["modis_date"] == "A2020241")
    rows[i].update(ndvi_mean=0.2, good_fraction=0.0, cloudy_fraction=0.7, usable_fraction=0.3)
    out = analysis.analyse(rows, None)
    rec = out["series"][i]
    assert rec["ndvi"] is None and rec["ndvi_raw"] == 0.2 and not rec["flag_below"]
    assert out["methods"]["composites_excluded_quality"] == 1


def test_short_record_warns_instead_of_failing():
    out = analysis.analyse(synthetic(years=range(2022, 2024)), None)
    assert out["warnings"] and all(r["ndvi_z"] is None for r in out["series"])
