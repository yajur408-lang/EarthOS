"""Rainfall trigger (levels "Elevated" and "High" rainfall; config keys watch / warning) and its backtest against reported landslides.

Inputs: forecast rain for the next 24 / 72 h (MET Norway), observed rain over the last 7 available days and
root-zone soil wetness (NASA POWER). Rules live in screening.toml. The backtest replays the same rules over
past days using observed rain in place of the forecast ("perfect-forecast hindcast") and compares the alerts
with reported landslides (NASA Global Landslide Catalog, plus local reports).
"""

from __future__ import annotations

import csv
import datetime as dt
import gzip
import math
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from ..sources import power, weather
from .settings import BACKTEST, TRIGGER

HERE = Path(__file__).parent
RAIN_TRIGGERS = {"rain", "downpour", "continuous_rain", "tropical_cyclone", "monsoon", "flooding"}
LEVELS = ["none", "watch", "warning"]
GLC_SOURCE = {
    "name": "NASA Global Landslide Catalog (export, 2007-2017)",
    "citation": "Kirschbaum et al. (2010) Nat. Hazards 52:561-575; Kirschbaum, Stanley & Zhou (2015) Geomorphology 249:4-15",
    "url": "https://catalog.data.gov/dataset/global-landslide-catalog-export",
}


def _rule_holds(rule: dict, x: dict) -> bool:
    return all(x.get(k) is not None and x[k] >= v for k, v in rule.items())


def evaluate(x: dict) -> dict:
    """Level for one set of inputs, with the rules that fired.

    A missing input never counts as "below threshold": if no rule fires and any rule could not be checked
    because an input it needs is missing, the level is "unavailable" (not "none"). If a lower level fires
    but a higher rule could not be checked, the result is flagged incomplete.
    """
    fired = {lvl: [r for r in TRIGGER[lvl] if _rule_holds(r, x)] for lvl in ("watch", "warning")}
    unknown = {lvl: [r for r in TRIGGER[lvl] if any(x.get(k) is None for k in r)] for lvl in ("watch", "warning")}
    missing = sorted({k for lvl in unknown for r in unknown[lvl] for k in r if x.get(k) is None})
    if fired["warning"]:
        level, incomplete = "warning", False
    elif fired["watch"]:
        level, incomplete = "watch", bool(unknown["warning"])
    elif unknown["watch"] or unknown["warning"]:
        level, incomplete = "unavailable", True
    else:
        level, incomplete = "none", False
    return {"level": level, "fired": fired[level] if level in ("watch", "warning") else [],
            "missing_inputs": missing, "incomplete": incomplete}


def _forecast_sums(hours: list[dict]) -> tuple[float, float, str]:
    start = dt.datetime.fromisoformat(hours[0]["time"].replace("Z", "+00:00"))
    fc24 = fc72 = 0.0
    for h in hours:
        t = dt.datetime.fromisoformat(h["time"].replace("Z", "+00:00"))
        p = h.get("precip_mm") or 0.0
        span = h.get("precip_hours", 1)
        if t + dt.timedelta(hours=span) <= start + dt.timedelta(hours=24):
            fc24 += p
        if t + dt.timedelta(hours=span) <= start + dt.timedelta(hours=72):
            fc72 += p
    return round(fc24, 1), round(fc72, 1), start.isoformat()


