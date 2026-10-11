"""Hazard screening for a place: susceptibility, rainfall trigger, forest-loss watch, inspection ranking, backtest."""

from __future__ import annotations

import asyncio
import datetime as dt

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Query
from fastapi.responses import FileResponse

from .common import DateQ
from .common import LatQ
from .common import LonQ
from .common import SCREENING_NOTICE
from .common import _in_pilot
from .common import _official_links
from .common import _screen_area

router = APIRouter()


@router.get("/api/screening")
async def screening(lat: float = LatQ, lon: float = LonQ, half_km: float | None = Query(None, ge=1, le=8),
                    country: str | None = None, date: str | None = DateQ("Day to screen (default: today)")):
    """Susceptibility (and the class at the point), the rainfall trigger for the chosen day, and the forest-loss watch
    for the 90 days up to that day. Recent days start the forest-loss job automatically; older ones on request."""
    from ..screening import service, trigger
    day = dt.date.fromisoformat(date) if date else dt.date.today()
    clat, clon, h = _screen_area(lat, lon, half_km)
    susc, trig = await asyncio.gather(
        service.susceptibility_result(clat, clon, h, (lat, lon)), trigger.at_date(lat, lon, min(day, dt.date.today())),
        return_exceptions=True)
    return {
        "area": {"lat": clat, "lon": clon, "half_km": h},
        "date": day.isoformat(),
        "notice": SCREENING_NOTICE,
        "official": _official_links(country),
        "susceptibility": susc if not isinstance(susc, Exception) else {"error": f"{type(susc).__name__}: {susc}"},
        "overlay": f"/api/screening/susceptibility.png?lat={clat}&lon={clon}&half_km={h}&v={service.PNG_VERSION}",
        "trigger": ({**trig, "calibrated": _in_pilot(lat, lon)} if not isinstance(trig, Exception)
                    else {"error": f"{type(trig).__name__}: {trig}"}),
        "forest_loss": _loss_payload(clat, clon, h, day, start=None),
    }

def _loss_payload(clat: float, clon: float, h: float, day: dt.date, start: bool | None) -> dict:
    from ..screening import service
    end, why = service.loss_end_for(day)
    if end is None:
        return {"status": "unavailable", "error": why}
    st = service.loss_status(clat, clon, h, end)
    latest = end == service.default_loss_end()
    if not service.loss_ready() and st["status"] == "not_started":
        st = {**st, "status": "unavailable", "error": "The 30 m forest-loss watch needs a NASA Earthdata token on the server."}
    elif st["status"] in ("not_started", "error") and (start or (start is None and latest)):
        st = service.start_loss(clat, clon, h, end) if st["status"] == "not_started" else service.restart_loss(clat, clon, h, end)
    return {**st, "end": end.isoformat(), "latest": latest,
            "overlay": f"/api/screening/forest-loss.png?lat={clat}&lon={clon}&half_km={h}&end={end.isoformat()}"}

@router.get("/api/screening/forest-loss")
async def screening_loss(lat: float = LatQ, lon: float = LonQ, half_km: float | None = Query(None, ge=1, le=8),
                         date: str | None = DateQ(), end: str | None = DateQ(), start: bool = False):
    """Status (and the result when done) of the forest-loss watch for a day. Pass start=true to run it if needed."""
    clat, clon, h = _screen_area(lat, lon, half_km)
    day = dt.date.fromisoformat(end or date) if (end or date) else dt.date.today()
    return {**_loss_payload(clat, clon, h, day, start=start or None), "notice": SCREENING_NOTICE}

@router.get("/api/screening/priority")
async def screening_priority(lat: float = LatQ, lon: float = LonQ, half_km: float | None = Query(None, ge=1, le=8)):
    """Where to inspect first: ranked sites with reasons and evidence, rainfall context for the area, and a check of the
    susceptibility map against past landslide locations."""
    from ..screening import priority, service, trigger
    clat, clon, h = _screen_area(lat, lon, half_km)
    a = await service.area(clat, clon, h)
    g = service._grid(a)
    st = service.loss_status(clat, clon, h, service.default_loss_end())
    loss = st if st.get("status") == "done" else st.get("previous")
    events = trigger.events_near(clat, clon, h * 1.5 + 2)
    res = await asyncio.to_thread(priority.build, a, g, loss, events, (clat, clon))
    try:
        rain = await priority.rainfall_context(clat, clon)
    except Exception as e:  # noqa: BLE001
        rain = {"available": False, "error": f"{type(e).__name__}"}
    return {**res, "area": {"lat": clat, "lon": clon, "half_km": h}, "bounds": g.bounds(),
            "rainfall": rain, "evidence": priority.evidence(loss), "forest_loss_used": bool(loss),
            "calibrated": _in_pilot(lat, lon),
            "weights": priority.P["weights"], "settings": {k: v for k, v in priority.P.items() if k != "weights"},
            "method": priority.METHOD, "notice": SCREENING_NOTICE}

@router.get("/api/screening/susceptibility.png")
async def screening_susc_png(lat: float = LatQ, lon: float = LonQ, half_km: float = Query(..., ge=1, le=8),
                             mode: str = Query("combined", pattern="^(combined|landslide|flood)$")):
    from ..screening import service
    clat, clon, h = service.snap(lat, lon, half_km)
    path = service.DIR / f"susc{service.PNG_VERSION}_{mode}_{service.area_key(clat, clon, h)}.png"
    if not path.exists():
        a = await service.area(clat, clon, h)
        png = await asyncio.to_thread(service.susceptibility_png, a, mode)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})

@router.get("/api/screening/preview.png")
async def screening_preview_png(lat: float = LatQ, lon: float = LonQ, half_km: float = Query(..., ge=1, le=8)):
    """Shaded relief + susceptibility, for the landing page and reports."""
    from ..screening import service
    clat, clon, h = service.snap(lat, lon, half_km)
    path = service.DIR / f"preview{service.PNG_VERSION}_{service.area_key(clat, clon, h)}.png"
    if not path.exists():
        a = await service.area(clat, clon, h)
        png = await asyncio.to_thread(service.preview_png, a)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})

@router.get("/api/screening/forest-loss.png")
async def screening_loss_png(lat: float = LatQ, lon: float = LonQ, half_km: float = Query(..., ge=1, le=8),
                             end: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$")):
    from ..screening import service
    clat, clon, h = service.snap(lat, lon, half_km)
    path = service.loss_png_path(clat, clon, h, dt.date.fromisoformat(end))
    if not path.exists():
        raise HTTPException(404, "No forest-loss overlay for this area and date yet.")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})

@router.get("/api/screening/trigger")
async def screening_trigger(lat: float = LatQ, lon: float = LonQ):
    from ..screening import trigger
    return {**(await trigger.current(lat, lon)), "calibrated": _in_pilot(lat, lon), "notice": SCREENING_NOTICE}

@router.get("/api/screening/backtest")
async def screening_backtest(lat: float = LatQ, lon: float = LonQ):
    from ..screening import trigger
    return {**(await trigger.backtest(round(lat, 3), round(lon, 3))), "calibrated": _in_pilot(lat, lon), "notice": SCREENING_NOTICE}
