import datetime as dt

import numpy as np
import pandas as pd

from app.screening import forest_loss, susceptibility, terrain_grid, trigger, utm


def test_trigger_rules_any_of_all_of():
    assert trigger.evaluate({"fc24": 10, "fc72": 20, "ante7": 30, "soil": 0.5})["level"] == "none"
    assert trigger.evaluate({"fc24": 55, "fc72": 60, "ante7": 0, "soil": 0.1})["level"] == "watch"
    # Compound rule: wet antecedent + wet soil + moderate forecast
    assert trigger.evaluate({"fc24": 26, "fc72": 30, "ante7": 120, "soil": 0.8})["level"] == "watch"
    assert trigger.evaluate({"fc24": 26, "fc72": 30, "ante7": 120, "soil": 0.5})["level"] == "none"
    assert trigger.evaluate({"fc24": 95, "fc72": 100, "ante7": 0, "soil": 0.1})["level"] == "warning"
    # Missing inputs never satisfy a rule
    assert trigger.evaluate({"fc24": None, "fc72": None, "ante7": 500, "soil": 1.0})["level"] == "none"


def test_backtest_scoring_hits_and_false_alarms():
    days = pd.date_range("2010-01-01", "2010-12-31")
    rain = pd.Series(0.0, index=days)
    rain["2010-06-10"] = 120.0  # alert with a landslide
    rain["2010-09-01"] = 120.0  # alert with no landslide
    clim = pd.DataFrame({"precip_mm": rain, "soil_wetness": 0.5})
    levels = trigger.hindcast(clim)
    events = [
        {"date": "2010-06-11", "rain_triggered": True},  # within +/-1 day -> hit
        {"date": "2010-03-01", "rain_triggered": True},  # dry -> miss
        {"date": "2010-06-10", "rain_triggered": False},  # not rain-triggered -> not scored
    ]
    s = trigger.score(levels, events, 1, 1, (dt.date(2010, 1, 1), dt.date(2010, 12, 31)))
    assert s["events"] == 2 and s["hits"] == 1 and s["hit_rate"] == 0.5
    # 120 mm on day d also makes fc72 >= 80 on the two days before -> 2 episodes; one has no landslide
    assert s["alert_episodes"] == 2 and s["false_alarms"] == 1


def test_susceptibility_classes_and_wording():
    slope = np.array([[5.0, 20.0, 40.0]])
    hand = np.array([[50.0, 50.0, 50.0]])
    lc = np.array([[30, 30, 30]], dtype=np.uint8)  # grassland
    s = susceptibility.score(slope, hand, lc)
    assert list(s["class"][0]) == [0, 1, 2]
    # Valley floor: low HAND alone makes it high
    s2 = susceptibility.score(np.array([[1.0]]), np.array([[0.5]]), np.array([[50]], dtype=np.uint8))
    assert s2["class"][0, 0] == 2
    assert "not safe" in susceptibility.METHOD


def test_uncertainty_near_boundaries():
    # 24 deg grassland = 1 + 0.5 = 1.5 -> medium; +/-3 deg crosses 25 deg -> uncertain
    s = susceptibility.score(np.array([[24.0]]), np.array([[50.0]]), np.array([[30]], dtype=np.uint8))
    assert s["class"][0, 0] == 1 and s["uncertain"][0, 0]
    # 5 deg, far above drainage -> confidently lower
    s = susceptibility.score(np.array([[5.0]]), np.array([[80.0]]), np.array([[10]], dtype=np.uint8))
    assert s["class"][0, 0] == 0 and not s["uncertain"][0, 0]


def test_priority_flood_hand_on_a_v_valley():
    # V-shaped valley draining south: the centre column is the stream.
    x = np.abs(np.arange(21) - 10) * 5.0
    y = np.arange(30)[::-1, None] * 0.5
    dem = x[None, :] + y
    down, order = terrain_grid.route(dem)
    acc = terrain_grid.accumulation(down, order).reshape(dem.shape)
    assert acc[-1, 10] == acc.max()  # everything gathers at the outlet of the valley
    stream = acc >= 25
    hand = terrain_grid.hand(dem, down, order, stream)
    assert hand[15, 10] == 0
    assert 35 <= hand[15, 2] <= 45  # 40 m above the valley floor, give or take the routing
    # Edge cells drain out of the grid before meeting the stream: unknown, not zero.
    assert np.isnan(hand[15, 0])
    s = susceptibility.score(np.full((1, 1), 5.0), hand[15:16, 0:1], np.array([[10]], dtype=np.uint8))
    assert s["flood"][0, 0] == 0


def test_patches_respect_min_size():
    m = np.zeros((10, 10), dtype=bool)
    m[1:4, 1:4] = True  # 9 cells
    m[8, 8] = True  # 1 cell
    out = forest_loss._patches(m, 6)
    assert len(out) == 1 and len(out[0]) == 9


def test_utm_central_meridian():
    x, y = utm.forward(np.array([45.0]), np.array([3.0]), 31)
    assert abs(x[0] - 500000) < 1e-6 and abs(y[0] - 4982950.4) < 0.1


def test_loss_windows_same_season():
    recent, base = forest_loss._windows(dt.date(2026, 10, 5))
    assert recent == (dt.date(2026, 7, 7), dt.date(2026, 10, 5))
    years = [b[0] for b in base]
    assert years == [2025, 2024, 2023, 2022, 2021]
    assert base[0][1] == dt.date(2025, 6, 22) and base[0][2] == dt.date(2025, 10, 20)


