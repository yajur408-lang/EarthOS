# Seed snapshot

Pre-computed cache files for the featured Costa Rica places and the Santa Ana pilot, copied into the server's cache
at startup (`_seed_cache` in `app/main.py`) so these places open instantly on a fresh free-tier server.

- **What's in it:** MODIS NDVI subsets and date lists (ORNL), NASA POWER daily records, terrain tiles, extra MODIS
  series, memoised anomaly statistics, reverse-geocoding results, and the pilot's screening arrays (`screening/area_*.npz`).
  Short-lived data (forecasts, events, HLS pass lists, forest-loss results) is deliberately excluded.
- **Regenerate:** `cd backend && python -m scripts.build_seed` (needs network; `EARTHDATA_TOKEN` in `backend/.env`
  also adds the forest-loss run). Re-run after changing the analysis or screening maths, or every few months.
- **Stale seeds are ignored, not trusted:** cache keys include version stamps (`analysis.VERSION`, `service.VERSION`,
  `service.PNG_VERSION`, `service.LOSS_VERSION`). After a version bump the old files simply don't match any key and the
  server recomputes them; nothing stale is served.
- **Size:** about 19 MB and ~1,150 files. It is kept in git so a Render deploy is self-contained; moving it to a
  release asset downloaded at build time would shrink the repository (not done yet).
