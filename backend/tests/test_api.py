"""API contract tests with the upstream services stubbed out."""

import pandas as pd
from fastapi.testclient import TestClient

from app import main
from app.sources.ornl import Composite


def _stub(monkeypatch):
    async def ndvi_series(lat, lon, km, start_year, end_year):
        return [Composite("A2020001", "2020-01-01", 0.71, 0.9, 81),
                Composite("A2020017", "2020-01-17", None, 0.0, 81)]

    async def daily_climate(lat, lon, start, end):
        idx = pd.to_datetime(["2020-01-01", "2020-01-02"])
        return pd.DataFrame({"precip_mm": [1.5, float("nan")], "tmax_c": [30.1, 31.0]}, index=idx)

    monkeypatch.setattr(main.ornl, "ndvi_series", ndvi_series)
    monkeypatch.setattr(main.power, "daily_climate", daily_climate)


def test_series_returns_raw_values_and_stats(monkeypatch):
    _stub(monkeypatch)
    r = TestClient(main.app).get("/api/series", params={"lat": 62.0, "lon": 129.7})
    assert r.status_code == 200
    d = r.json()
    assert d["ndvi"]["points"][0] == {"date": "2020-01-01", "ndvi": 0.71, "usable_fraction": 0.9}
    assert d["ndvi"]["points"][1]["ndvi"] is None
    assert d["climate"]["points"][1] == {"date": "2020-01-02", "precip_mm": None, "tmax_c": 31.0}
    assert "events" in d["stats"] and "hypotheses" not in str(d)


def test_accepts_any_latitude(monkeypatch):
    _stub(monkeypatch)
    c = TestClient(main.app)
    assert c.get("/api/series", params={"lat": -78.5, "lon": 166.6}).status_code == 200
    assert c.get("/api/series", params={"lat": 91, "lon": 0}).status_code == 422


def test_featured_places_are_costa_rica_and_others_span_continents():
    places = TestClient(main.app).get("/api/places").json()
    assert {p["country"] for p in places if p.get("featured")} == {"Costa Rica"}
    assert len({p["country"] for p in places}) >= 4


def test_calibrated_only_inside_the_pilot():
    from app.main import _in_pilot
    assert _in_pilot(9.915, -84.19) and _in_pilot(9.95, -84.15)
    assert not _in_pilot(29.95, -85.42) and not _in_pilot(9.915, -83.9)


def test_methods_data_files_are_found():
    # Guards the routers split: these files are located relative to the package, not the router module.
    from app.routes import methods  # noqa: F401
    from pathlib import Path
    app_dir = Path(main.__file__).resolve().parent
    assert (app_dir / "data" / "flag_rate.json").exists()
    assert (app_dir / "screening" / "data" / "catalogs.json").exists()
    src = (app_dir / "routes" / "methods.py").read_text(encoding="utf8")
    assert "parent.parent" in src
