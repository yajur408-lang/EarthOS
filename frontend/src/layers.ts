// NASA GIBS layer catalogue. Identifiers, formats and tile matrix sets were checked
// against https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml

export type LayerKind = 'base' | 'overlay' | 'detail' | 'hazard'

export interface GibsLayer {
  id: string
  gibsId: string
  title: string
  kind: LayerKind
  format: 'jpg' | 'png'
  matrixSet: '250m' | '500m' | '1km' | '2km' | '31.25m' | '15.625m'
  /** Daily or periodic layers take a date; static layers don't. */
  timed: boolean
  cadence?: string
  description: string
  /** Extra attribution required beyond the GIBS acknowledgement. */
  credit?: string
  legend?: { from: string; to: string; colors: string[] }
  /** Served via WMS because GIBS only offers vector tiles over WMTS. */
  wms?: boolean
}

export const MAX_LEVEL: Record<GibsLayer['matrixSet'], number> = {
  '250m': 8,
  '500m': 7,
  '1km': 6,
  '2km': 5,
  '31.25m': 11,
  '15.625m': 12,
}

export const LAYERS: GibsLayer[] = [
  {
    id: 'bluemarble', gibsId: 'BlueMarble_ShadedRelief_Bathymetry', title: 'Blue Marble relief',
    kind: 'base', format: 'jpg', matrixSet: '500m', timed: false,
    description: 'Cloud-free MODIS composite with shaded relief - the default backdrop.',
  },
  {
    id: 'modis-truecolor', gibsId: 'MODIS_Terra_CorrectedReflectance_TrueColor', title: 'MODIS Terra true colour',
    kind: 'base', format: 'jpg', matrixSet: '250m', timed: true, cadence: 'daily',
    description: 'Daily corrected reflectance, 250 m. Clouds included - this is what the satellite saw.',
  },
  {
    id: 'viirs-truecolor', gibsId: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', title: 'VIIRS SNPP true colour',
    kind: 'base', format: 'jpg', matrixSet: '250m', timed: true, cadence: 'daily',
    description: 'Daily corrected reflectance from Suomi NPP, a second sensor for cross-checking.',
  },
  {
    id: 'ndvi', gibsId: 'MODIS_Terra_L3_NDVI_16Day', title: 'NDVI (16-day)',
    kind: 'overlay', format: 'png', matrixSet: '250m', timed: true, cadence: '16-day',
    description: 'Vegetation greenness from red and near-infrared reflectance. Same product as the Location data chart (MOD13Q1).',
    legend: { from: '0', to: '1', colors: ['#a67c52', '#e6d58e', '#9ccc65', '#2e7d32', '#0b3d0b'] },
  },
  {
    id: 'evi', gibsId: 'MODIS_Terra_L3_EVI_16Day', title: 'EVI (16-day)',
    kind: 'overlay', format: 'png', matrixSet: '250m', timed: true, cadence: '16-day',
    description: 'Enhanced Vegetation Index - saturates less than NDVI over dense rainforest.',
    legend: { from: '0', to: '1', colors: ['#a67c52', '#e6d58e', '#9ccc65', '#2e7d32', '#0b3d0b'] },
  },
  {
    id: 'lst', gibsId: 'MODIS_Terra_Land_Surface_Temp_Day', title: 'Land surface temp (day)',
    kind: 'overlay', format: 'png', matrixSet: '1km', timed: true, cadence: 'daily',
    description: 'Daytime skin temperature of the land surface, 1 km.',
    legend: { from: 'cold', to: 'hot', colors: ['#313695', '#74add1', '#fee090', '#f46d43', '#a50026'] },
  },
  {
    id: 'precip', gibsId: 'IMERG_Precipitation_Rate', title: 'Precipitation rate (IMERG)',
    kind: 'overlay', format: 'png', matrixSet: '2km', timed: true, cadence: 'daily',
    description: 'GPM IMERG precipitation rate.',
    legend: { from: 'light', to: 'heavy', colors: ['#c6dbef', '#6baed6', '#2171b5', '#6a51a3', '#cb181d'] },
  },
  {
    id: 'fires', gibsId: 'VIIRS_SNPP_Thermal_Anomalies_375m_All', title: 'Active fires (VIIRS 375 m)',
    kind: 'overlay', format: 'png', matrixSet: '250m', timed: true, cadence: 'daily', wms: true,
    description: 'Thermal anomaly detections for the selected day.',
  },
  {
    id: 'coastlines', gibsId: 'Coastlines_15m', title: 'Coastlines',
    kind: 'overlay', format: 'png', matrixSet: '15.625m', timed: false,
    description: 'Coastline vectors (OpenStreetMap-derived).',
    credit: '© OpenStreetMap contributors (ODbL)',
  },
  {
    id: 'labels', gibsId: 'Reference_Labels_15m', title: 'Place labels',
    kind: 'overlay', format: 'png', matrixSet: '15.625m', timed: false,
    description: 'Place names (OpenStreetMap-derived).',
    credit: '© OpenStreetMap contributors (ODbL)',
  },
]