async def current(lat: float, lon: float) -> dict:
    today = dt.date.today()
    errors = []
    fc24 = fc72 = None
    fc_start = None
    try:
        f = await weather.forecast(lat, lon)
        fc24, fc72, fc_start = _forecast_sums(f["hours"])
    except Exception as e:  # noqa: BLE001
        errors.append(f"Forecast unavailable: {e}")
    ante7 = soil = None
    obs_from = obs_to = None
    try:
        clim = await power.recent_daily(lat, lon, days=21)
        rain = clim["precip_mm"].dropna()
        if len(rain) >= 7:
            last7 = rain.iloc[-7:]
            ante7 = round(float(last7.sum()), 1)
            obs_from, obs_to = last7.index[0].date().isoformat(), last7.index[-1].date().isoformat()
        sw = clim["soil_wetness"].dropna()
        soil = round(float(sw.iloc[-1]), 2) if len(sw) else None
    except Exception as e:  # noqa: BLE001
        errors.append(f"Observed rain unavailable: {e}")
    x = {"fc24": fc24, "fc72": fc72, "ante7": ante7, "soil": soil}
    res = evaluate(x)
    gap = (today - dt.date.fromisoformat(obs_to)).days - 1 if obs_to else None
    return {
        **res,
        "inputs": x,
        "windows": {"forecast_from": fc_start, "observed_from": obs_from, "observed_to": obs_to,
                    "unobserved_days_before_forecast": gap},
        "rules": {"watch": TRIGGER["watch"], "warning": TRIGGER["warning"]},
        "errors": errors,
        "sources": [
            {"name": "MET Norway Locationforecast 2.0", "use": "forecast rain (next 24/72 h)", "licence": "CC BY 4.0"},
            {"name": "NASA POWER daily (PRECTOTCORR, GWETROOT)", "use": "rain over the last 7 available days; root-zone soil wetness",
             "licence": "NASA open data"},
        ],
        "notes": [
            "NASA POWER rain is a ~50 km grid average and lags a few days; local storms can be missed or diluted.",
        ] + ([f"The {gap} day(s) between the last observed day and now are not counted by either source."] if gap else []),
    }


LIVE_DAYS = 7  # dates this recent show the live forecast-based trigger


async def at_date(lat: float, lon: float, date: dt.date) -> dict:
    """The trigger for a chosen day: live (forecast) for recent days, reconstructed from observed rain for older ones."""
    today = dt.date.today()
    if date >= today - dt.timedelta(days=LIVE_DAYS):
        out = await current(lat, lon)
        out["mode"] = "live"
        if date != today:
            out["notes"] = [f"Showing current conditions (live forecast); dates more than {LIVE_DAYS} days ago are "
                            "reconstructed from observed rain."] + out["notes"]
        return out
    lat, lon = round(lat, 3), round(lon, 3)
    rec_start = dt.date(BACKTEST["start_year"], 1, 1)
    if date - dt.timedelta(days=10) >= rec_start:
        # The same daily record the backtest uses (one cached download covers every day since 2001).
        clim = await power.daily_climate(lat, lon, (rec_start - dt.timedelta(days=10)).isoformat(), today.isoformat())
    else:
        clim = await power._daily(lat, lon, (date - dt.timedelta(days=10)).isoformat(),
                                  (date + dt.timedelta(days=2)).isoformat(), max_age_days=None)
    rain, soil = clim["precip_mm"], clim["soil_wetness"]
    d = pd.Timestamp(date)
    base = {
        "mode": "reconstructed",
        "rules": {"watch": TRIGGER["watch"], "warning": TRIGGER["warning"]},
        "sources": [{"name": "NASA POWER daily (PRECTOTCORR, GWETROOT)", "use": "observed rain and root-zone soil wetness",
                     "licence": "NASA open data"}],
        "errors": [],
    }
    if d not in rain.index or pd.isna(rain.get(d)):
        return {**base, "level": "unavailable", "fired": [], "available": False, "missing_inputs": ["fc24", "fc72", "ante7", "soil"], "incomplete": True,
                "inputs": {"fc24": None, "fc72": None, "ante7": None, "soil": None},
                "windows": {"forecast_from": None, "observed_from": None, "observed_to": None, "unobserved_days_before_forecast": None},
                "notes": ["NASA POWER has not published rain for this date yet (it lags a few days)."]}
    nxt = rain.loc[d:d + pd.Timedelta(days=2)]
    prev = rain.loc[d - pd.Timedelta(days=7):d - pd.Timedelta(days=1)]
    x = {
        "fc24": round(float(rain[d]), 1),
        "fc72": round(float(nxt.sum()), 1) if len(nxt.dropna()) == 3 else None,
        "ante7": round(float(prev.sum()), 1) if len(prev.dropna()) == 7 else None,
        "soil": None if pd.isna(soil.get(d - pd.Timedelta(days=1))) else round(float(soil[d - pd.Timedelta(days=1)]), 2),
    }
    return {
        **base, **evaluate(x), "available": True, "inputs": x,
        "windows": {"forecast_from": None, "observed_from": (date - dt.timedelta(days=7)).isoformat(),
                    "observed_to": (date - dt.timedelta(days=1)).isoformat(), "unobserved_days_before_forecast": None},
        "notes": [
            "Reconstructed: archived forecasts aren't available, so the rain that actually fell on this day and the next two "
            "stands in for the 24 h and 72 h forecasts (as in the backtest).",
            "NASA POWER rain is a ~50 km grid average; local storms can be missed or diluted.",
        ],
    }


