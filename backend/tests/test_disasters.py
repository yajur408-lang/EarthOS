"""Natural-hazard lookups: bundled catalogues (real data) and the two network sources (faked)."""

import asyncio
import datetime as dt

import numpy as np

from app.screening import disasters as D

D_ = dt.date


def test_distance_is_haversine():
    assert abs(float(D._km(0, 0, 0, 1)) - 111.19) < 0.1
    assert np.allclose(D._km(10, 20, np.array([10, 11]), np.array([20, 20])), [0, 111.19], atol=0.1)


def test_saffir_simpson_categories():
    assert D._category(float("nan")) == "intensity unknown"
    assert D._category(30) == "tropical depression"
    assert D._category(50) == "tropical storm"
    assert "category 1" in D._category(70)
    assert "category 3" in D._category(100)
    assert "category 5" in D._category(140)


def test_hurricane_michael_passes_mexico_beach():
    ev = D.cyclones_near(29.95, -85.42, 200, D_(2018, 10, 1), D_(2018, 10, 31))
    michael = [e for e in ev if e["title"].startswith("Michael")]
    assert len(michael) == 1  # one event per storm, not one per 6-hourly fix
    m = michael[0]
    assert m["distance_km"] < 25 and m["date"] == "2018-10-10"
    assert "category 5" in m["detail"] and m["severity"] >= 137


def test_cyclone_outside_dates_or_radius_is_dropped():
    later = D.cyclones_near(29.95, -85.42, 200, D_(2018, 11, 1), D_(2018, 11, 30))
    assert not any(e["title"].startswith("Michael") for e in later)
    # Mid-Sahara: no tracked cyclone ever came within 200 km.
    assert D.cyclones_near(23.0, 12.0, 200, D_(1980, 1, 1), D_(2024, 12, 31)) == []


def test_joplin_tornado_path_distance():
    ev = D.tornadoes_near(37.06, -94.48, 40, D_(2011, 5, 22), D_(2011, 5, 22))
    ef5 = [e for e in ev if e["severity"] == 5]
    assert len(ef5) == 1
    assert ef5[0]["title"] == "EF5 tornado, MO" and ef5[0]["distance_km"] < 5
    assert len(ef5[0]["path"]) == 2 and "deaths" in ef5[0]["detail"]
    # Distances are to the path, so every listed tornado is within the radius.
    assert all(e["distance_km"] <= 40 for e in ev)


def test_tornadoes_are_us_only():
    assert D.tornadoes_near(9.915, -84.19, 40, D_(1950, 1, 1), D_(2024, 12, 31)) == []


def test_landslides_near_pilot_use_the_backtest_catalogue():
    ev = D.landslides_near(9.915, -84.19, 25, D_(2010, 1, 1), D_(2010, 12, 31))
    assert ev and all(e["type"] == "landslide" and e["date"].startswith("2010") for e in ev)
    assert any("Montoya" in e["title"] for e in ev)
    assert all(e["link"] is None or e["link"].startswith("http") for e in ev)


def _fake_cache(payloads):
    async def cached_json(key, fetch, max_age_days=None):
        for prefix, data in payloads.items():
            if key.startswith(prefix):
                if isinstance(data, Exception):
                    raise data
                return data
        raise AssertionError(key)
    return cached_json


QUAKE = {"features": [{"properties": {"mag": 6.1, "place": "10 km S of Somewhere", "time": 1536624000000, "felt": 12,
                                      "url": "https://earthquake.usgs.gov/x"},
                       "geometry": {"coordinates": [-84.2, 9.8, 12.0]}}]}
EONET = {"events": [
    {"title": "Wildfire near pilot", "categories": [{"id": "wildfires"}], "sources": [{"id": "InciWeb", "url": "https://x"}],
     "geometry": [{"type": "Point", "coordinates": [-84.3, 9.9], "date": "2019-03-01T00:00:00Z"},
                  {"type": "Point", "coordinates": [-84.2, 9.92], "date": "2019-03-02T00:00:00Z"}]},
    {"title": "Far away fire", "categories": [{"id": "wildfires"}],
     "geometry": [{"type": "Point", "coordinates": [10.0, 50.0], "date": "2019-03-01T00:00:00Z"}]},
    {"title": "Sea ice", "categories": [{"id": "seaLakeIce"}],
     "geometry": [{"type": "Point", "coordinates": [-84.2, 9.9], "date": "2019-03-01T00:00:00Z"}]},
]}


def test_earthquakes_and_eonet_are_parsed(monkeypatch):
    monkeypatch.setattr(D, "cached_json", _fake_cache({"usgsq_": QUAKE, "eonetq_": EONET}))
    q = asyncio.run(D.earthquakes_near(9.915, -84.19, 150, D_(2018, 1, 1), D_(2018, 12, 31)))
    assert q[0]["title"].startswith("M6.1") and q[0]["date"] == "2018-09-11" and "felt reports: 12" in q[0]["detail"]
    e = asyncio.run(D.eonet_near(9.915, -84.19, 100, D_(2019, 1, 1), D_(2019, 12, 31)))
    # Only the nearby wildfire: the far one is outside the radius, sea ice isn't a hazard type here.
    assert [x["title"] for x in e] == ["Wildfire near pilot"]
    assert e[0]["date"] == "2019-03-02" and e[0]["distance_km"] < 5  # closest of its points


def test_near_combines_sources_and_reports_failures(monkeypatch):
    monkeypatch.setattr(D, "cached_json", _fake_cache({"usgsq_": QUAKE, "eonetq_": RuntimeError("EONET down")}))
    res = asyncio.run(D.near(9.915, -84.19, D_(2010, 1, 1), D_(2018, 12, 31)))
    assert res["errors"] == ["NASA EONET unavailable: RuntimeError"]
    assert res["counts"].get("earthquake") == 1 and res["counts"].get("landslide", 0) >= 1
    dates = [e["date"] for e in res["events"]]
    assert dates == sorted(dates, reverse=True)
    for e in res["events"]:
        assert e["type_name"]
        # Satellite checks are only suggested where 30 m imagery exists (HLS from mid-2013).
        assert (e["satellite_check"] is None) == (e["date"] < "2013-06-01" or e["type"] not in D.CHECKS)
    assert set(res["sources"]) >= {"cyclone", "tornado", "earthquake", "eonet", "landslide"}
