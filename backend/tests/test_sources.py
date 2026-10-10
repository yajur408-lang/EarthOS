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


def test_concurrent_cache_misses_share_one_fetch(tmp_path, monkeypatch):
    from app import cache
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path)
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return {"v": 1}

    async def main():
        return await asyncio.gather(*(cache.cached_json("k", fetch) for _ in range(5)))

    assert asyncio.run(main()) == [{"v": 1}] * 5 and calls == 1


def test_chunks_align_across_year_ranges(monkeypatch):
    """A 2-year request must reuse the same chunk keys as the 10-year request."""
    requested = []
    dates = [{"modis_date": f"A{y}{d:03d}", "calendar_date": f"{y}-01-01"} for y in range(2015, 2027) for d in range(1, 366, 16)]

    async def available_dates(client, product, lat, lon):
        return dates

    async def fake_get(client, product, path, params, priority=0):
        requested.append((params["startDate"], params["endDate"]))
        return {"subset": []}

    monkeypatch.setattr(ornl, "available_dates", available_dates)
    monkeypatch.setattr(ornl, "_get", fake_get)

    async def cached(key, fetch, max_age_days=None):
        return await fetch()

    monkeypatch.setattr(ornl, "cached_json", cached)
    asyncio.run(ornl.band_series("MOD13Q1", "b", 0, 0, 1, 2025, 2026))
    short = set(requested)
    requested.clear()
    asyncio.run(ornl.band_series("MOD13Q1", "b", 0, 0, 1, 2017, 2026))
    assert short <= set(requested)


def test_priority_limiter_serves_most_urgent_first():
    order = []

    async def main():
        lim = ornl._PriorityLimiter(1)

        async def job(name, prio, hold=0.01):
            async with lim.slot(prio):
                order.append(name)
                await asyncio.sleep(hold)

        # Requests arriving together are ranked before the single slot is handed out.
        await asyncio.gather(job("old", -2015), job("new", -2026), job("mid", -2020))

    asyncio.run(main())
    assert order == ["new", "mid", "old"]