# ---------------------------------------------------------------- backtest

def _distance_km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


@lru_cache(maxsize=1)
def _catalogue() -> tuple[list[dict], np.ndarray, np.ndarray]:
    """All landslide records (NASA GLC + local reports), read once, with coordinate arrays for fast distance checks."""
    rows = []
    for path, origin, opener in ((HERE / "glc_events.csv.gz", "NASA GLC", gzip.open), (HERE / "events_local.csv", "Local report", open)):
        with opener(path, "rt", encoding="utf-8") as fh:
            rows += [{**r, "lat": float(r["lat"]), "lon": float(r["lon"]), "origin": origin,
                      "rain_triggered": r["trigger"] in RAIN_TRIGGERS} for r in csv.DictReader(fh)]
    return rows, np.array([r["lat"] for r in rows]), np.array([r["lon"] for r in rows])


def events_near(lat: float, lon: float, radius_km: float) -> list[dict]:
    rows, la, lo = _catalogue()
    p1, p2 = math.radians(lat), np.radians(la)
    h = np.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(np.radians(lo - lon) / 2) ** 2
    d = 6371 * 2 * np.arcsin(np.sqrt(np.clip(h, 0, 1)))
    out = [{**rows[i], "distance_km": round(float(d[i]), 1)} for i in np.nonzero(d <= radius_km)[0]]  # copies
    return sorted(out, key=lambda e: e["date"])


def hindcast(clim: pd.DataFrame) -> pd.DataFrame:
    """Alert level per day using observed rain as a perfect forecast."""
    # Missing rain stays missing: rules can't fire on it (comparisons with NaN are False), and the backtest reports
    # how many days were missing instead of silently treating them as dry.
    rain = clim["precip_mm"]
    soil = clim["soil_wetness"]
    df = pd.DataFrame({
        "fc24": rain,
        "fc72": rain.rolling(3).sum().shift(-2),
        "ante7": rain.shift(1).rolling(7).sum(),
        "soil": soil.shift(1),
    })
    lvl = np.zeros(len(df), dtype=int)
    for k, name in ((1, "watch"), (2, "warning")):
        hit = np.zeros(len(df), dtype=bool)
        for rule in TRIGGER[name]:
            ok = np.ones(len(df), dtype=bool)
            for key, v in rule.items():
                ok &= (df[key] >= v).fillna(False).to_numpy()
            hit |= ok
        lvl = np.where(hit, k, lvl)
    df["level"] = lvl
    return df


def _episodes(days: pd.DatetimeIndex) -> list[tuple[dt.date, dt.date]]:
    eps = []
    for d in sorted(days):
        d = d.date()
        if eps and (d - eps[-1][1]).days <= 1:
            eps[-1] = (eps[-1][0], d)
        else:
            eps.append((d, d))
    return eps


def wilson(k: int, n: int, z: float = 1.96) -> list[float] | None:
    """95% Wilson score interval for a proportion k/n (sensible even for tiny n)."""
    if not n:
        return None
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [round(max(0.0, centre - half), 3), round(min(1.0, centre + half), 3)]


def _scored_events(events: list[dict], period: tuple[dt.date, dt.date]) -> list[dict]:
    """Rain-triggered events in the period, one per day (copies: nothing is written back to the caller's dicts).
    Several catalogue entries on one day count once - a ~50 km rain cell can't tell them apart."""
    lo, hi = period
    by_day: dict[str, dict] = {}
    for e in events:
        if e["rain_triggered"] and lo <= dt.date.fromisoformat(e["date"]) <= hi:
            d = by_day.setdefault(e["date"], {"date": e["date"], "titles": []})
            d["titles"].append(e.get("title", ""))
    return [{"date": d["date"], "title": " / ".join(t for t in d["titles"] if t), "reports": len(d["titles"])}
            for d in sorted(by_day.values(), key=lambda x: x["date"])]


