"""Tiny on-disk JSON cache so repeated investigations don't re-hit public APIs.

Concurrent requests for the same key share one in-flight download, so overlapping
queries (e.g. a quick 2-year view and the full 10-year record) never fetch the same
data twice. Downloads run as their own tasks, so a visitor leaving mid-load doesn't
cancel work another request (or the cache) still needs.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Any, Awaitable, Callable

from .config import CACHE_DIR

_inflight: dict[str, asyncio.Task] = {}


async def cached_json(key: str, fetch: Callable[[], Awaitable[Any]],
                      max_age_days: float | None = None) -> Any:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    safe = hashlib.sha1(key.encode()).hexdigest()[:16]
    path = CACHE_DIR / f"{key[:40].replace(':', '_')}_{safe}.json"
    if path.exists():
        fresh = max_age_days is None or (time.time() - path.stat().st_mtime) < max_age_days * 86400
        if fresh:
            return json.loads(path.read_text())

    task = _inflight.get(key)
    if task is None:
        async def run():
            try:
                value = await fetch()
                path.write_text(json.dumps(value))
                return value
            finally:
                _inflight.pop(key, None)

        task = _inflight[key] = asyncio.ensure_future(run())
    return await asyncio.shield(task)
