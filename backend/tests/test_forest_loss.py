"""Forest-loss watch end to end with NASA faked: scene search, per-scene reads, flagging rules and patch output."""

import asyncio
import datetime as dt
from contextlib import asynccontextmanager

import numpy as np
import pytest

from app import config
from app.screening import forest_loss as F

N = 20
CELL_M2 = 900.0  # 30 m cells: 0.5 ha needs 6 cells


class FakeResponse:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


def granule(gid, date, cloud, ndvi=True, fmask=True):
    urls = []
    if ndvi:
        urls.append({"Type": "GET DATA", "URL": f"https://data.nasa/{gid}.v2.0.NDVI.tif"})
        urls.append({"Type": "GET DATA", "URL": f"https://data.nasa/{gid}.v2.0.NBR.tif"})
    if fmask:
        urls.append({"Type": "GET DATA", "URL": f"https://data.nasa/{gid}.v2.0.Fmask.tif"})
    urls.append({"Type": "GET DATA VIA DIRECT ACCESS", "URL": f"s3://bucket/{gid}.NDVI.tif"})  # not https: ignored
    return {"umm": {"GranuleUR": gid, "TemporalExtent": {"RangeDateTime": {"BeginningDateTime": f"{date}T15:00:00Z"}},
                    "AdditionalAttributes": [{"Name": "CLOUD_COVERAGE", "Values": [str(cloud)]},
                                             {"Name": "MGRS_TILE_ID", "Values": ["16PGR"]}],
                    "RelatedUrls": urls}}


def test_granule_search_filters_and_pages():
    pages = {
        ("HLSL30_VI", 1): [granule(f"L{i}", "2024-05-01", 10) for i in range(200)],
        ("HLSL30_VI", 2): [granule("L-cloudy", "2024-05-02", 95), granule("L-nofmask", "2024-05-03", 5, fmask=False),
                           granule("L-last", "2024-05-04", 20)],
        ("HLSS30_VI", 1): [granule("S1", "2024-05-05", 30)],
    }

    class Client:
        async def get(self, url, params, timeout):
            assert url == F.CMR and params["temporal"].startswith("2024-04-01T00:00:00Z")
            return FakeResponse({"items": pages.get((params["short_name"], params["page_num"]), [])})

    out = asyncio.run(F._granules(Client(), (-84.3, 9.8, -84.1, 10.0), dt.date(2024, 4, 1), dt.date(2024, 6, 30)))
    ids = [g["id"] for g in out]
    assert len(ids) == 202 and "L-last" in ids and "S1" in ids  # second page read
    assert "L-cloudy" not in ids and "L-nofmask" not in ids  # too cloudy; no quality mask
    s1 = next(g for g in out if g["id"] == "S1")
    assert s1["sensor"] == "S30" and s1["tile"] == "16PGR" and s1["vi"]["NBR"].endswith(".NBR.tif") and s1["vi"]["NDWI"] is None


@asynccontextmanager
async def fake_http_client():
    yield object()


def setup_run(monkeypatch, recent_scenes, base_scenes, read):
    monkeypatch.setattr(config, "EARTHDATA_TOKEN", "test-token")
    monkeypatch.setattr(F.http, "client", fake_http_client)

    async def granules(client, bbox, start, end):
        recent = (end - start).days <= F.LOSS["recent_days"]
        src = recent_scenes if recent else base_scenes
        return [{**g, "date": start.isoformat()} for g in src]

    monkeypatch.setattr(F, "_granules", granules)
    monkeypatch.setattr(F, "_read_granule", read)


def scenes(prefix, n):
    return [{"id": f"{prefix}{i}", "cloud": 10 + i, "ndvi": "u", "fmask": "f", "tile": "16PGR", "sensor": "L30"} for i in range(n)]


