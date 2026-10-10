"""Terrain on the screening grid: elevation, slope, drainage lines and height above nearest drainage (HAND).

Elevation: Terrain Tiles (Terrarium, mostly SRTM 1 arc-second here) at zoom 13, sampled bilinearly
onto a regular lat/lon grid. Routing: priority-flood (Barnes et al. 2014), which fills pits and gives
every cell a downstream neighbour in one pass; HAND follows those paths to the nearest drainage cell
(Rennó et al. 2008, Nobre et al. 2011).
"""

from __future__ import annotations

import asyncio
import heapq
import math
from dataclasses import dataclass

import numpy as np

from .. import http
from ..sources.terrain import _tile

ZOOM = 13
_N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass
class Grid:
    """Regular lat/lon grid, row 0 = north."""
    lat: np.ndarray  # (rows,) cell-centre latitudes, descending
    lon: np.ndarray  # (cols,)
    step_deg: float

    @property
    def shape(self) -> tuple[int, int]:
        return len(self.lat), len(self.lon)

    @property
    def dx_m(self) -> float:
        return self.step_deg * 111_320 * math.cos(math.radians(float(self.lat.mean())))

    @property
    def dy_m(self) -> float:
        return self.step_deg * 110_574

    def mesh(self) -> tuple[np.ndarray, np.ndarray]:
        return np.meshgrid(self.lon, self.lat)

    def bounds(self) -> dict:
        h = self.step_deg / 2
        return {"west": float(self.lon[0] - h), "east": float(self.lon[-1] + h),
                "south": float(self.lat[-1] - h), "north": float(self.lat[0] + h)}


def make_grid(lat: float, lon: float, half_km: float, arcsec: float) -> Grid:
    step = arcsec / 3600
    dlat = half_km / 110.574
    dlon = half_km / (111.320 * math.cos(math.radians(lat)))
    n_lat = int(round(2 * dlat / step))
    n_lon = int(round(2 * dlon / step))
    lats = lat + dlat - step * (np.arange(n_lat) + 0.5)
    lons = lon - dlon + step * (np.arange(n_lon) + 0.5)
    return Grid(lats, lons, step)


async def elevation(grid: Grid) -> np.ndarray:
    """Bilinear elevation (m) at every grid cell."""
    lon2, lat2 = grid.mesh()
    n = 2 ** ZOOM
    fx, fy = _vec_tile_xy(lat2, lon2, ZOOM)
    px, py = fx * 256 - 0.5, fy * 256 - 0.5
    tx0, tx1 = int(np.floor(px.min() / 256)), int(np.floor((px.max() + 1) / 256))
    ty0, ty1 = int(np.floor(py.min() / 256)), int(np.floor((py.max() + 1) / 256))
    async with http.client() as client:
        rows = []
        for ty in range(ty0, ty1 + 1):
            rows.append(np.hstack([await _tile(client, ZOOM, tx % n, min(max(ty, 0), n - 1))
                                   for tx in range(tx0, tx1 + 1)]))
    mosaic = np.vstack(rows)
    x, y = px - tx0 * 256, py - ty0 * 256
    x0 = np.clip(np.floor(x).astype(int), 0, mosaic.shape[1] - 2)
    y0 = np.clip(np.floor(y).astype(int), 0, mosaic.shape[0] - 2)
    wx, wy = np.clip(x - x0, 0, 1), np.clip(y - y0, 0, 1)
    top = mosaic[y0, x0] * (1 - wx) + mosaic[y0, x0 + 1] * wx
    bot = mosaic[y0 + 1, x0] * (1 - wx) + mosaic[y0 + 1, x0 + 1] * wx
    return top * (1 - wy) + bot * wy


def _vec_tile_xy(lat: np.ndarray, lon: np.ndarray, z: int) -> tuple[np.ndarray, np.ndarray]:
    n = 2 ** z
    x = (lon + 180) / 360 * n
    lat_r = np.radians(np.clip(lat, -85.0511, 85.0511))
    y = (1 - np.arcsinh(np.tan(lat_r)) / math.pi) / 2 * n
    return x, y


def slope_deg(dem: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """Horn (1981) slope in degrees."""
    p = np.pad(dem, 1, mode="edge")
    a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
    d, f = p[1:-1, :-2], p[1:-1, 2:]
    g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * dy)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def route(dem: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Priority-flood from the edges. Returns (downstream index per cell, -1 at outlets; processing order).

    Cells are popped lowest-first, so every cell's downstream neighbour is popped before it: the order is a
    valid upstream traversal for accumulation (reversed) and for HAND (forward).
    """
    rows, cols = dem.shape
    flat = dem.ravel()
    down = np.full(rows * cols, -1, dtype=np.int64)
    seen = np.zeros(rows * cols, dtype=bool)
    order = np.empty(rows * cols, dtype=np.int64)
    heap: list[tuple[float, int, int]] = []
    counter = 0
    for r in range(rows):
        for c in (0, cols - 1):
            i = r * cols + c
            if not seen[i]:
                seen[i] = True
                heap.append((flat[i], counter, i))
                counter += 1
    for c in range(1, cols - 1):
        for r in (0, rows - 1):
            i = r * cols + c
            if not seen[i]:
                seen[i] = True
                heap.append((flat[i], counter, i))
                counter += 1
    heapq.heapify(heap)
    filled = flat.astype(float).copy()
    k = 0
    push, pop = heapq.heappush, heapq.heappop
    while heap:
        z, _, i = pop(heap)
        order[k] = i
        k += 1
        r, c = divmod(i, cols)
        for dr, dc in _N8:
            rr, cc = r + dr, c + dc
            if 0 <= rr < rows and 0 <= cc < cols:
                j = rr * cols + cc
                if not seen[j]:
                    seen[j] = True
                    down[j] = i
                    # Raise pits to the spill level (plus a tiny step so flats drain in order).
                    zj = filled[j]
                    if zj <= z:
                        zj = z + 1e-4
                        filled[j] = zj
                    counter += 1
                    push(heap, (zj, counter, j))
    return down, order


def accumulation(down: np.ndarray, order: np.ndarray) -> np.ndarray:
    acc = np.ones(len(down))
    for i in order[::-1]:
        d = down[i]
        if d >= 0:
            acc[d] += acc[i]
    return acc


def hand(dem: np.ndarray, down: np.ndarray, order: np.ndarray, stream: np.ndarray) -> np.ndarray:
    """Height above the drainage cell reached by flowing downhill (m); NaN where flow leaves the grid first."""
    flat = dem.ravel()
    ref = np.empty(len(flat))
    s = stream.ravel()
    for i in order:
        d = down[i]
        # Cells that leave the grid before meeting a drainage line have no known reference: NaN.
        ref[i] = flat[i] if s[i] else (np.nan if d < 0 else ref[d])
    return np.maximum(flat - ref, 0).reshape(dem.shape)


async def terrain_layers(grid: Grid, stream_area_km2: float) -> dict:
    dem = await elevation(grid)
    return await asyncio.to_thread(_derive, dem, grid.dx_m, grid.dy_m, stream_area_km2)


def _derive(dem: np.ndarray, dx: float, dy: float, stream_area_km2: float) -> dict:
    slope = slope_deg(dem, dx, dy)
    down, order = route(dem)
    acc_cells = accumulation(down, order)
    cell_km2 = dx * dy / 1e6
    stream = (acc_cells * cell_km2 >= stream_area_km2).reshape(dem.shape)
    return {
        "dem": dem,
        "slope": slope,
        "stream": stream,
        "hand": hand(dem, down, order, stream),
        "upstream_km2": (acc_cells * cell_km2).reshape(dem.shape),
    }
