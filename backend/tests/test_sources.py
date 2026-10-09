"""Unit tests for MODIS band transformations, with the ORNL service stubbed out."""

import asyncio

import numpy as np

from app.sources import ornl


def _stub(monkeypatch, values_by_band):
    async def band_series(product, band, lat, lon, km, start_year, end_year):
        return [(f"A2020{i:03d}", f"2020-01-{i + 1:02d}", np.asarray(v, dtype=float))
                for i, v in enumerate(values_by_band[band])]
    monkeypatch.setattr(ornl, "band_series", band_series)


def test_burned_fraction_ignores_unmapped_and_water(monkeypatch):
    # 2 burned, 1 unburned, 1 unmapped (-1), 1 water (-2) -> 2 of 3 mapped land pixels
    _stub(monkeypatch, {"Burn_Date": [[120, 130, 0, -1, -2]]})
    out = asyncio.run(ornl.burned_series(0, 0, 1, 2020, 2020))
    assert out[0]["burned_fraction"] == 2 / 3 and out[0]["pixels"] == 3


def test_landcover_fractions_use_igbp_names(monkeypatch):
    _stub(monkeypatch, {"LC_Type1": [[2, 2, 12, 255]]})  # 255 = unclassified, ignored
    out = asyncio.run(ornl.landcover_series(0, 0, 1, 2020, 2020))
    assert out[0]["classes"] == {"Evergreen broadleaf forest": 0.6667, "Cropland": 0.3333}


def test_lst_converts_kelvin_scale_and_skips_fill(monkeypatch):
    # 15000 * 0.02 = 300 K = 26.85 °C; 0 is the fill value
    _stub(monkeypatch, {"LST_Day_1km": [[15000, 0]], "LST_Night_1km": [[0, 0]]})
    out = asyncio.run(ornl.lst_series(0, 0, 1, 2020, 2020))
    assert out[0]["day_c"] == 26.85 and out[0]["night_c"] is None
