"""Rainfall trigger (Watch / Warning) and its backtest against reported landslides.

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
    """Level for one set of inputs, with the rules that fired."""
    fired = {lvl: [r for r in TRIGGER[lvl] if _rule_holds(r, x)] for lvl in ("watch", "warning")}
    level = "warning" if fired["warning"] else "watch" if fired["watch"] else "none"
    return {"level": level, "fired": fired[level] if level != "none" else []}


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
        return {**base, "level": "none", "fired": [], "available": False,
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


def events_near(lat: float, lon: float, radius_km: float) -> list[dict]:
    out = []
    files = [(gzip.open(HERE / "glc_events.csv.gz", "rt", encoding="utf-8"), "NASA GLC"),
             (open(HERE / "events_local.csv", encoding="utf-8"), "Local report")]
    for fh, origin in files:
        with fh:
            for r in csv.DictReader(fh):
                d = _distance_km(lat, lon, float(r["lat"]), float(r["lon"]))
                if d <= radius_km:
                    out.append({**r, "lat": float(r["lat"]), "lon": float(r["lon"]), "distance_km": round(d, 1),
                                "origin": origin, "rain_triggered": r["trigger"] in RAIN_TRIGGERS})
    return sorted(out, key=lambda e: e["date"])


def hindcast(clim: pd.DataFrame) -> pd.DataFrame:
    """Alert level per day using observed rain as a perfect forecast."""
    rain = clim["precip_mm"].fillna(0.0)
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


def score(levels: pd.DataFrame, events: list[dict], min_level: int, window: int,
          period: tuple[dt.date, dt.date]) -> dict:
    alert_days = levels.index[levels["level"] >= min_level]
    alert_set = {d.date() for d in alert_days}
    lo, hi = period
    evs = [e for e in events if e["rain_triggered"] and lo <= dt.date.fromisoformat(e["date"]) <= hi]
    hits = 0
    for e in evs:
        d = dt.date.fromisoformat(e["date"])
        e_hit = any((d + dt.timedelta(days=k)) in alert_set for k in range(-window, window + 1))
        e.setdefault("hit", {})[LEVELS[min_level]] = e_hit
        hits += e_hit
    eps = [ep for ep in _episodes(alert_days) if lo <= ep[0] <= hi]
    ev_dates = [dt.date.fromisoformat(e["date"]) for e in evs]
    false = sum(1 for a, b in eps if not any(a - dt.timedelta(days=window) <= d <= b + dt.timedelta(days=window) for d in ev_dates))
    years = max((hi - lo).days / 365.25, 1e-9)
    return {
        "level": LEVELS[min_level],
        "events": len(evs),
        "hits": hits,
        "hit_rate": round(hits / len(evs), 3) if evs else None,
        "misses": len(evs) - hits,
        "missed_events": [{"date": e["date"], "title": e.get("title", "")} for e in evs if not e["hit"][LEVELS[min_level]]],
        "alert_episodes": len(eps),
        "false_alarms": false,
        "false_alarm_rate": round(false / len(eps), 3) if eps else None,
        "alert_days_per_year": round(sum(1 for d in alert_set if lo <= d <= hi) / years, 1),
    }


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
        "events": events,
        "rules": {"watch": TRIGGER["watch"], "warning": TRIGGER["warning"]},
        "method": (
            "Each past day is scored with the same rules, using that day's observed rain (NASA POWER) in place of the "
            "forecast: fc24 = rain that day, fc72 = that day plus the next two, ante7 = the 7 days before, soil = the day "
            f"before. A rain-triggered landslide counts as a hit if an alert was active within +/-{window} day(s). "
            "Hit rate = hits / events. False-alarm rate = alert episodes with no reported landslide within "
            f"+/-{window} day(s) / all alert episodes."
        ),
        "caveats": [
            "Perfect-forecast hindcast: real forecasts are less accurate, so real-world hit rates would be lower.",
            "Landslide catalogues only include events that made the news, so many 'false alarms' may be unreported slides.",
            "NASA POWER rain is a ~50 km grid average, which smooths out the local downpours that often trigger slides.",
            "Few events: treat the rates as a first check of the thresholds, not a validated skill score.",
        ],
        "sources": [GLC_SOURCE,
                    {"name": "NASA POWER daily", "use": "rain and soil wetness", "url": "https://power.larc.nasa.gov/"}],
    }
