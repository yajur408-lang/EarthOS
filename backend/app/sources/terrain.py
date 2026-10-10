"""Elevation, slope and aspect from the Terrain Tiles open dataset (Terrarium PNG encoding).

Tiles: https://registry.opendata.aws/terrain-tiles/ - attribution:
https://github.com/tilezen/joerd/blob/master/docs/attribution.md
"""

from __future__ import annotations

import io
import math

import httpx
from .. import http
import numpy as np
from PIL import Image

from ..cache import CACHE_DIR

URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"
ZOOM = 12  # ~38 m pixels at the equator


def _tile_xy(lat: float, lon: float, z: int) -> tuple[float, float]:
    n = 2 ** z
    x = (lon + 180) / 360 * n
    lat_r = math.radians(max(min(lat, 85.0511), -85.0511))
    y = (1 - math.asinh(math.tan(lat_r)) / math.pi) / 2 * n
    return x, y


async def _tile(client: httpx.AsyncClient, z: int, x: int, y: int) -> np.ndarray:
    path = CACHE_DIR / "terrain" / f"{z}_{x}_{y}.png"
    if path.exists():
        data = path.read_bytes()
    else:
        r = await client.get(URL.format(z=z, x=x, y=y), timeout=30)
        r.raise_for_status()
        data = r.content
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    rgb = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=float)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


async def terrain(lat: float, lon: float, km: float) -> dict:
    """Elevation at the point, statistics over the box, and slope/aspect at the point."""
    n = 2 ** ZOOM
    fx, fy = _tile_xy(lat, lon, ZOOM)
    tx, ty = int(fx) % n, int(fy)
    async with http.client() as client:
        # 3x3 tiles so the box and the slope window never fall off an edge.
        rows = []
        for dy in (-1, 0, 1):
            row = [await _tile(client, ZOOM, (tx + dx) % n, min(max(ty + dy, 0), n - 1)) for dx in (-1, 0, 1)]
            rows.append(np.hstack(row))
    grid = np.vstack(rows)
    px = int((fx - tx + 1) * 256)
    py = int((fy - ty + 1) * 256)
    # Ground size of one pixel in metres (Web Mercator scale at this latitude).
    cell = 40075016.686 * math.cos(math.radians(lat)) / (n * 256)

    elev = float(grid[py, px])
    w = grid[py - 1:py + 2, px - 1:px + 2]
    # Horn's method for slope and aspect.
    dzdx = ((w[0, 2] + 2 * w[1, 2] + w[2, 2]) - (w[0, 0] + 2 * w[1, 0] + w[2, 0])) / (8 * cell)
    dzdy = ((w[2, 0] + 2 * w[2, 1] + w[2, 2]) - (w[0, 0] + 2 * w[0, 1] + w[0, 2])) / (8 * cell)
    slope = math.degrees(math.atan(math.hypot(dzdx, dzdy)))
    aspect = (math.degrees(math.atan2(-dzdx, dzdy)) + 360) % 360 if slope > 0.5 else None  # direction slope faces

    r = max(1, int(max(km, 0.15) * 1000 / cell))
    box = grid[max(py - r, 0):py + r + 1, max(px - r, 0):px + r + 1]

    # East-west profile through the point (for a terrain cross-section chart).
    span = max(r, int(2000 / cell))
    xs = np.arange(max(px - span, 0), min(px + span + 1, grid.shape[1]))
    profile = [{"distance_m": round(float((x - px) * cell), 1), "elevation_m": round(float(grid[py, x]), 1)} for x in xs]

    return {
        "elevation_m": round(elev, 1),
        "box": {"min_m": round(float(box.min()), 1), "max_m": round(float(box.max()), 1),
                "mean_m": round(float(box.mean()), 1), "relief_m": round(float(box.max() - box.min()), 1)},
        "slope_deg": round(slope, 1),
        "aspect_deg": None if aspect is None else round(aspect, 0),
        "pixel_m": round(cell, 1),
        "profile": profile,
        "note": "Elevation below 0 m at sea points is ocean bathymetry (ETOPO1).",
    }
