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



# ---- one test per explanation driver, on synthetic events (thresholds from app/explain.toml)

def _ev(**kw):
    base = {"direction": "below", "composites": 2, "good_fraction": 0.95, "within_1sigma_within_3_composites": True,
            "precip_pct_vs_median": 0.0, "precip_z": 0.0, "tmax_z": 0.0, "prior_precip_pct": 0.0, "seasonal_rise": 0.0,
            "checks": [{"check": "x", "status": "pass", "detail": ""}]}
    return {**base, **kw}


def _level(res, driver):
    return next(d["level"] for d in res["drivers"] if d["id"] == driver)


def test_explain_drought_levels():
    from app.explain import explain_event
    assert _level(explain_event(_ev(precip_pct_vs_median=-25, precip_z=-0.8)), "drought") == "possible"
    assert _level(explain_event(_ev(precip_pct_vs_median=-45, precip_z=-1.6)), "drought") == "supported"
    assert _level(explain_event(_ev(precip_pct_vs_median=10, precip_z=0.6)), "drought") == "not supported"


def test_explain_late_greenup_heat_fire_landcover_flood():
    from app.explain import explain_event
    r = explain_event(_ev(seasonal_rise=0.1, prior_precip_pct=-40))
    assert _level(r, "late_greenup") == "supported"
    assert _level(explain_event(_ev(tmax_z=2.0)), "heat") == "possible"
    assert _level(explain_event(_ev(), {"burned_pct": 8.0}), "fire") == "supported"
    assert _level(explain_event(_ev(), {"burned_pct": 1.0}), "fire") == "possible"
    assert _level(explain_event(_ev(), {"burned_pct": 0.0}), "fire") == "not supported"
    lc = explain_event(_ev(composites=4, within_1sigma_within_3_composites=False),
                       {"landcover_change": {"changed": True, "detail": "forest to grass"}})
    assert _level(lc, "landcover") == "supported"
    wet = explain_event(_ev(precip_z=2.0, precip_pct_vs_median=120))
    assert _level(wet, "flood") == "possible"


def test_explain_above_normal_and_artifact_and_wording():
    from app.explain import explain_event
    up = explain_event(_ev(direction="above", precip_pct_vs_median=60, precip_z=1.2))
    assert _level(up, "wet") == "supported" and _level(up, "growth") == "possible"
    art = explain_event(_ev(good_fraction=0.3, composites=1, within_1sigma_within_3_composites=True,
                            checks=[{"check": "Clear neighbouring composites", "status": "warn", "detail": "cloudy before"}]))
    assert _level(art, "artifact") == "supported" and "may be cloud or noise" in art["summary"]
    assert "caused by" not in up["summary"] and "consistent with" in explain_event(_ev(precip_pct_vs_median=-45, precip_z=-1.6))["summary"]