def _score_alert_days(alert_days: set[dt.date], evs: list[dict], window: int, period: tuple[dt.date, dt.date]) -> dict:
    lo, hi = period
    days_in = {d for d in alert_days if lo <= d <= hi}
    hit_flags = [any((dt.date.fromisoformat(e["date"]) + dt.timedelta(days=k)) in days_in for k in range(-window, window + 1))
                 for e in evs]
    eps = _episodes(pd.DatetimeIndex(sorted(days_in)))
    ev_dates = [dt.date.fromisoformat(e["date"]) for e in evs]
    no_event = sum(1 for a, b in eps if not any(a - dt.timedelta(days=window) <= d <= b + dt.timedelta(days=window) for d in ev_dates))
    years = max(((hi - lo).days + 1) / 365.25, 1e-9)
    return {"hits": sum(hit_flags), "hit_flags": hit_flags, "episodes": len(eps), "no_event": no_event,
            "alert_days": len(days_in), "alert_days_per_year": round(len(days_in) / years, 1)}


def score(levels: pd.DataFrame, events: list[dict], min_level: int, window: int,
          period: tuple[dt.date, dt.date]) -> dict:
    evs = _scored_events(events, period)
    alert = {d.date() for d in levels.index[levels["level"] >= min_level]}
    r = _score_alert_days(alert, evs, window, period)
    n = len(evs)
    return {
        "level": LEVELS[min_level],
        "period": [period[0].isoformat(), period[1].isoformat()],
        "events": n,
        "event_reports": sum(e["reports"] for e in evs),
        "hits": r["hits"],
        "hit_rate": round(r["hits"] / n, 3) if n else None,
        "hit_rate_ci": wilson(r["hits"], n),
        "misses": n - r["hits"],
        "missed_events": [{"date": e["date"], "title": e["title"]} for e, h in zip(evs, r["hit_flags"]) if not h],
        "alert_episodes": r["episodes"],
        # Alert episodes with no catalogued landslide within the window. Catalogues miss many slides, so this is an
        # upper bound on false alarms, not a measurement of them.
        "no_event_alerts": r["no_event"],
        "no_event_alert_rate": round(r["no_event"] / r["episodes"], 3) if r["episodes"] else None,
        "no_event_alert_rate_ci": wilson(r["no_event"], r["episodes"]),
        "alert_days": r["alert_days"],
        "alert_days_per_year": r["alert_days_per_year"],
        "enough_events": n >= BACKTEST["min_events_for_rate"],
    }


def baselines(levels: pd.DataFrame, events: list[dict], min_level: int, window: int,
              period: tuple[dt.date, dt.date]) -> dict:
    """What chance and a simpler rule achieve with the same number of alert days.

    random: alert days drawn uniformly at random over the period (seeded Monte Carlo), same count as the rules.
    rain_only: alert on the days with the most rain (fc24), with the threshold set to give the same count.
    """
    lo, hi = period
    evs = _scored_events(events, period)
    n = len(evs)
    in_period = levels.loc[pd.Timestamp(lo):pd.Timestamp(hi)]
    k = int((in_period["level"] >= min_level).sum())
    days = [d.date() for d in in_period.index]
    out: dict = {"alert_days": k, "events": n}
    if not k or not n:
        return out
    rng = np.random.default_rng(BACKTEST["baseline_seed"])
    hit_rates, ne_rates = [], []
    for _ in range(BACKTEST["baseline_draws"]):
        pick = {days[i] for i in rng.choice(len(days), size=k, replace=False)}
        r = _score_alert_days(pick, evs, window, period)
        hit_rates.append(r["hits"] / n)
        if r["episodes"]:
            ne_rates.append(r["no_event"] / r["episodes"])
    q = lambda xs: [round(float(np.percentile(xs, 2.5)), 3), round(float(np.percentile(xs, 97.5)), 3)]  # noqa: E731
    observed = score(levels, events, min_level, window, period)["hit_rate"] or 0.0
    out["random"] = {
        "hit_rate_mean": round(float(np.mean(hit_rates)), 3), "hit_rate_95": q(hit_rates),
        "no_event_alert_rate_mean": round(float(np.mean(ne_rates)), 3) if ne_rates else None,
        "p_at_least_observed": round(float(np.mean(np.array(hit_rates) >= observed - 1e-9)), 3),
        "draws": BACKTEST["baseline_draws"],
    }
    rain = in_period["fc24"].fillna(-1)
    thr = float(np.sort(rain.to_numpy())[::-1][k - 1])
    rain_days = {d.date() for d in rain.index[rain >= thr]}
    r = _score_alert_days(rain_days, evs, window, period)
    out["rain_only"] = {
        "threshold_mm": round(thr, 1), "alert_days": r["alert_days"],
        "hit_rate": round(r["hits"] / n, 3), "hit_rate_ci": wilson(r["hits"], n),
        "no_event_alert_rate": round(r["no_event"] / r["episodes"], 3) if r["episodes"] else None,
    }
    return out


