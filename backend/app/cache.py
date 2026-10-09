"""Tiny on-disk JSON cache so repeated investigations don't re-hit public APIs."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Awaitable, Callable

from .config import CACHE_DIR


async def cached_json(key: str, fetch: Callable[[], Awaitable[Any]],
                      max_age_days: float | None = None) -> Any:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    safe = hashlib.sha1(key.encode()).hexdigest()[:16]
    path = CACHE_DIR / f"{key[:40].replace(':', '_')}_{safe}.json"
    if path.exists():
        fresh = max_age_days is None or (time.time() - path.stat().st_mtime) < max_age_days * 86400
        if fresh:
            return json.loads(path.read_text())
    value = await fetch()
    path.write_text(json.dumps(value))
    return value
