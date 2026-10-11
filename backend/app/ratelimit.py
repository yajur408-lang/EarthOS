"""Per-visitor rate limiting for the public API.

EarthOS relays requests to free public services (ORNL, NASA, OSM Nominatim, MET Norway,
GDELT...). A single heavy user could otherwise get the server's IP throttled or banned
for everyone, so each client IP gets a token bucket.
"""

from __future__ import annotations

import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

# Requests that reach slow upstream services cost more tokens.
COST = {"/api/series": 6, "/api/extra": 6, "/api/geocode": 3, "/api/events": 3, "/api/street": 2,
        # Screening: the first look at a new area builds terrain (CPU); the job poll and images are cheap.
        "/api/screening/backtest": 3, "/api/hazards/events": 4, "/api/screening/": 1, "/api/screening": 4}


class RateLimit(BaseHTTPMiddleware):
    def __init__(self, app, per_minute: int):
        super().__init__(app)
        self.capacity = float(per_minute)
        self.rate = per_minute / 60.0
        self.buckets: dict[str, tuple[float, float]] = {}

    def _client(self, request: Request) -> str:
        # Behind a host's proxy (Render, Fly, Railway) the real client is the first X-Forwarded-For entry.
        fwd = request.headers.get("x-forwarded-for")
        return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "unknown")

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or path == "/api/health":
            return await call_next(request)
        cost = next((c for p, c in COST.items() if path.startswith(p)), 1)
        now = time.monotonic()
        key = self._client(request)
        tokens, last = self.buckets.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last) * self.rate)
        if tokens < cost:
            retry = int((cost - tokens) / self.rate) + 1
            return JSONResponse({"detail": f"Too many requests - please wait {retry} s."}, status_code=429,
                                headers={"Retry-After": str(retry)})
        self.buckets[key] = (tokens - cost, now)
        if len(self.buckets) > 50_000:  # keep memory bounded on a long-running server
            self.buckets.clear()
        return await call_next(request)
