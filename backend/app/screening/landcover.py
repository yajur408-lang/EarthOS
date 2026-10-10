"""Land cover on the screening grid from ESA WorldCover 10 m 2021 v200 (CC BY 4.0).

Zanaga, D. et al. (2022). ESA WorldCover 10 m 2021 v200. doi:10.5281/zenodo.7254221
Files: 3x3 degree COGs on AWS Open Data, named by their south-west corner.
"""

from __future__ import annotations

import math

import numpy as np

from .. import http
from . import cog

URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"

# WorldCover class code -> EarthOS group (used by the susceptibility weights)
GROUPS = {10: "tree", 20: "shrub", 30: "grass", 40: "crop", 50: "built", 60: "bare", 70: "other",
          80: "water", 90: "wetland", 95: "wetland", 100: "other"}
NAMES = {10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up", 60: "Bare / sparse",
         70: "Snow and ice", 80: "Water", 90: "Herbaceous wetland", 95: "Mangroves", 100: "Moss and lichen"}
SOURCE = {"name": "ESA WorldCover 10 m 2021 v200", "licence": "CC BY 4.0",
          "citation": "Zanaga et al. (2022), doi:10.5281/zenodo.7254221", "url": "https://esa-worldcover.org"}


def _tile(lat: float, lon: float) -> str:
    la = int(math.floor(lat / 3) * 3)
    lo = int(math.floor(lon / 3) * 3)
    return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"


async def landcover(lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    """WorldCover class code at every cell (0 where no data, e.g. open ocean)."""
    out = np.zeros(lat2.shape, dtype=np.uint8)
    tiles = {_tile(a, b) for a, b in zip(lat2.ravel()[:: max(1, lat2.size // 2000)], lon2.ravel()[:: max(1, lat2.size // 2000)])}
    tiles |= {_tile(lat2.min(), lon2.min()), _tile(lat2.max(), lon2.max()),
              _tile(lat2.min(), lon2.max()), _tile(lat2.max(), lon2.min())}
    async with http.client() as client:
        for t in tiles:
            mask = np.vectorize(_tile)(lat2, lon2) == t if len(tiles) > 1 else np.ones(lat2.shape, bool)
            if not mask.any():
                continue
            try:
                f = await cog.open_cog(client, URL.format(tile=t))
            except Exception:  # noqa: BLE001 - ocean tiles don't exist
                continue
            out[mask] = await cog.sample(client, f, lon2[mask], lat2[mask])
    return out
