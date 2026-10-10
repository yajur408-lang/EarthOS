"""Screening thresholds, read from screening.toml (or the file named by SCREENING_CONFIG)."""

from __future__ import annotations

import os
import tomllib
from pathlib import Path

PATH = Path(os.environ.get("SCREENING_CONFIG", Path(__file__).with_name("screening.toml")))

with open(PATH, "rb") as f:
    CFG: dict = tomllib.load(f)

AREA = CFG["area"]
LOSS = CFG["forest_loss"]
SUSC = CFG["susceptibility"]
TRIGGER = CFG["trigger"]
BACKTEST = CFG["backtest"]
