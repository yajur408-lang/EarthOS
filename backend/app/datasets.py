"""Datasets served by the API, with the citations shown next to every chart."""

DATASETS = {
    "MOD13Q1": {
        "name": "MODIS/Terra Vegetation Indices 16-Day L3 Global 250m (MOD13Q1 v061)",
        "provider": "NASA LP DAAC, served by ORNL DAAC MODIS Web Service",
        "url": "https://modis.ornl.gov/data/modis_webservice.html",
        "doi": "10.5067/MODIS/MOD13Q1.061",
    },
    "POWER": {
        "name": "NASA POWER daily precipitation (PRECTOTCORR) and max 2 m temperature (T2M_MAX)",
        "provider": "NASA Langley Research Center POWER Project (MERRA-2 based)",
        "url": "https://power.larc.nasa.gov/",
        "doi": None,
    },
}
