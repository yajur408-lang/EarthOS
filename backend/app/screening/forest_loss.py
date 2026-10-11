"""Slope forest-loss watch: possible vegetation loss on steep ground from 30 m HLS NDVI.

For every grid cell: the median of clear NDVI observations in the recent window (default: the 90 days up to the
chosen date) is compared with the median of clear observations in the same calendar window of prior years.
A cell is flagged when NDVI fell by at least `ndvi_drop` AND by at least |robust_z| robust sigmas, on a slope
steeper than `min_slope_deg`. Flagged cells are grouped into 8-connected patches; patches smaller than
`min_patch_ha` are dropped. Every result is labelled "Possible vegetation loss, cause unconfirmed."

Data: HLS Vegetation Indices v2.0 (HLSL30_VI Landsat 8/9, HLSS30_VI Sentinel-2) NDVI, masked with the HLS
Fmask band. Found through NASA CMR; read from LP DAAC with an Earthdata token.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import math
from collections import deque

import numpy as np

from .. import config, http
from . import cog, utm
from .settings import LOSS

CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
PRODUCTS = ("HLSL30_VI", "HLSS30_VI")
LABEL = "Possible vegetation loss, cause unconfirmed."
SOURCE = {
    "name": "HLS Vegetation Indices v2.0 (HLSL30_VI, HLSS30_VI), 30 m",
    "citation": "doi:10.5067/HLS/HLSL30_VI.002 · doi:10.5067/HLS/HLSS30_VI.002 · Contains modified Copernicus Sentinel data",
    "licence": "NASA open data; Sentinel-2 part also under Copernicus terms (free, attribution)",
    "url": "https://www.earthdata.nasa.gov/data/projects/hls",
}
FILL_I16 = -19999


class NeedsToken(RuntimeError):
    pass


async def _granules(client, bbox: tuple[float, float, float, float], start: dt.date, end: dt.date) -> list[dict]:
    out = []
    for product in PRODUCTS:
        page = 1
        while True:
            r = await client.get(CMR, params={
                "short_name": product, "version": "2.0",
                "bounding_box": ",".join(f"{v:.5f}" for v in bbox),
                "temporal": f"{start.isoformat()}T00:00:00Z,{end.isoformat()}T23:59:59Z",
                "page_size": 200, "page_num": page,
            }, timeout=60)
            r.raise_for_status()
            items = r.json().get("items", [])
            for it in items:
                u = it["umm"]
                attrs = {a["Name"]: a["Values"][0] for a in u.get("AdditionalAttributes", [])}
                cloud = float(attrs.get("CLOUD_COVERAGE", 100))
                if cloud > LOSS["max_scene_cloud_pct"]:
                    continue
                urls = [x["URL"] for x in u.get("RelatedUrls", []) if x.get("Type", "").startswith("GET DATA")
                        and x["URL"].startswith("https://")]
                vi = {k: next((x for x in urls if x.endswith(f".{k}.tif")), None) for k in ("NDVI", "NBR", "NDWI")}
                ndvi = vi["NDVI"]
                fmask = next((x for x in urls if x.endswith(".Fmask.tif")), None)
                if not ndvi or not fmask:
                    continue
                date = u["TemporalExtent"]["RangeDateTime"]["BeginningDateTime"][:10]
                out.append({"id": u["GranuleUR"], "date": date, "cloud": cloud, "ndvi": ndvi, "vi": vi, "fmask": fmask,
                            "tile": attrs.get("MGRS_TILE_ID"), "sensor": "S30" if product.startswith("HLSS") else "L30"})
            if len(items) < 200:
                break
            page += 1
    return out


def _windows(end: dt.date) -> tuple[tuple[dt.date, dt.date], list[tuple[int, dt.date, dt.date]]]:
    recent = (end - dt.timedelta(days=LOSS["recent_days"]), end)
    pad = dt.timedelta(days=LOSS["baseline_pad_days"])
    base = []
    for k in range(1, LOSS["baseline_years"] + 1):
        try:
            a = recent[0].replace(year=recent[0].year - k)
            b = recent[1].replace(year=recent[1].year - k)
        except ValueError:  # 29 Feb
            a = recent[0].replace(year=recent[0].year - k, day=28)
            b = recent[1].replace(year=recent[1].year - k, day=28)
        if b.year >= 2013:
            base.append((recent[1].year - k, a - pad, b + pad))
    return recent, base


async def _read_granule(client, g: dict, lat2: np.ndarray, lon2: np.ndarray, headers: dict,
                        reject_mask: int, index: str = "NDVI") -> np.ndarray | None:
    """Clear values of a vegetation/water index on the grid (NaN where cloudy, outside the tile, or fill)."""
    url = (g.get("vi") or {}).get(index) or (g["ndvi"] if index == "NDVI" else None)
    if not url:
        return None
    n = await cog.open_cog(client, url, headers)
    zone, north = utm.from_epsg(n.epsg) if n.epsg else _zone_from_tile(g.get("tile"))
    x, y = utm.forward(lat2, lon2, zone, north)
    fc, fr = n.pixel(x, y)
    inside = (fc >= 0) & (fr >= 0) & (fc < n.width) & (fr < n.height)
    if not inside.any():
        return None
    f = await cog.open_cog(client, g["fmask"], headers)
    xi, yi = x[inside], y[inside]
    nd = (await cog.sample(client, n, xi, yi)).astype(float)
    fm = (await cog.sample(client, f, xi, yi)).astype(np.int64)
    scale, offset = n.scale_offset()
    if n.dtype.kind in "iu":
        if scale == 1.0:
            scale = 1e-4  # HLS VI stores NDVI x 10000
        bad = (nd == (n.nodata if n.nodata is not None else FILL_I16))
    else:
        bad = ~np.isfinite(nd) | ((nd == n.nodata) if n.nodata is not None else False)
    nd = nd * scale + offset
    bad |= (fm & reject_mask) != 0
    bad |= fm == 255
    bad |= (nd < -1) | (nd > 1)
    out = np.full(lat2.shape, np.nan, dtype=np.float32)
    vals = np.where(bad, np.nan, nd).astype(np.float32)
    out[inside] = vals
    return out


# ---- memory-light stacks (the free host has 512 MB): int16 x 10000, NaN as -32768, statistics in row chunks

NODATA16 = -32768
MAX_SCENES_PER_YEAR = 15  # clearest baseline scenes kept per year


def pack(arr: np.ndarray) -> np.ndarray:
    out = np.full(arr.shape, NODATA16, dtype=np.int16)
    ok = np.isfinite(arr)
    out[ok] = np.clip(np.round(arr[ok] * 10000), -10000, 10000).astype(np.int16)
    return out


def stack_stats(stack: list[np.ndarray], mad: bool = False, rows: int = 32):
    """Per-pixel (median, MAD or None, count of clear values) without building a full float copy."""
    h, w = stack[0].shape
    med = np.full((h, w), np.nan, dtype=np.float32)
    dev = np.full((h, w), np.nan, dtype=np.float32) if mad else None
    count = np.zeros((h, w), dtype=np.int16)
    import warnings
    for r in range(0, h, rows):
        sub = np.stack([s[r:r + rows] for s in stack]).astype(np.float32)
        sub[sub == NODATA16] = np.nan
        sub /= 10000
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            m = np.nanmedian(sub, 0)
            med[r:r + rows] = m
            if mad:
                dev[r:r + rows] = np.nanmedian(np.abs(sub - m), 0)
        count[r:r + rows] = np.isfinite(sub).sum(0)
    return med, dev, count


def cap_per_year(granules: list[dict]) -> list[dict]:
    by_year: dict[int, list[dict]] = {}
    for g in granules:
        by_year.setdefault(g.get("year", 0), []).append(g)
    out = []
    for gs in by_year.values():
        out += sorted(gs, key=lambda g: g["cloud"])[:MAX_SCENES_PER_YEAR]
    return out


def _zone_from_tile(tile: str | None) -> tuple[int, bool]:
    """UTM zone from an MGRS tile id such as '16PGR' (some HLS files omit the EPSG geokey)."""
    if not tile or len(tile) < 3 or not tile[:2].isdigit():
        raise cog.CogError("no projection in the file and no MGRS tile id")
    return int(tile[:2]), tile[2].upper() >= "N"


def _patches(mask: np.ndarray, min_cells: int) -> list[list[tuple[int, int]]]:
    rows, cols = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for r0, c0 in zip(*np.nonzero(mask)):
        if seen[r0, c0]:
            continue
        q = deque([(r0, c0)])
        seen[r0, c0] = True
        cells = []
        while q:
            r, c = q.popleft()
            cells.append((r, c))
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < rows and 0 <= cc < cols and mask[rr, cc] and not seen[rr, cc]:
                        seen[rr, cc] = True
                        q.append((rr, cc))
        if len(cells) >= min_cells:
            out.append(cells)
    return out


async def run(grid_lat: np.ndarray, grid_lon: np.ndarray, slope: np.ndarray, cell_m2: float, end: dt.date,
              progress=None) -> dict:
    if not config.EARTHDATA_TOKEN:
        raise NeedsToken("Set EARTHDATA_TOKEN on the server to enable the 30 m forest-loss watch.")
    lon2, lat2 = np.meshgrid(grid_lon, grid_lat)
    bbox = (float(grid_lon.min()), float(grid_lat.min()), float(grid_lon.max()), float(grid_lat.max()))
    recent, base = _windows(end)
    reject = sum(1 << b for b in LOSS["fmask_reject_bits"])
    headers = {"Authorization": f"Bearer {config.EARTHDATA_TOKEN}"}
    async with http.client() as client:
        recent_g = await _granules(client, bbox, *recent)
        base_g = []
        for year, a, b in base:
            for g in await _granules(client, bbox, a, b):
                base_g.append({**g, "year": year})
        base_g = cap_per_year(base_g)
        jobs = [("recent", g) for g in recent_g] + [("base", g) for g in base_g]
        sem = asyncio.Semaphore(4)
        done = 0

        async def one(kind, g):
            nonlocal done
            async with sem:
                try:
                    arr = await _read_granule(client, g, lat2, lon2, headers, reject)
                    arr = None if arr is None else pack(arr)
                except Exception as e:  # noqa: BLE001 - one bad file shouldn't sink the run
                    arr, g["error"] = None, str(e)[:200]
            done += 1
            if progress:
                progress(done / max(len(jobs), 1))
            return kind, g, arr

        results = await asyncio.gather(*(one(k, g) for k, g in jobs))

    stacks: dict[str, list[np.ndarray]] = {"recent": [], "base": []}
    used: dict[str, list[dict]] = {"recent": [], "base": []}
    for kind, g, arr in results:
        if arr is None or not (arr != NODATA16).any():
            continue
        stacks[kind].append(arr)
        used[kind].append({"date": g["date"], "sensor": g["sensor"], "tile": g["tile"], "cloud_pct": g["cloud"],
                           **({"year": g["year"]} if "year" in g else {})})
    diag = _diagnostics(results, len(recent_g), len(base_g))
    if not stacks["recent"] or not stacks["base"]:
        return {**_empty(recent, base, used, "Not enough clear HLS scenes in the recent or baseline windows."), "diagnostics": diag}

    rec_med, _, n_rec = stack_stats(stacks["recent"])
    bas_med, mad, n_bas = stack_stats(stacks["base"], mad=True)
    stacks.clear()
    sigma = np.maximum(1.4826 * np.nan_to_num(mad), 0.03)
    diff = rec_med - bas_med
    z = diff / sigma
    judged = (n_rec >= LOSS["min_recent_obs"]) & (n_bas >= LOSS["min_baseline_obs"])
    steep = slope >= LOSS["min_slope_deg"]
    flag = judged & steep & (diff <= -LOSS["ndvi_drop"]) & (z <= LOSS["robust_z"])
    min_cells = math.ceil(LOSS["min_patch_ha"] * 10_000 / cell_m2)
    patches = []
    keep = np.zeros(flag.shape, dtype=bool)
    for k, cells in enumerate(sorted(_patches(flag, min_cells), key=len, reverse=True)):
        rr = np.array([c[0] for c in cells])
        cc = np.array([c[1] for c in cells])
        keep[rr, cc] = True
        patches.append({
            "id": k + 1,
            "label": LABEL,
            "lat": round(float(grid_lat[rr].mean()), 5),
            "lon": round(float(grid_lon[cc].mean()), 5),
            "area_ha": round(len(cells) * cell_m2 / 10_000, 2),
            "pixels": len(cells),
            "mean_slope_deg": round(float(slope[rr, cc].mean()), 1),
            "ndvi_baseline": round(float(np.nanmean(bas_med[rr, cc])), 3),
            "ndvi_recent": round(float(np.nanmean(rec_med[rr, cc])), 3),
            "ndvi_change": round(float(np.nanmean(diff[rr, cc])), 3),
            "robust_z": round(float(np.nanmedian(z[rr, cc])), 1),
        })
    base_years = sorted({u["year"] for u in used["base"]})
    return {
        "label": LABEL,
        "patches": patches,
        "mask": keep,
        "judged_share": round(float(judged.mean()), 3),
        "judged_steep_share": round(float((judged & steep).sum()) / max(int(steep.sum()), 1), 3),
        "recent_window": [recent[0].isoformat(), recent[1].isoformat()],
        "baseline_windows": [[y, a.isoformat(), b.isoformat()] for y, a, b in base],
        "baseline_years_used": base_years,
        "n_baseline_years": len(base_years),
        "scenes": {"recent": len(used["recent"]), "baseline": len(used["base"]),
                   "skipped": sum(1 for _, g, a in results if a is None)},
        "qa": _qa_text(),
        "diagnostics": diag,
        "thresholds": {k: LOSS[k] for k in ("min_patch_ha", "min_slope_deg", "ndvi_drop", "robust_z",
                                             "min_baseline_obs", "min_recent_obs", "max_scene_cloud_pct")},
        "source": SOURCE,
    }


def _diagnostics(results, n_recent: int, n_base: int) -> dict:
    """Counts and a few sample errors (URL query strings removed: signed links carry temporary credentials)."""
    import re
    errors = [re.sub(r"\?[^\s']*", "?…", g["error"]) for _, g, a in results if a is None and g.get("error")]
    empty = sum(1 for _, g, a in results if a is not None and not (a != NODATA16).any())
    return {"granules_found": {"recent": n_recent, "baseline": n_base}, "read_errors": len(errors),
            "all_cloud_or_outside": empty, "sample_errors": sorted(set(errors))[:3]}


def _qa_text() -> str:
    names = {1: "cloud", 2: "adjacent to cloud/shadow", 3: "cloud shadow", 4: "snow/ice", 5: "water"}
    return ("HLS Fmask: pixels flagged " + ", ".join(names[b] for b in LOSS["fmask_reject_bits"] if b in names)
            + f" are removed; scenes with more than {LOSS['max_scene_cloud_pct']}% tile cloud are skipped.")


def _empty(recent, base, used, note: str) -> dict:
    return {"label": LABEL, "patches": [], "mask": None, "note": note,
            "recent_window": [recent[0].isoformat(), recent[1].isoformat()],
            "baseline_windows": [[y, a.isoformat(), b.isoformat()] for y, a, b in base],
            "baseline_years_used": sorted({u["year"] for u in used["base"]}),
            "n_baseline_years": len({u["year"] for u in used["base"]}),
            "scenes": {"recent": len(used["recent"]), "baseline": len(used["base"])},
            "qa": _qa_text(), "source": SOURCE}
