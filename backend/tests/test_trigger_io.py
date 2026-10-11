"""Rainfall trigger with its data sources faked: live forecast sums, reconstructed past days, and the backtest run."""

import asyncio
import datetime as dt

import numpy as np
import pandas as pd

from app.screening import trigger


def test_forecast_sums_respect_24_and_72_hour_windows():
    t0 = dt.datetime(2026, 10, 1, 0, tzinfo=dt.timezone.utc)
    hours = [{"time": (t0 + dt.timedelta(hours=h)).isoformat().replace("+00:00", "Z"), "precip_mm": 1.0, "precip_hours": 1}
             for h in range(24)]
    # Later, MET Norway switches to 6-hour blocks.
    hours += [{"time": (t0 + dt.timedelta(hours=h)).isoformat().replace("+00:00", "Z"), "precip_mm": 6.0, "precip_hours": 6}
              for h in range(24, 96, 6)]
    hours.append({"time": (t0 + dt.timedelta(hours=96)).isoformat().replace("+00:00", "Z"), "precip_mm": None})
    fc24, fc72, start = trigger._forecast_sums(hours)
    assert fc24 == 24.0
    assert fc72 == 24.0 + 6.0 * 8  # blocks starting at 24..66 h end by 72 h
    assert start.startswith("2026-10-01T00:00")


def clim_frame(start="2000-12-20", end=None, rain=0.0, soil=0.5):
    days = pd.date_range(start, end or dt.date.today().isoformat())
    return pd.DataFrame({"precip_mm": float(rain), "soil_wetness": float(soil)}, index=days)


def test_current_combines_forecast_and_observed(monkeypatch):
    async def forecast(lat, lon):
        return {"hours": [{"time": "2026-10-01T00:00:00Z", "precip_mm": 60.0, "precip_hours": 1}]}

    async def recent(lat, lon, days=21):
        c = clim_frame((dt.date.today() - dt.timedelta(days=20)).isoformat(),
                       (dt.date.today() - dt.timedelta(days=4)).isoformat(), rain=2.0, soil=0.7)
        return c

    monkeypatch.setattr(trigger.weather, "forecast", forecast)
    monkeypatch.setattr(trigger.power, "recent_daily", recent)
    r = asyncio.run(trigger.current(9.9, -84.2))
    assert r["level"] == "watch" and r["inputs"] == {"fc24": 60.0, "fc72": 60.0, "ante7": 14.0, "soil": 0.7}
    assert r["windows"]["unobserved_days_before_forecast"] == 3
    assert any("3 day(s)" in n for n in r["notes"]) and r["errors"] == []


def test_past_day_is_reconstructed_from_observed_rain(monkeypatch):
    c = clim_frame()
    c.loc["2010-10-01", "precip_mm"] = 95.0  # High-level rain on the day
    c.loc["2010-09-24":"2010-09-30", "precip_mm"] = 20.0
    c.loc["2010-09-30", "soil_wetness"] = 0.85

    async def daily_climate(lat, lon, start, end):
        assert start == "2000-12-22"  # one download covering every day since the record start
        return c

    monkeypatch.setattr(trigger.power, "daily_climate", daily_climate)
    r = asyncio.run(trigger.at_date(9.915, -84.19, dt.date(2010, 10, 1)))
    assert r["mode"] == "reconstructed" and r["available"]
    assert r["inputs"] == {"fc24": 95.0, "fc72": 95.0, "ante7": 140.0, "soil": 0.85}
    assert r["level"] == "warning"
    # A day POWER hasn't published yet: unavailable, never "none".
    c.loc["2010-10-05", "precip_mm"] = np.nan
    r = asyncio.run(trigger.at_date(9.915, -84.19, dt.date(2010, 10, 5)))
    assert r["level"] == "unavailable" and not r["available"]


def test_days_before_the_record_use_a_short_download(monkeypatch):
    calls = []

    async def _daily(lat, lon, start, end, max_age_days):
        calls.append((start, end))
        return clim_frame("1995-06-01", "1995-06-30", rain=1.0)

    monkeypatch.setattr(trigger.power, "_daily", _daily)
    r = asyncio.run(trigger.at_date(9.9, -84.2, dt.date(1995, 6, 15)))
    assert calls == [("1995-06-05", "1995-06-17")] and r["level"] == "none"


def test_recent_days_show_the_live_trigger(monkeypatch):
    async def current(lat, lon):
        return {"level": "none", "notes": ["n"]}

    monkeypatch.setattr(trigger, "current", current)
    r = asyncio.run(trigger.at_date(9.9, -84.2, dt.date.today() - dt.timedelta(days=2)))
    assert r["mode"] == "live" and "reconstructed from observed rain" in r["notes"][0]


def test_backtest_runs_on_fake_records_and_is_cached(monkeypatch):
    c = clim_frame(rain=0.0)
    for d in ("2008-06-10", "2012-10-03", "2015-09-01"):  # two alerts with landslides, one without
        c.loc[d, "precip_mm"] = 100.0
    events = [
        {"date": "2008-06-10", "rain_triggered": True, "title": "A", "lat": 9.9, "lon": -84.2, "distance_km": 1.0},
        {"date": "2012-10-04", "rain_triggered": True, "title": "B", "lat": 9.9, "lon": -84.2, "distance_km": 2.0},
        {"date": "2014-01-15", "rain_triggered": True, "title": "C (dry day)", "lat": 9.9, "lon": -84.2, "distance_km": 3.0},
        {"date": "2018-09-11", "rain_triggered": True, "title": "D (after the catalogue)", "lat": 9.9, "lon": -84.2, "distance_km": 4.0},
    ]
    calls = []

    async def daily_climate(lat, lon, start, end):
        calls.append(1)
        return c

    monkeypatch.setattr(trigger.power, "daily_climate", daily_climate)
    monkeypatch.setattr(trigger, "events_near", lambda lat, lon, r: [dict(e) for e in events])
    monkeypatch.setattr(trigger, "_bt_cache", {})
    r = asyncio.run(trigger.backtest(1.234, 5.678))
    assert r["period"] == ["2007-01-01", "2017-12-31"]
    watch = r["scores"][0]
    assert (watch["hits"], watch["events"], watch["no_event_alerts"]) == (2, 3, 1)
    assert [e["title"] for e in watch["missed_events"]] == ["C (dry day)"]
    d = next(e for e in r["events"] if e["title"].startswith("D"))
    assert d["scored"] is False and d["level_on_day"] == "none"
    a = next(e for e in r["events"] if e["title"] == "A")
    assert a["scored"] and a["rain_mm"] == 100.0 and a["level_on_day"] == "warning"
    assert {b["block"] for b in r["blocks"]} == {"earlier", "later"}
    assert set(r["baselines"]["watch"]) >= {"random", "random_any_day", "rain_only"}
    assert r["days_missing_rain"] == 0
    # Second call is served from the cache, and callers can't corrupt the cached copy.
    r["scores"].clear()
    again = asyncio.run(trigger.backtest(1.234, 5.678))
    assert len(calls) == 1 and again["scores"]
