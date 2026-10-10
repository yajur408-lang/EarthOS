"""Example places. `km` is the half-width of the box averaged for NDVI.

Featured (Costa Rica) places ship with a pre-computed data snapshot (backend/seed), so they open
instantly even right after the server starts. Other places are fetched from NASA on first visit.
"""

PLACES = [
    # ---- Featured: Costa Rica showcase (pre-computed) ----
    {"id": "guanacaste", "name": "Santa Rosa, Guanacaste", "country": "Costa Rica", "lat": 10.84, "lon": -85.62, "km": 1,
     "featured": True, "about": "Tropical dry forest with a sharp dry season - the 2026 rains came late here."},
    {"id": "tempisque", "name": "Tempisque basin", "country": "Costa Rica", "lat": 10.35, "lon": -85.35, "km": 1,
     "featured": True, "about": "Irrigated sugarcane and rice; harvests make NDVI drop sharply."},
    {"id": "san-carlos", "name": "San Carlos plains", "country": "Costa Rica", "lat": 10.55, "lon": -84.30, "km": 1,
     "featured": True, "about": "Pineapple and pasture frontier in the northern lowlands."},
    {"id": "osa", "name": "Corcovado, Osa Peninsula", "country": "Costa Rica", "lat": 8.54, "lon": -83.59, "km": 1,
     "featured": True, "about": "Protected lowland rainforest - persistently cloudy, a hard test for satellites."},
    {"id": "chirripo", "name": "Chirripó highlands", "country": "Costa Rica", "lat": 9.48, "lon": -83.49, "km": 1,
     "featured": True, "about": "Montane forest and páramo up to 3,800 m."},
    # ---- Elsewhere (fetched on demand) ----
    {"id": "rondonia", "name": "Rondônia", "country": "Brazil", "lat": -10.0, "lon": -63.0, "km": 1,
     "about": "Southern Amazon agricultural frontier."},
    {"id": "sahel", "name": "Niamey region", "country": "Niger", "lat": 13.5, "lon": 2.1, "km": 1,
     "about": "Semi-arid Sahel savanna with a single short rainy season."},
    {"id": "punjab", "name": "Punjab plains", "country": "India", "lat": 30.9, "lon": 75.8, "km": 1,
     "about": "Irrigated wheat-rice double cropping."},
    {"id": "central-valley", "name": "Central Valley", "country": "United States", "lat": 36.6, "lon": -120.0, "km": 1,
     "about": "Irrigated agriculture in California."},
]

FEATURED = [p for p in PLACES if p.get("featured")]