def grid():
    lat = 9.9 - np.arange(N) * 0.00027
    lon = -84.2 + np.arange(N) * 0.00027
    slope = np.full((N, N), 30.0)
    slope[:, N // 2:] = 5.0  # east half flat
    return lat, lon, slope


def run(lat, lon, slope, progress=None):
    return asyncio.run(F.run(lat, lon, slope, CELL_M2, dt.date(2024, 6, 30), progress))


def test_loss_is_flagged_only_on_steep_ground_in_big_enough_patches(monkeypatch):
    rng = np.random.default_rng(0)

    async def read(client, g, lat2, lon2, headers, reject):
        if g["id"].startswith("bad"):
            raise OSError("https://data.nasa/x.tif?X-Amz-Signature=SECRET 403")
        if g["id"].startswith("cloud"):
            return np.full(lat2.shape, np.nan, dtype=np.float32)
        a = (0.8 + rng.normal(0, 0.01, lat2.shape)).astype(np.float32)
        if g["id"].startswith("r"):
            a[2:6, 2:6] = 0.3      # 16 cells (1.44 ha) of loss on the steep west half
            a[2:6, 14:18] = 0.3    # same drop on flat ground: not reported
            a[12, 2] = 0.3         # a single steep cell: below the 0.5 ha minimum
        return a

    setup_run(monkeypatch, scenes("r", 3) + [{**scenes("cloud", 1)[0]}], scenes("b", 6) + [{**scenes("bad", 1)[0]}], read)
    seen = []
    lat, lon, slope = grid()
    res = run(lat, lon, slope, seen.append)
    assert seen and seen[-1] == 1.0
    assert [p["pixels"] for p in res["patches"]] == [16]
    p = res["patches"][0]
    assert p["area_ha"] == 1.44 and p["mean_slope_deg"] == 30.0 and p["ndvi_change"] < -0.4
    assert p["label"] == "Possible vegetation loss, cause unconfirmed."
    assert res["mask"].sum() == 16 and not res["mask"][:, N // 2:].any()
    # Five baseline years requested, each returning the same six good scenes (the bad one fails to read).
    assert res["scenes"]["recent"] == 3 and res["scenes"]["baseline"] == 30 and res["scenes"]["skipped"] == 5
    d = res["diagnostics"]
    assert d["read_errors"] == 5 and d["all_cloud_or_outside"] == 1
    assert all("SECRET" not in e for e in d["sample_errors"])
    assert res["judged_steep_share"] == 1.0 and res["thresholds"]["min_patch_ha"] == 0.5


def test_no_recent_scenes_gives_an_explained_empty_result(monkeypatch):
    async def read(client, g, lat2, lon2, headers, reject):
        return np.full(lat2.shape, 0.8, dtype=np.float32)

    setup_run(monkeypatch, [], scenes("b", 4), read)
    lat, lon, slope = grid()
    res = run(lat, lon, slope)
    assert res["patches"] == [] and res["mask"] is None and "Not enough clear HLS scenes" in res["note"]
    assert res["diagnostics"]["granules_found"]["recent"] == 0


def test_without_a_token_the_watch_says_so(monkeypatch):
    monkeypatch.setattr(config, "EARTHDATA_TOKEN", "")
    lat, lon, slope = grid()
    with pytest.raises(F.NeedsToken):
        run(lat, lon, slope)


def test_scene_cap_keeps_the_clearest_per_year():
    gs = [{"year": 2020, "cloud": c} for c in range(30)] + [{"year": 2021, "cloud": 5}]
    out = F.cap_per_year(gs)
    assert len(out) == F.MAX_SCENES_PER_YEAR + 1
    assert max(g["cloud"] for g in out if g["year"] == 2020) == F.MAX_SCENES_PER_YEAR - 1


def test_pack_and_stats_round_trip():
    a = np.array([[0.5, np.nan], [-0.25, 1.5]], dtype=np.float32)
    p = F.pack(a)
    assert p.dtype == np.int16 and p[0, 1] == F.NODATA16 and p[1, 1] == 10000  # clipped to 1.0
    med, mad, count = F.stack_stats([p, F.pack(a + 0.1)], mad=True, rows=1)
    assert np.isclose(med[0, 0], 0.55) and np.isnan(med[0, 1]) and count[0, 1] == 0 and np.isclose(mad[0, 0], 0.05)


def test_read_granule_scales_and_masks(monkeypatch):
    """HLS VI files store NDVI x 10000 as int16 with -19999 fill; Fmask bits and 255 (no data) remove pixels."""

    class Img:
        def __init__(self, values, dtype):
            self.values = np.asarray(values)
            self.dtype = np.dtype(dtype)
            self.epsg = 32616
            self.width = self.height = 10
            self.nodata = None

        def pixel(self, x, y):
            n = x.size
            cols = np.arange(n).reshape(x.shape).astype(float)
            cols.flat[-1] = -5  # last grid cell falls outside the tile
            return cols, np.zeros(x.shape)

        def scale_offset(self):
            return 1.0, 0.0

    ndvi = Img([5000, -19999, 7000, 3000, 9999], "int16")
    fmask = Img([0, 0, 1 << 1, 255, 1 << 6], "uint8")  # clear, clear, cloud, no data, aerosol bit (kept)

    async def open_cog(client, url, headers):
        return fmask if url.endswith("Fmask.tif") else ndvi

    async def sample(client, img, x, y):
        return img.values[: x.size]

    monkeypatch.setattr(F.cog, "open_cog", open_cog)
    monkeypatch.setattr(F.cog, "sample", sample)
    lat2 = np.full((2, 3), 9.9)
    lon2 = np.full((2, 3), -84.2)
    reject = sum(1 << b for b in F.LOSS["fmask_reject_bits"])
    g = {"ndvi": "https://x/a.NDVI.tif", "fmask": "https://x/a.Fmask.tif", "vi": {"NDVI": "https://x/a.NDVI.tif"}}
    out = asyncio.run(F._read_granule(None, g, lat2, lon2, {}, reject)).ravel()
    assert np.isclose(out[0], 0.5)          # scaled from x10000
    assert np.isnan(out[1])                 # fill value
    assert np.isnan(out[2])                 # cloud bit
    assert np.isnan(out[3])                 # Fmask 255 = no data
    assert np.isclose(out[4], 0.9999)       # bit 6 (aerosol) isn't a reject bit
    assert np.isnan(out[5])                 # outside the tile
    # A missing index (no NDWI file for this scene) gives None rather than an empty array.
    assert asyncio.run(F._read_granule(None, g, lat2, lon2, {}, reject, index="NDWI")) is None
