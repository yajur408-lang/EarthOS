"""Server-side settings. Secrets live only here (read from backend/.env or the host's
environment) and are never sent to the browser - the frontend talks to this API instead
of calling keyed services directly."""

from __future__ import annotations

import os
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
_ENV = _BACKEND / ".env"
if _ENV.exists():
    for line in _ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

# Optional keys for upcoming integrations; the MVP runs without any of them.
MAPILLARY_TOKEN = os.environ.get("MAPILLARY_TOKEN")  # https://www.mapillary.com/dashboard/developers
FIRMS_MAP_KEY = os.environ.get("FIRMS_MAP_KEY")  # https://firms.modaps.eosdis.nasa.gov/api/map_key/
EARTHDATA_TOKEN = os.environ.get("EARTHDATA_TOKEN")  # for HLS downloads via LP DAAC
# Geocoding. Set NOMINATIM_CONTACT (an email or URL) so OSM operators can reach you, as their policy asks.
NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org").rstrip("/")
_CONTACT = os.environ.get("NOMINATIM_CONTACT", "").strip()
USER_AGENT = f"EarthOS/0.3 ({_CONTACT})" if _CONTACT else "EarthOS/0.3 (environmental data viewer)"
ALLOWED_ORIGINS = [o for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o]

# Deployment
CACHE_DIR = Path(os.environ.get("CACHE_DIR", _BACKEND / "data" / "cache"))
# Built frontend to serve from the same origin (one service, one URL). Ignored if missing.
FRONTEND_DIST = Path(os.environ.get("FRONTEND_DIST", _BACKEND.parent / "frontend" / "dist"))
RATE_LIMIT_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "240"))
# Example places whose satellite record is downloaded in the background at startup, so they open instantly.
PREWARM_PLACES = [p for p in os.environ.get("PREWARM_PLACES", "guanacaste").split(",") if p.strip()]


def key_status() -> dict[str, bool]:
    """Report which keys are configured without ever revealing their values."""
    return {"FIRMS_MAP_KEY": bool(FIRMS_MAP_KEY), "EARTHDATA_TOKEN": bool(EARTHDATA_TOKEN),
            "MAPILLARY_TOKEN": bool(MAPILLARY_TOKEN)}
