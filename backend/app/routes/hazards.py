"""Natural hazards near a place, and 30 m before/after change checks."""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Query
from fastapi.responses import FileResponse

from .common import DateQ
from .common import LatQ
from .common import LonQ
from .common import SCREENING_NOTICE
from .common import _screen_area

router = APIRouter()


@router.get("/api/hazards/events")
async def hazard_events(lat: float = LatQ, lon: float = LonQ, start: str | None = DateQ("from (default 1980-01-01)"), end: str | None = DateQ("to (default today)")):
    """Tropical cyclones, tornadoes (US), earthquakes, wildfires, volcanoes, floods, storms and landslides near a place,
    with the satellite check that suits each one."""
    from ..screening import disasters
    s = dt.date.fromisoformat(start) if start else dt.date(1980, 1, 1)
    e = dt.date.fromisoformat(end) if end else dt.date.today()
    return {**(await disasters.near(round(lat, 3), round(lon, 3), s, e)), "notice": SCREENING_NOTICE}

HazardQ = Query(..., pattern="^(cyclone|tornado|landslide|earthquake|wildfire|volcano|flood|storm)$")

@router.get("/api/hazards/change")
async def hazard_change(lat: float = LatQ, lon: float = LonQ, hazard: str = HazardQ,
                        date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"), half_km: float | None = Query(None, ge=1, le=8),
                        start: bool = False):
    """30 m before/after change around an event date (background job; poll until done, start=true to run)."""
    from ..screening import service
    clat, clon, h = _screen_area(lat, lon, half_km)
    day = dt.date.fromisoformat(date)
    if day < dt.date(2013, 6, 1):
        st = {"status": "unavailable", "error": "30 m HLS imagery starts in 2013, so events before then can't be checked."}
    else:
        st = service.change_status(clat, clon, h, hazard, day)
        if not service.loss_ready() and st["status"] == "not_started":
            st = {"status": "unavailable", "error": "The 30 m change check needs a NASA Earthdata token on the server."}
        elif start and st["status"] in ("not_started", "error"):
            st = service.start_change(clat, clon, h, hazard, day)
    return {**st, "area": {"lat": clat, "lon": clon, "half_km": h}, "hazard": hazard, "event_date": day.isoformat(),
            "overlay": f"/api/hazards/change.png?lat={clat}&lon={clon}&half_km={h}&hazard={hazard}&date={day.isoformat()}",
            "notice": SCREENING_NOTICE}

@router.get("/api/hazards/change.png")
async def hazard_change_png(lat: float = LatQ, lon: float = LonQ, half_km: float = Query(..., ge=1, le=8), hazard: str = HazardQ,
                            date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$")):
    from ..screening import service
    clat, clon, h = service.snap(lat, lon, half_km)
    path = service.change_png_path(clat, clon, h, hazard, dt.date.fromisoformat(date))
    if not path.exists():
        raise HTTPException(404, "No change overlay for this event yet.")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})
