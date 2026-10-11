"""Everything the Methods page shows, read from config and code."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from .. import analysis


router = APIRouter()


_cache: dict = {}  # {"at": time, "ttl": seconds, "task": asyncio.Task}


@router.get("/api/methods")
async def methods_info():
    """Cached: the backtest baselines, sensitivity check and ranking take ~15 s on a small host. Recomputed every 6 h,
    or after 10 min while the forest-loss result isn't ready yet (so the ranking check picks it up)."""
    import time
    hit = _cache.get("task")
    if hit is None or (hit.done() and time.time() - _cache["at"] > _cache.get("ttl", 0)):
        _cache.update(task=asyncio.ensure_future(_compute()), at=time.time(), ttl=600)
        hit = _cache["task"]
    res = await asyncio.shield(hit)
    _cache["ttl"] = 6 * 3600 if res["ranking_sensitivity"]["forest_loss_included"] else 600
    return res


async def _compute():
    """Everything the Methods page shows, straight from config and code (so the page can't drift from them)."""
    import json as _json
    from pathlib import Path as _P
    from .. import explain
    from ..places import PILOT
    from ..screening import priority, service, trigger
    from ..screening.settings import CFG

    clat, clon, h = service.snap(PILOT["lat"], PILOT["lon"], PILOT["screen_km"])
    a = await service.area(clat, clon, h)
    g = service._grid(a)
    st = service.loss_status(clat, clon, h, service.default_loss_end())
    loss = st if st.get("status") == "done" else st.get("previous")
    events = trigger.events_near(clat, clon, h * 1.5 + 2)
    pr = await asyncio.to_thread(priority.build, a, g, loss, events, (clat, clon), True)
    try:
        bt = await trigger.backtest(round(PILOT["lat"], 3), round(PILOT["lon"], 3))
        backtest = {k: bt[k] for k in ("period", "scores", "blocks", "baselines", "min_events_for_rate")}
    except Exception as e:  # noqa: BLE001
        backtest = {"error": f"{type(e).__name__}"}
    data = _P(__file__).resolve().parent.parent  # app/
    flag = _json.loads((data / "data" / "flag_rate.json").read_text()) if (data / "data" / "flag_rate.json").exists() else None
    cats = data / "screening" / "data" / "catalogs.json"
    return {
        "config": {k: v for k, v in CFG.items() if k != "provenance"},
        "provenance": CFG.get("provenance", {}),
        "explain_thresholds": explain.T,
        "anomaly": {"z": analysis.Z_FLAG, "min_deviation": analysis.MIN_DEVIATION, "trust_good": analysis.TRUST_GOOD,
                    "trust_usable": analysis.TRUST_USABLE, "trust_cloudy": analysis.TRUST_CLOUDY,
                    "sigma_floor": analysis.MIN_SCALE["ndvi"], "threshold_drop": analysis.THRESHOLD_DROP},
        "pilot": {"name": PILOT["name"], "lat": clat, "lon": clon, "half_km": h},
        "susceptibility_validation": pr["validation"],
        "ranking_sensitivity": {**priority.sensitivity(pr["all_sites"]), "forest_loss_included": bool(loss)},
        "backtest": backtest,
        "false_flag_rate": flag,
        "catalogs": _json.loads(cats.read_text()) if cats.exists() else {},
    }