def _serve(blob: bytes):
    import httpx

    def handler(request):
        rng = request.headers.get("Range")
        if rng:
            a, b = rng.split("=")[1].split("-")
            return httpx.Response(206, content=blob[int(a):int(b) + 1])
        return httpx.Response(200, content=blob)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_cog_reads_striped_tiffs_deflate_and_lzw():
    import asyncio
    import io

    from PIL import Image, TiffImagePlugin

    from app.screening import cog

    arr = (np.arange(300 * 200, dtype=np.uint16) % 5000).reshape(300, 200)
    for comp in ("tiff_adobe_deflate", "tiff_lzw"):
        info = TiffImagePlugin.ImageFileDirectory_v2()
        info[33550] = (30.0, 30.0, 0.0)
        info[33922] = (0.0, 0.0, 0.0, 500000.0, 1100000.0, 0.0)
        info.tagtype[33550] = info.tagtype[33922] = 12
        info[278] = 16  # rows per strip
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, "TIFF", compression=comp, tiffinfo=info)

        async def go():
            async with _serve(buf.getvalue()) as client:
                f = await cog.open_cog(client, "http://x/f.tif")
                win = await cog.read_window(client, f, 10, 40, 150, 260)
                pts = await cog.sample(client, f, np.array([500000 + 30 * 7.5]), np.array([1100000 - 30 * 123.5]))
                return f, win, pts
        f, win, pts = asyncio.run(go())
        assert f.tile_w == 200 and f.origin_x == 500000.0
        assert np.array_equal(win, arr[40:260, 10:150]), comp
        assert pts[0] == arr[123, 7]


def test_zone_from_mgrs_tile():
    assert forest_loss._zone_from_tile("16PGR") == (16, True)
    assert forest_loss._zone_from_tile("19HCD") == (19, False)


def test_change_run_end_to_end_with_synthetic_scenes(monkeypatch):
    import asyncio

    from app import config
    from app.screening import change

    lat = np.linspace(10.01, 10.0, 40)
    lon = np.linspace(-84.0, -83.99, 40)
    slope = np.full((40, 40), 5.0)
    event = dt.date(2020, 6, 1)

    async def granules(client, bbox, start, end):
        kind = "after" if start > event else "before"
        return [{"id": f"{kind}{i}", "date": (start + dt.timedelta(days=i)).isoformat(), "cloud": 5, "sensor": "S30",
                 "tile": "16PGR", "ndvi": kind, "vi": {"NDVI": kind}, "fmask": "f"} for i in range(4)]

    async def read(client, g, lat2, lon2, headers, reject, index="NDVI"):
        rng = np.random.default_rng(len(g["id"]) + int(g["id"][-1]))
        arr = 0.8 + rng.normal(0, 0.01, lat2.shape)
        if g["ndvi"] == "after":
            arr[10:20, 10:20] = 0.3  # a 100-cell blowdown patch
        return arr.astype(np.float32)

    monkeypatch.setattr(config, "EARTHDATA_TOKEN", "test-token")
    monkeypatch.setattr(change.forest_loss, "_granules", granules)
    monkeypatch.setattr(change.forest_loss, "_read_granule", read)
    res = asyncio.run(change.run(lat, lon, slope, 900.0, "cyclone", event))
    assert res["scenes"] == {"before": 4, "after": 4}
    assert len(res["patches"]) == 1 and res["patches"][0]["pixels"] == 100
    assert res["patches"][0]["label"].endswith("cause unconfirmed")
    assert res["mask"].sum() == 100


def test_backtest_lists_missed_events():
    days = pd.date_range("2010-01-01", "2010-12-31")
    clim = pd.DataFrame({"precip_mm": pd.Series(0.0, index=days), "soil_wetness": 0.5})
    levels = trigger.hindcast(clim)
    s = trigger.score(levels, [{"date": "2010-03-01", "rain_triggered": True, "title": "dry-day slide"}], 1, 1,
                      (dt.date(2010, 1, 1), dt.date(2010, 12, 31)))
    assert s["misses"] == 1 and s["missed_events"][0]["title"] == "dry-day slide"


def test_priority_squares_reasons_and_validation():
    from app.screening import priority

    n = 40
    lat = 10.0 - (np.arange(n) + 0.5) / 3600
    lon = -84.0 + (np.arange(n) + 0.5) / 3600
    grid = terrain_grid.Grid(lat, lon, 1 / 3600)
    slope = np.full((n, n), 5.0)
    slope[:10, :10] = 40.0  # one steep square in the north-west corner
    hand = np.full((n, n), 50.0)
    lc = np.full((n, n), 10, dtype=np.uint8)
    lc[:10, 10:18] = 50  # houses next to it
    a = {"lat": lat, "lon": lon, "slope": slope, "hand": hand, "landcover": lc}
    slide = {"date": "2015-01-01", "title": "test slide", "lat": float(lat[4]), "lon": float(lon[4]),
             "accuracy": "exact", "origin": "test"}
    res = priority.build(a, grid, None, [slide], (10.0, -84.0))
    slopes = [s for s in res["sites"] if s["kind"] == "slope"]
    assert slopes and slopes[0]["id"] == "L01"
    assert any("steep ground" in r for r in slopes[0]["reasons"])
    assert any("built-up" in r for r in slopes[0]["reasons"])
    assert slopes[0]["parts"]["history"] == 1.0
    v = res["validation"]
    assert v["events_usable"] == 1 and v["share_in_high"] == 1.0 and v["missed"] == []