// 30 m Harmonized Landsat Sentinel-2 true colour, one layer per sensor. Shown only when zoomed in,
// for the clearest recent pass over the view (chosen via /api/sharp-imagery).
LAYERS.push(
  {
    id: 'hls-s30', gibsId: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance', title: 'Sentinel-2 30 m (HLS)',
    kind: 'detail', format: 'png', matrixSet: '31.25m', timed: true, cadence: 'per pass',
    description: '30 m true colour from Sentinel-2, harmonised by NASA.',
    credit: 'NASA HLS · contains modified Copernicus Sentinel data',
  },
  {
    id: 'hls-l30', gibsId: 'HLS_L30_Nadir_BRDF_Adjusted_Reflectance', title: 'Landsat 30 m (HLS)',
    kind: 'detail', format: 'png', matrixSet: '31.25m', timed: true, cadence: 'per pass',
    description: '30 m true colour from Landsat 8/9, harmonised by NASA.',
    credit: 'NASA HLS (Landsat 8/9)',
  },
)


// Hazard layers: live weather satellites, flood and water maps, 30 m disturbance alerts and night lights.
// Checked against GIBS GetCapabilities on 2026-10-10 (formats, matrix sets and date ranges).
LAYERS.push(
  {
    id: 'goes-east', gibsId: 'GOES-East_ABI_GeoColor', title: 'GOES-East live (Americas)',
    kind: 'hazard', format: 'png', matrixSet: '1km', timed: false, cadence: 'latest, every 10 min',
    description: 'Latest geostationary image of the Americas and Atlantic: hurricanes, storm systems, smoke. Only the last ~60 days are kept, so it always shows the latest image.',
  },
  {
    id: 'goes-west', gibsId: 'GOES-West_ABI_GeoColor', title: 'GOES-West live (Pacific)',
    kind: 'hazard', format: 'png', matrixSet: '1km', timed: false, cadence: 'latest, every 10 min',
    description: 'Latest geostationary image of the eastern Pacific and western Americas.',
  },
  {
    id: 'himawari-ir', gibsId: 'Himawari_AHI_Band13_Clean_Infrared', title: 'Himawari live infrared (Asia-Pacific)',
    kind: 'hazard', format: 'png', matrixSet: '2km', timed: false, cadence: 'latest, every 10 min',
    description: 'Latest cloud-top infrared over Asia and the western Pacific: typhoon structure day and night.',
  },
  {
    id: 'flood-modis', gibsId: 'MODIS_Combined_Flood_3-Day', title: 'Flood map (MODIS, 3-day)',
    kind: 'hazard', format: 'png', matrixSet: '250m', timed: true, cadence: 'daily, from 2021',
    description: 'NASA near-real-time flood product: surface water beyond normal, from 3 days of MODIS. Cloud shadow can be misread as water.',
  },
  {
    id: 'flood-viirs', gibsId: 'VIIRS_Combined_Flood_3-Day', title: 'Flood map (VIIRS, 3-day)',
    kind: 'hazard', format: 'png', matrixSet: '250m', timed: true, cadence: 'daily, from mid-2025',
    description: 'The same flood product from VIIRS, which continues after MODIS.',
  },
  {
    id: 'water-s1', gibsId: 'OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1', title: 'Surface water, radar (OPERA, 30 m)',
    kind: 'hazard', format: 'png', matrixSet: '31.25m', timed: true, cadence: 'per pass, from 2024 (North America)',
    description: 'Water mapped from Sentinel-1 radar, which sees through cloud - useful during floods. Mostly North America.',
    credit: 'NASA OPERA · contains modified Copernicus Sentinel data',
  },
  {
    id: 'water-hls', gibsId: 'OPERA_L3_Dynamic_Surface_Water_Extent-HLS', title: 'Surface water, optical (OPERA, 30 m)',
    kind: 'hazard', format: 'png', matrixSet: '31.25m', timed: true, cadence: 'per pass, from 2016',
    description: 'Water mapped from Landsat/Sentinel-2 (HLS). Clouds leave gaps.',
    credit: 'NASA OPERA · contains modified Copernicus Sentinel data',
  },
  {
    id: 'dist-alert', gibsId: 'OPERA_L3_DIST-ALERT-HLS_Color_Index', title: 'Vegetation disturbance alerts (OPERA, 30 m)',
    kind: 'hazard', format: 'png', matrixSet: '31.25m', timed: true, cadence: 'per pass, from 2023',
    description: 'NASA alerts where vegetation cover dropped versus its usual state: tornado tracks, hurricane blowdown, fires, clearing, landslides.',
    credit: 'NASA OPERA DIST-ALERT · contains modified Copernicus Sentinel data',
  },
  {
    id: 'night-lights', gibsId: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance', title: 'Night lights (VIIRS)',
    kind: 'hazard', format: 'png', matrixSet: '500m', timed: true, cadence: 'nightly',
    description: 'Night-time light seen by VIIRS. Compare nights before and after a storm to spot power outages (moonlight and cloud also change it).',
  },
)

export const layerById = (id: string) => LAYERS.find((l) => l.id === id)!

export const GIBS_ACK =
  "Imagery from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."

/** A real GIBS tile (Americas, zoom level 1) used as the layer's thumbnail. */
export function thumbUrl(l: GibsLayer, date: string) {
  if (l.wms) {
    return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${l.gibsId}&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:4326&BBOX=-120,-40,-30,40&WIDTH=128&HEIGHT=128&TIME=${date}`
  }
  const time = l.timed ? date : 'default'
  const level = l.matrixSet === '15.625m' ? 2 : 1
  return `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${l.gibsId}/default/${time}/${l.matrixSet}/${level}/0/${level === 2 ? 1 : 0}.${l.format}`
}
