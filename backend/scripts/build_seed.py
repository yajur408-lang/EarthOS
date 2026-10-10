"""Pre-compute the featured (Costa Rica) places into backend/seed so the deployed server opens them instantly.

Run from backend/:  python -m scripts.build_seed
It fetches everything the place card needs into an empty cache, then that cache becomes the seed.
Re-run occasionally (e.g. monthly) to refresh; the server still fetches newer composites on its own.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import os
import shutil
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
SEED = BACKEND / "seed"
TMP = BACKEND / "data" / "seed-build"
os.environ["CACHE_DIR"] = str(TMP)  # must be set before the app modules import config
os.environ["SEED_DIR"] = str(BACKEND / "no-seed")  # don't copy the old seed into the build cache
os.environ["PREWARM_PLACES"] = ""  # the script fetches the places itself
sys.path.insert(0, str(BACKEND))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.places import FEATURED, PILOT  # noqa: E402


def main():
    # Resumes from whatever is already in the build cache; delete data/seed-build for a clean rebuild.
    year = dt.date.today().year
    # One client context = one event loop for all requests (the shared ORNL request limiter is loop-bound).
    with TestClient(app) as c:
        for p in FEATURED:
            q = {"lat": p["lat"], "lon": p["lon"], "km": p["km"]}
            rng = {**q, "start_year": year - 9, "end_year": year}
            print(f"{p['name']}: series", flush=True)
            s = c.get("/api/series", params=rng).json()
            c.get("/api/series", params={**rng, "start_year": year})  # the quick current-year view
            for kind in ("evi", "lst", "burned", "landcover"):
                print(f"  {kind}", flush=True)
                c.get(f"/api/extra/{kind}", params=rng)
            c.get("/api/terrain", params=q)
            c.get("/api/street", params={"lat": p["lat"], "lon": p["lon"]})
            c.get("/api/reverse", params={"lat": p["lat"], "lon": p["lon"]})
            for ev in (s.get("stats") or {}).get("events", [])[:4]:
                print(f"  explain {ev['start']}", flush=True)
                c.get("/api/explain", params={**rng, "event_start": ev["start"], "direction": ev["direction"]})
        # Hazard-screening pilot: layers, overlay images, backtest, and (with a token) the forest-loss watch.
        print("pilot: screening", flush=True)
        scr = c.get("/api/screening", params={"lat": PILOT["lat"], "lon": PILOT["lon"], "country": PILOT["country"]}).json()
        a = scr["area"]
        for path in ("susceptibility.png", "preview.png"):
            c.get(f"/api/screening/{path}", params=a)
        c.get("/api/screening/backtest", params={"lat": PILOT["lat"], "lon": PILOT["lon"]})
        loss = scr["forest_loss"]
        t0 = time.time()
        while loss.get("status") == "running" and time.time() - t0 < 3600:
            time.sleep(15)
            loss = c.get("/api/screening/forest-loss", params={**a, "end": scr["forest_loss"]["end"]}).json()
            print(f"  forest loss: {loss.get('status')} {loss.get('progress', '')}", flush=True)
        print(f"  forest loss: {loss.get('status')} {loss.get('error', '')}", flush=True)
    # Keep only long-lived data (MODIS, terrain, imagery lookups); short-lived caches refresh on the server.
    if SEED.exists():
        shutil.rmtree(SEED)
    shutil.copytree(TMP, SEED, ignore=shutil.ignore_patterns("metno_*", "hls_*", "eonet_*", "usgs_*", "who_*", "gdelt_*"))
    size = sum(f.stat().st_size for f in SEED.rglob("*") if f.is_file())
    print(f"seed: {sum(1 for f in SEED.rglob('*') if f.is_file())} files, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
