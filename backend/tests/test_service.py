"""Screening service: area caching, overlay images, and the background job lifecycle (no network)."""

import asyncio
import datetime as dt
import io
import json

import numpy as np
import pytest
from PIL import Image

from app.screening import forest_loss, service


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DIR", tmp_path)
    monkeypatch.setattr(service, "_jobs", {})
    monkeypatch.setattr(service, "_inflight", {})
    monkeypatch.setattr(service, "_sem", None)  # a semaphore binds to the event loop it was first used on
    return tmp_path


def fake_area(n: int = 6) -> dict:
    """A tiny area: west half steep forest, east half flat; one stream column; one water cell; one cell whose
    drainage can't be traced (HAND NaN) on flat ground."""
    step = 1 / 3600
    lat = 9.9 - np.arange(n) * step
    lon = -84.2 + np.arange(n) * step
    slope = np.where(np.arange(n)[None, :] < n // 2, 40.0, 2.0) * np.ones((n, 1))
    hand = np.full((n, n), 30.0)
    hand[0, n - 1] = np.nan
    stream = np.zeros((n, n), dtype=bool)
    stream[:, n // 2] = True
    lc = np.full((n, n), 10, dtype=np.uint8)  # tree cover
    lc[n - 1, n - 1] = 80  # open water
    return {"lat": lat, "lon": lon, "step": np.array(step), "dem": np.linspace(800, 1200, n * n).reshape(n, n).astype(np.float32),
            "slope": slope.astype(np.float32), "hand": hand.astype(np.float32), "stream": stream, "landcover": lc,
            "built_s": np.array(0.1)}


def rgba(png: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))


def test_snap_rounds_and_clamps():
    assert service.snap(9.9163, -84.1912, 6.04) == (9.915, -84.19, 6.0)
    assert service.snap(0, 0, 0.1)[2] == 1.0  # at least 1 km
    assert service.snap(0, 0, 999)[2] == service.AREA["max_half_km"]
    assert service.snap(0, 0, None)[2] == service.AREA["default_half_km"]
    assert service.area_key(9.915, -84.19, 6.0).startswith(f"v{service.VERSION}_")


def test_area_is_built_once_then_read_from_disk(monkeypatch, isolated):
    calls = []

    async def build(lat, lon, half_km, path):
        calls.append(1)
        await asyncio.sleep(0.01)
        a = fake_area()
        np.savez_compressed(path, **a)
        return a

    monkeypatch.setattr(service, "_build_area", build)

    async def twice():
        return await asyncio.gather(service.area(9.915, -84.19, 6.0), service.area(9.915, -84.19, 6.0))

    a, b = asyncio.run(twice())
    assert len(calls) == 1  # concurrent requests share one build
    assert (a["slope"] == b["slope"]).all()
    again = asyncio.run(service.area(9.915, -84.19, 6.0))
    assert len(calls) == 1 and (again["landcover"] == a["landcover"]).all()  # from disk
    assert list(isolated.glob("area_*.npz"))


def test_overlay_colours_follow_the_rules():
    a = fake_area()
    combined = rgba(service.susceptibility_png(a, "combined"))
    assert combined[5, 5, 3] == 0  # open water: transparent
    assert tuple(combined[0, 5]) == (128, 128, 128, 110)  # drainage unknown on flat ground: grey, never "lower"
    assert tuple(combined[2, 3]) == (30, 136, 229, 200)  # stream line
    assert combined[2, 0, 0] == 211  # steep forest: high (red)
    landslide = rgba(service.susceptibility_png(a, "landslide"))
    assert tuple(landslide[2, 3][:3]) != (30, 136, 229)  # no stream lines on the landslide view
    assert landslide[0, 5, :3].tolist() != [128, 128, 128]  # landslide view doesn't depend on drainage
    flood = rgba(service.susceptibility_png(a, "flood"))
    assert tuple(flood[0, 5]) == (128, 128, 128, 110)
    preview = Image.open(io.BytesIO(service.preview_png(a)))
    assert preview.size == (12, 12) and preview.mode == "RGB"


def test_susceptibility_result_reports_point_and_wording(monkeypatch):
    async def area(lat, lon, half_km):
        return fake_area()

    monkeypatch.setattr(service, "area", area)
    a = fake_area()
    res = asyncio.run(service.susceptibility_result(9.9, -84.2, 1.0, (float(a["lat"][2]), float(a["lon"][0]))))
    assert res["wording"] == "Lower susceptibility, not safe."
    assert res["at_point"]["landslide_class"] == "high" and res["at_point"]["land_cover"] == "Tree cover"
    assert abs(sum(res["land_cover"].values()) - 1.0) < 1e-6
    assert res["terrain"]["elevation_m"] == [800, 1200]
    assert {s["use"] for s in res["sources"]} == {"elevation, slope, drainage, HAND", "land cover"}


def test_safe_error_strips_signed_urls_and_tokens():
    e = RuntimeError("GET https://data.lpdaac.earthdatacloud.nasa.gov/x.tif?X-Amz-Signature=abc&token=s3cr3t failed; "
                     "Authorization: Bearer eyJhbGciOi.abc-def")
    txt = service._safe_error(e)
    assert "s3cr3t" not in txt and "X-Amz" not in txt and "eyJ" not in txt
    assert txt.startswith("RuntimeError: GET https://data.lpdaac.earthdatacloud.nasa.gov/x.tif?…")
    assert len(service._safe_error(RuntimeError("x" * 1000))) == 300


def test_loss_dates():
    end = service.default_loss_end()
    assert end.weekday() == 0 and 5 <= (dt.date.today() - end).days < 12
    assert service.loss_end_for(None) == (end, None)
    assert service.loss_end_for(dt.date.today()) == (end, None)
    assert service.loss_end_for(dt.date(2020, 3, 4)) == (dt.date(2020, 3, 4), None)
    none, msg = service.loss_end_for(dt.date(2012, 1, 1))
    assert none is None and "2013" in msg


def _patch_area(monkeypatch):
    async def area(lat, lon, half_km):
        return fake_area()
    monkeypatch.setattr(service, "area", area)


def _run_job(start):
    """Start a job and let it finish inside one event loop; returns the first response."""
    async def go():
        first = start()
        for _ in range(200):
            await asyncio.sleep(0)
        return first
    return asyncio.run(go())


def test_loss_job_lifecycle(monkeypatch, isolated):
    _patch_area(monkeypatch)
    end = dt.date(2024, 6, 3)

    async def run(lat, lon, slope, cell_m2, end_, progress):
        progress(0.5)
        mask = np.zeros(slope.shape, dtype=bool)
        mask[1, 1] = True
        return {"patches": [{"ha": 0.6}], "mask": mask, "scenes": 12}

    monkeypatch.setattr(forest_loss, "run", run)
    assert service.loss_status(9.9, -84.2, 1.0, end)["status"] == "not_started"
    first = _run_job(lambda: service.start_loss(9.9, -84.2, 1.0, end))
    assert first["status"] == "running" and "task" not in first
    st = service.loss_status(9.9, -84.2, 1.0, end)
    assert st["status"] == "done" and st["has_overlay"] and st["scenes"] == 12 and "bounds" in st
    png = rgba(service.loss_png_path(9.9, -84.2, 1.0, end).read_bytes())
    assert tuple(png[1, 1]) == (217, 70, 239, 230) and png[0, 0, 3] == 0
    # Asking again returns the stored result instead of starting a new job.
    assert service.start_loss(9.9, -84.2, 1.0, end)["status"] == "done"


def test_loss_job_without_token_or_with_errors(monkeypatch):
    _patch_area(monkeypatch)

    async def needs_token(*a):
        raise forest_loss.NeedsToken("Add an Earthdata token")

    monkeypatch.setattr(forest_loss, "run", needs_token)
    _run_job(lambda: service.start_loss(9.9, -84.2, 1.0, dt.date(2024, 6, 3)))
    st = service.loss_status(9.9, -84.2, 1.0, dt.date(2024, 6, 3))
    assert st["status"] == "unavailable" and "Earthdata" in st["error"]

    async def boom(*a):
        raise OSError("https://x.nasa.gov/f.tif?sig=SECRET timed out")

    monkeypatch.setattr(forest_loss, "run", boom)
    _run_job(lambda: service.restart_loss(9.9, -84.2, 1.0, dt.date(2024, 6, 10)))
    st = service.loss_status(9.9, -84.2, 1.0, dt.date(2024, 6, 10))
    assert st["status"] == "error" and "SECRET" not in st["error"]


def test_previous_loss_result_is_offered_while_a_new_one_runs(isolated):
    old_end = dt.date(2024, 1, 1)
    key = service.loss_key(9.9, -84.2, 1.0, old_end)
    (isolated / f"loss_{key}.json").write_text(json.dumps({"patches": [], "has_overlay": False}))
    st = service.loss_status(9.9, -84.2, 1.0, service.default_loss_end())
    assert st["status"] == "not_started" and st["previous"]["end"] == "2024-01-01"
    # Asking for a past date doesn't mix in other runs.
    assert "previous" not in service.loss_status(9.9, -84.2, 1.0, dt.date(2023, 1, 1))


def test_change_job_lifecycle(monkeypatch):
    from app.screening import change
    _patch_area(monkeypatch)

    async def run(lat, lon, slope, cell_m2, hazard, event, progress):
        mask = np.ones(slope.shape, dtype=bool)
        return {"index": "NBR", "mask": mask, "changed_ha": 1.2}

    monkeypatch.setattr(change, "run", run)
    ev = dt.date(2021, 8, 1)
    _run_job(lambda: service.start_change(9.9, -84.2, 1.0, "wildfire", ev))
    st = service.change_status(9.9, -84.2, 1.0, "wildfire", ev)
    assert st["status"] == "done" and st["changed_ha"] == 1.2 and st["has_overlay"]
    png = rgba(service.change_png_path(9.9, -84.2, 1.0, "wildfire", ev).read_bytes())
    assert tuple(png[0, 0]) == tuple(service.CHANGE_COLORS["NBR"])  # burn-scar colour for NBR