async def backtest(lat: float, lon: float) -> dict:
    radius = BACKTEST["radius_km"]
    window = BACKTEST["match_days"]
    events = events_near(lat, lon, radius)
    start = dt.date(BACKTEST["start_year"], 1, 1)
    clim = await power.daily_climate(lat, lon, (start - dt.timedelta(days=10)).isoformat(), dt.date.today().isoformat())  # shared with at_date
    levels = hindcast(clim)
    last = levels.index.max().date()
    # Scoring period: the years the event lists cover (GLC export 2007-2017 plus any local reports), within the rain record.
    ev_years = [int(e["date"][:4]) for e in events if e["rain_triggered"]] or [2007]
    period = (max(dt.date(min(min(ev_years), 2007), 1, 1), start), min(dt.date(max(max(ev_years), 2017), 12, 31), last))
    scores = [score(levels, events, k, window, period) for k in (1, 2)]
    split = dt.date(BACKTEST["split_year"], 1, 1)
    blocks = []
    if period[0] < split <= period[1]:
        for name, per in (("earlier", (period[0], split - dt.timedelta(days=1))), ("later", (split, period[1]))):
            blocks.append({"block": name, "period": [per[0].isoformat(), per[1].isoformat()],
                           "scores": [score(levels, events, k, window, per) for k in (1, 2)]})
    base = {LEVELS[k]: baselines(levels, events, k, window, period) for k in (1, 2)}
    for e in events:
        d = pd.Timestamp(e["date"])
        if d in levels.index:
            row = levels.loc[d]
            e["rain_mm"] = None if pd.isna(row["fc24"]) else round(float(row["fc24"]), 1)
            e["ante7_mm"] = None if pd.isna(row["ante7"]) else round(float(row["ante7"]), 1)
            e["soil"] = None if pd.isna(row["soil"]) else round(float(row["soil"]), 2)
            e["level_on_day"] = LEVELS[int(levels.loc[d - pd.Timedelta(days=window):d + pd.Timedelta(days=window), "level"].max())]
    return {
        "place": {"lat": lat, "lon": lon, "radius_km": radius},
        "period": [period[0].isoformat(), period[1].isoformat()],
        "match_days": window,
        "scores": scores,
        "blocks": blocks,
        "days_missing_rain": int(levels.loc[pd.Timestamp(period[0]):pd.Timestamp(period[1]), "fc24"].isna().sum()),
        "split_note": ("The thresholds were set by judgment before scoring, not fitted to these events. The earlier and "
                       "later blocks are reported separately so any future tuning can be done on the earlier block and "
                       "judged on the later one."),
        "baselines": base,
        "min_events_for_rate": BACKTEST["min_events_for_rate"],
        "events": events,
        "rules": {"watch": TRIGGER["watch"], "warning": TRIGGER["warning"]},
        "method": (
            "Each past day is scored with the same rules, using that day's observed rain (NASA POWER) in place of the "
            "forecast: fc24 = rain that day, fc72 = that day plus the next two, ante7 = the 7 days before, soil = the day "
            f"before. A rain-triggered landslide counts as a hit if an alert was active within +/-{window} day(s). "
            "Hit rate = hits / events (events on the same day count once). 'Alerts with no catalogued landslide' = alert "
            f"episodes with no reported landslide within +/-{window} day(s) / all alert episodes - an upper bound on false "
            "alarms, because catalogues miss many slides. 95% Wilson intervals are shown. Baselines: the same number of "
            "alert days placed at random (Monte Carlo), and a rain-only rule set to the same number of alert days."
        ),
        "caveats": [
            "Perfect-forecast hindcast: real forecasts are less accurate, so real-world hit rates would be lower.",
            "Landslide catalogues only include events that made the news, so many 'alerts with no catalogued landslide' may be unreported slides.",
            "NASA POWER rain is a ~50 km grid average, which smooths out the local downpours that often trigger slides.",
            "Few events: treat the rates as a first check of the thresholds, not a validated skill score.",
        ],
        "sources": [GLC_SOURCE,
                    {"name": "NASA POWER daily", "use": "rain and soil wetness", "url": "https://power.larc.nasa.gov/"}],
    }
