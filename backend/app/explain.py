"""Evidence-grounded explanations for NDVI anomaly events.

Each event gets:
* a confidence level from the data-quality checks (can we trust the change is real?),
* candidate drivers rated "supported", "possible" or "not supported" by the evidence,
  each with the evidence for and against and which dataset it came from,
* a one-sentence summary that says what the data are *consistent with* - never "caused by".

Rules are deliberately simple and transparent; every threshold is visible here.
"""

from __future__ import annotations

SUPPORTED, POSSIBLE, UNSUPPORTED = "supported", "possible", "not supported"


def _confidence(checks: list[dict]) -> str:
    fails = sum(c["status"] == "fail" for c in checks)
    warns = sum(c["status"] == "warn" for c in checks)
    return "low" if fails or warns >= 3 else "medium" if warns >= 1 else "high"


def _driver(id_, title, level, support, against, sources):
    return {"id": id_, "title": title, "level": level, "for": support, "against": against, "sources": sources}


def explain_event(ev: dict, context: dict | None = None) -> dict:
    """`context` may add {"burned_pct": float|None, "landcover_change": {...}|None} from extra datasets."""
    context = context or {}
    checks = ev.get("checks", [])
    confidence = _confidence(checks)
    below = ev["direction"] == "below"
    p_pct, p_z, t_z = ev.get("precip_pct_vs_median"), ev.get("precip_z"), ev.get("tmax_z")
    recovered = ev.get("within_1sigma_within_3_composites")
    n = ev["composites"]
    good = ev.get("good_fraction", ev.get("usable_fraction", 1))
    drivers: list[dict] = []

    # 1) Observation artifact
    art_for = [s for s in [
        f"only {good:.0%} of pixels rated good" if good < 0.6 else None,
        "single 16-day composite" if n == 1 else None,
        "NDVI back to normal within ~48 days" if recovered and n == 1 else None,
        next((c["detail"] for c in checks if c["check"] == "Clear neighbouring composites" and c["status"] != "pass"), None),
    ] if s]
    art_level = SUPPORTED if len(art_for) >= 3 else POSSIBLE if art_for else UNSUPPORTED
    drivers.append(_driver("artifact", "Residual cloud, haze or sensor noise", art_level, art_for,
                           [] if art_for else ["most pixels were clear and the change persisted"], ["MOD13Q1 QA"]))

    if below:
        # 2) Drought: rain during the event window, or in the weeks just before it
        prior = ev.get("prior_precip_pct")
        dry_now = p_z is not None and (p_z <= -1 or (p_pct is not None and p_pct <= -20))
        dry_before = prior is not None and prior <= -30
        dry = dry_now or dry_before
        strong = (p_z is not None and p_z <= -1.5) or (p_pct is not None and p_pct <= -40) or (prior is not None and prior <= -50)
        wet = p_z is not None and p_z >= 0.5
        drivers.append(_driver(
            "drought", "Dry spell / drought stress",
            SUPPORTED if dry and strong else POSSIBLE if dry else UNSUPPORTED,
            [s for s in [
                f"rainfall {p_pct:+.0f}% vs the usual for these weeks" if dry_now and p_pct is not None else None,
                f"rainfall {prior:+.0f}% vs usual in the month before" if dry_before else None,
            ] if s],
            ["rainfall was near or above normal"] if (p_z is not None and not dry) else ["no rainfall data"] if p_z is None else [],
            ["NASA POWER"]))
        # 2b) Late green-up: the season normally greens up fast at this time of year
        rise = ev.get("seasonal_rise")
        if rise is not None and rise >= 0.05:
            drivers.append(_driver(
                "late_greenup", "Late start of the growing / rainy-season green-up",
                SUPPORTED if dry else POSSIBLE,
                [f"normally NDVI rises by {rise:.2f} at this time of year"] + (["rain was below normal beforehand"] if dry else []),
                [] if dry else ["rainfall did not clearly lag"], ["MOD13Q1", "NASA POWER"]))
        # 3) Heat
        hot = t_z is not None and t_z >= 1.5
        drivers.append(_driver(
            "heat", "Heat stress", POSSIBLE if hot else UNSUPPORTED,
            [f"daily max temperature z {t_z:+.1f}"] if hot else [],
            ([] if hot else ["temperatures were near normal"] if t_z is not None else ["no temperature data"])
            + (["a concurrent rain deficit can itself raise surface temperature"] if hot and dry else []),
            ["NASA POWER"]))
        # 4) Fire
        burned = context.get("burned_pct")
        if burned is not None:
            drivers.append(_driver(
                "fire", "Fire", SUPPORTED if burned >= 5 else POSSIBLE if burned > 0 else UNSUPPORTED,
                [f"{burned:.1f}% of the area mapped as burned during the event"] if burned > 0 else [],
                [] if burned > 0 else ["no burned pixels mapped during the event"], ["MODIS MCD64A1"]))
        # 5) Land-cover change / clearing
        lc = context.get("landcover_change")
        persistent = n >= 3 and recovered is False
        lc_for = [s for s in [
            f"below normal for {n} composites (~{n * 16} days) without recovering" if persistent else None,
            lc["detail"] if lc and lc.get("changed") else None,
            "not explained by a rain deficit" if persistent and not dry else None,
        ] if s]
        lc_against = [s for s in [
            "NDVI recovered quickly, unusual after clearing" if recovered else None,
            "land-cover classes stayed the same" if lc and not lc.get("changed") else None,
        ] if s]
        drivers.append(_driver(
            "landcover", "Land-cover change (clearing, conversion, harvest)",
            SUPPORTED if (lc and lc.get("changed") and persistent) else POSSIBLE if lc_for and not recovered else UNSUPPORTED,
            lc_for, lc_against, ["MOD13Q1", "MODIS MCD12Q1"] if lc else ["MOD13Q1"]))
        # 6) Flooding / waterlogging
        if wet and (p_z or 0) >= 1.5:
            drivers.append(_driver(
                "flood", "Flooding or waterlogging", POSSIBLE,
                [f"rainfall {p_pct:+.0f}% vs usual (z {p_z:+.1f})"] if p_pct is not None else [f"rainfall z {p_z:+.1f}"],
                ["heavy rain also brings cloud, which lowers NDVI in composites"], ["NASA POWER"]))
    else:
        prior = ev.get("prior_precip_pct")
        wet_now = p_z is not None and (p_z >= 1 or (p_pct is not None and p_pct >= 30))
        wet_before = prior is not None and prior >= 30
        wet = wet_now or wet_before
        drivers.append(_driver(
            "wet", "Wetter than usual",
            SUPPORTED if wet and ((p_pct or 0) >= 50 or (prior or 0) >= 50) else POSSIBLE if wet else UNSUPPORTED,
            [s for s in [
                f"rainfall {p_pct:+.0f}% vs usual for these weeks" if wet_now and p_pct is not None else None,
                f"rainfall {prior:+.0f}% vs usual in the month before" if wet_before else None,
            ] if s],
            [] if wet else ["rainfall was near or below normal"] if p_z is not None else ["no rainfall data"],
            ["NASA POWER"]))
        rise = ev.get("seasonal_rise")
        if rise is not None and rise >= 0.05:
            drivers.append(_driver(
                "early_greenup", "Early start of the rainy-season green-up", SUPPORTED if wet else POSSIBLE,
                [f"normally NDVI rises by {rise:.2f} at this time of year"] + (["rain arrived early or heavy"] if wet else []),
                [] if wet else ["rainfall did not clearly lead"], ["MOD13Q1", "NASA POWER"]))
        drivers.append(_driver(
            "growth", "Earlier or stronger green-up (crops, regrowth)", POSSIBLE if n >= 2 else UNSUPPORTED,
            [f"above normal for {n} composites"] if n >= 2 else [], [] if n >= 2 else ["single composite"], ["MOD13Q1"]))

    order = {SUPPORTED: 0, POSSIBLE: 1, UNSUPPORTED: 2}
    drivers.sort(key=lambda d: (order[d["level"]], d["id"] == "artifact"))
    leading = [d for d in drivers if d["level"] == SUPPORTED and d["id"] != "artifact"]
    possible = [d for d in drivers if d["level"] == POSSIBLE and d["id"] != "artifact"]
    artifact = next(d for d in drivers if d["id"] == "artifact")
    what = "Below-normal greenness" if below else "Above-normal greenness"

    if confidence == "low" or artifact["level"] == SUPPORTED:
        summary = f"{what}, but the data quality is weak: this may be cloud or noise rather than a real change."
    elif leading:
        summary = f"{what} most consistent with: {', '.join(d['title'].lower() for d in leading)}."
    elif possible:
        summary = f"{what}; possible drivers: {', '.join(d['title'].lower() for d in possible)}. No single driver is clearly supported."
    else:
        summary = f"{what} that the available weather and fire data don't explain."
    return {"confidence": confidence, "summary": summary, "drivers": drivers,
            "caveat": "Consistent with ≠ caused by. Check imagery and local knowledge before drawing conclusions."}
