"""Download and compact the bundled hazard catalogues (re-run a few times a year to refresh).

Run from backend/:  python -m scripts.build_hazard_catalogs

- Tropical cyclones: NOAA NCEI IBTrACS v04r01, all basins since 1980 (6-hourly track points).
  Knapp et al. (2010) BAMS 91:363-376; Gahtan et al. (2024) doi:10.25921/82ty-9e16. US Government work.
- Tornadoes: NOAA Storm Prediction Center tornado database, 1950 onwards (United States).
  https://www.spc.noaa.gov/wcm/ - US Government work (public domain).
"""

from __future__ import annotations

import csv
import gzip
import io
import sys
from pathlib import Path

import httpx

OUT = Path(__file__).resolve().parent.parent / "app" / "screening" / "data"
IBTRACS = ("https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/"
           "v04r01/access/csv/ibtracs.since1980.list.v04r01.csv")
SPC = "https://www.spc.noaa.gov/wcm/data/1950-{year}_actual_tornadoes.csv"


def _num(v: str) -> str:
    v = v.strip()
    try:
        float(v)
        return v
    except ValueError:
        return ""


def cyclones(client: httpx.Client) -> None:
    print("IBTrACS…", flush=True)
    with client.stream("GET", IBTRACS, timeout=600) as r:
        r.raise_for_status()
        lines = (line for line in r.iter_lines())
        header = next(lines)
        next(lines)  # units row
        cols = next(csv.reader([header]))
        ix = {c: i for i, c in enumerate(cols)}
        n = 0
        with gzip.open(OUT / "ibtracs.csv.gz", "wt", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["sid", "name", "time", "lat", "lon", "wind_kt", "sshs", "basin"])
            for row in csv.reader(lines):
                if len(row) < len(cols):
                    continue
                wind = _num(row[ix["USA_WIND"]]) or _num(row[ix["WMO_WIND"]])
                w.writerow([row[ix["SID"]], row[ix["NAME"]].title(), row[ix["ISO_TIME"]][:16],
                            round(float(row[ix["LAT"]]), 2), round(float(row[ix["LON"]]), 2), wind,
                            _num(row[ix["USA_SSHS"]]), row[ix["BASIN"]]])
                n += 1
    print(f"  {n} track points", flush=True)


def tornadoes(client: httpx.Client) -> None:
    print("SPC tornadoes…", flush=True)
    for year in range(2030, 2020, -1):
        r = client.get(SPC.format(year=year), timeout=300)
        if r.status_code == 200:
            break
    else:
        raise RuntimeError("SPC tornado file not found")
    rows = csv.DictReader(io.StringIO(r.text))
    n = 0
    with gzip.open(OUT / "spc_tornadoes.csv.gz", "wt", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "state", "ef", "injuries", "fatalities", "slat", "slon", "elat", "elon", "len_mi", "wid_yd"])
        for t in rows:
            slat, slon = float(t["slat"]), float(t["slon"])
            if not slat or not slon:
                continue
            elat, elon = float(t["elat"]) or slat, float(t["elon"]) or slon
            w.writerow([t["date"], t["st"], t["mag"], t["inj"], t["fat"], slat, slon, elat, elon, t["len"], t["wid"]])
            n += 1
    print(f"  {n} tornadoes (to {year})", flush=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(headers={"User-Agent": "EarthOS catalogue builder"}, follow_redirects=True) as c:
        which = sys.argv[1:] or ["cyclones", "tornadoes"]
        if "cyclones" in which:
            cyclones(c)
        if "tornadoes" in which:
            tornadoes(c)
    import datetime as dt
    import json
    meta_path = OUT / "catalogs.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    for name in ("cyclones", "tornadoes"):
        if name in which:
            key = "ibtracs" if name == "cyclones" else "spc_tornadoes"
            meta.setdefault(key, {})["built"] = dt.date.today().isoformat()
    meta_path.write_text(json.dumps(meta, indent=1))
    for f in OUT.glob("*.gz"):
        print(f.name, f"{f.stat().st_size / 1e6:.1f} MB")
