"""WGS84 lat/lon -> UTM (forward transverse Mercator, Krüger series; sub-millimetre within a zone)."""

from __future__ import annotations

import numpy as np

_A = 6378137.0
_F = 1 / 298.257223563
_K0 = 0.9996
_N = _F / (2 - _F)
_AA = _A / (1 + _N) * (1 + _N ** 2 / 4 + _N ** 4 / 64)
_ALPHA = [_N / 2 - 2 * _N ** 2 / 3 + 5 * _N ** 3 / 16,
          13 * _N ** 2 / 48 - 3 * _N ** 3 / 5,
          61 * _N ** 3 / 240]


def from_epsg(epsg: int) -> tuple[int, bool]:
    """EPSG 326zz / 327zz -> (zone, north)."""
    if 32601 <= epsg <= 32660:
        return epsg - 32600, True
    if 32701 <= epsg <= 32760:
        return epsg - 32700, False
    raise ValueError(f"not a WGS84 UTM EPSG code: {epsg}")


def forward(lat: np.ndarray, lon: np.ndarray, zone: int, north: bool = True) -> tuple[np.ndarray, np.ndarray]:
    lon0 = np.radians(zone * 6 - 183)
    phi = np.radians(lat)
    lam = np.radians(lon) - lon0
    e = np.sqrt(_F * (2 - _F))
    t = np.sinh(np.arctanh(np.sin(phi)) - e * np.arctanh(e * np.sin(phi)))
    xi_p = np.arctan2(t, np.cos(lam))
    eta_p = np.arctanh(np.sin(lam) / np.sqrt(1 + t ** 2))
    xi, eta = xi_p.copy(), eta_p.copy()
    for j, a in enumerate(_ALPHA, start=1):
        xi += a * np.sin(2 * j * xi_p) * np.cosh(2 * j * eta_p)
        eta += a * np.cos(2 * j * xi_p) * np.sinh(2 * j * eta_p)
    x = 500000 + _K0 * _AA * eta
    y = _K0 * _AA * xi + (0 if north else 10_000_000)
    return x, y
