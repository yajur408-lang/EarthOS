"""Print the pilot's validation numbers as Markdown (the README's "Results so far" comes from this).

Run from backend/:  python -m scripts.validation_report
Uses the same code as /api/methods and the Backtest page; needs network access the first time (NASA POWER).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
os.environ.setdefault("PREWARM_PLACES", "")
sys.path.insert(0, str(BACKEND))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def pct(v):
    return "–" if v is None else f"{round(v * 100)}%"


def ci(c):
    return f" ({pct(c[0])}–{pct(c[1])})" if c else ""


def main():
    with TestClient(app) as c:
        m = c.get("/api/methods").json()
    bt, v, ff, rs = m["backtest"], m["susceptibility_validation"], m["false_flag_rate"], m["ranking_sensitivity"]
    print(f"Pilot: {m['pilot']['name']} ({m['pilot']['lat']}, {m['pilot']['lon']}), box half-width {m['pilot']['half_km']} km\n")
    print(f"Rainfall trigger backtest, {bt['period'][0]} to {bt['period'][1]} (perfect-forecast hindcast, NASA POWER rain):\n")
    print("| Level | Hit rate (95% CI) | Random days, same count | Rain-only, same count | Alerts with no catalogued landslide |")
    print("|---|---|---|---|---|")
    for s in bt["scores"]:
        b = bt["baselines"][s["level"]]
        name = "Elevated or High" if s["level"] == "watch" else "High only"
        rnd = f"{pct(b['random']['hit_rate_mean'])} (95% of draws {pct(b['random']['hit_rate_95'][0])}–{pct(b['random']['hit_rate_95'][1])})"
        rain = f"≥ {b['rain_only']['threshold_mm']} mm/day: {pct(b['rain_only']['hit_rate'])}"
        print(f"| {name} | {s['hits']}/{s['events']} = {pct(s['hit_rate'])}{ci(s['hit_rate_ci'])} | {rnd} | {rain} | "
              f"{s['no_event_alerts']}/{s['alert_episodes']}{ci(s['no_event_alert_rate_ci'])} |")
    print()
    for blk in bt["blocks"]:
        parts = [f"{'Elevated/High' if s['level'] == 'watch' else 'High'} {s['hits']}/{s['events']}" for s in blk["scores"]]
        print(f"- {blk['block']} block {blk['period'][0][:4]}–{blk['period'][1][:4]}: " + ", ".join(parts))
    print(f"\nSusceptibility vs located landslides: n = {v['events_usable']} ({v['excluded_vague_location']} excluded, vague location)")
    for t in v["table"]:
        print(f"- {t['class']}: {t['events']} landslides, {pct(t['area_share_within_100m'])} of land, frequency ratio {t['frequency_ratio']}")
    if ff:
        print(f"\nAnomaly detector false flags (synthetic undisturbed series, {ff['years'][0]}–{ff['years'][1]}): "
              f"{ff['null']['events_per_point_year']} per point-year; real records {ff['real']['events_per_point_year']} (upper bound)")
    print("\nRanking stability (+/-20% on each weight): " + json.dumps(rs["by_kind"]))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
