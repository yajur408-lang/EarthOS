export interface Place {
  id: string
  name: string
  country?: string
  lat: number
  lon: number
  km: number
  about?: string
}

export interface GeoResult {
  name: string
  label: string
  type?: string
  lat: number
  lon: number
  /** south, north, west, east */
  bbox: [number, number, number, number] | null
}

export interface ReverseResult {
  name: string
  label: string
  country?: string
}

export interface Dataset {
  name: string
  provider: string
  url: string
  doi: string | null
}

export interface NdviPoint {
  date: string
  ndvi: number | null
  usable_fraction: number
}

export interface ClimatePoint {
  date: string
  precip_mm: number | null
  tmax_c: number | null
  tmin_c: number | null
  humidity_pct: number | null
  solar_kwh_m2: number | null
  cloud_pct: number | null
  wind_m_s: number | null
  soil_wetness: number | null
}

export interface StatPoint {
  date: string
  ndvi: number | null
  ndvi_expected: number | null
  ndvi_sigma: number | null
  ndvi_z: number | null
  usable_fraction: number | null
  precip_mm: number | null
  precip_expected: number | null
  precip_z: number | null
  tmax_c: number | null
  tmax_expected: number | null
  tmax_z: number | null
  flag_threshold: boolean
  flag_below: boolean
  flag_above: boolean
}

export interface AnomalyEvent {
  direction: 'below' | 'above'
  start: string
  end: string
  composites: number
  peak_z: number
  mean_ndvi: number
  mean_expected: number
  mean_difference: number
  usable_fraction: number
  precip_pct_vs_median: number | null
  precip_z: number | null
  tmax_z: number | null
  within_1sigma_within_3_composites: boolean | null
  threshold_flags_in_event: number
}

export interface Stats {
  params: { z: number; drop: number; min_usable_fraction: number; min_baseline_years: number; antecedent_days: number }
  series: StatPoint[]
  events: AnomalyEvent[]
  methods: {
    composites_evaluated: number
    threshold_flags: number
    seasonal_below_flags: number
    seasonal_above_flags: number
    both: number
    threshold_only: number
    seasonal_only: number
    threshold_flags_within_1_5_sigma: number
  }
  warnings: string[]
  method_notes: string[]
}

export interface Series {
  query: { lat: number; lon: number; km: number; start_year: number; end_year: number; z: number; drop: number }
  ndvi: { dataset: string; pixels_per_composite: number; note: string; points: NdviPoint[]; error: string | null }
  climate: { dataset: string; points: ClimatePoint[]; error: string | null }
  stats: Stats | null
  datasets: Record<string, Dataset>
}

export interface HlsPass { sensor: 'S30' | 'L30'; date: string; cloud_pct: number }

export interface TerrainInfo {
  elevation_m: number
  box: { min_m: number; max_m: number; mean_m: number; relief_m: number }
  slope_deg: number
  aspect_deg: number | null
  pixel_m: number
  profile: { distance_m: number; elevation_m: number }[]
  note: string
}

export type ExtraKind = 'evi' | 'lst' | 'burned' | 'landcover'
export interface ExtraResult<T> {
  kind: ExtraKind
  points: T[]
  error?: string
}
export interface EviPoint { date: string; value: number | null; usable_fraction: number }
export interface LstPoint { date: string; day_c: number | null; night_c: number | null }
export interface BurnPoint { date: string; burned_fraction: number | null; pixels: number }
export interface LandcoverPoint { year: number; classes: Record<string, number> }

export interface StreetImage {
  provider: 'kartaview' | 'mapillary'
  id: string
  lat: number
  lon: number
  distance_m: number
  captured: string
  heading: number | null
  pano: boolean
  sequence: string | null
  sequence_index: number | null
  author: string | null
  page: string
}
export interface StreetNearby {
  items: StreetImage[]
  providers: { kartaview: boolean; mapillary: boolean }
  attribution: string
}

export interface ForecastHour {
  time: string
  temp_c: number | null
  humidity_pct: number | null
  wind_m_s: number | null
  wind_from_deg: number | null
  cloud_pct: number | null
  pressure_hpa: number | null
  precip_mm: number | null
  precip_hours: number
  symbol: string | null
}
export interface Forecast { updated: string; hours: ForecastHour[]; attribution: string }

export interface NaturalEvent {
  title: string; category: string; date: string; first_date: string; closed: string | null
  distance_km: number; lat: number; lon: number; url: string | null; source: string
}
export interface Quake {
  title: string; magnitude: number; date: string; distance_km: number; depth_km: number
  lat: number; lon: number; url: string; source: string
}
export interface Outbreak { title: string; date: string; url: string; matches_country: boolean; source: string }
export interface Headline { title: string; url: string; domain: string; language: string; date: string | null; source: string }
export interface EventsResult {
  natural: NaturalEvent[]
  earthquakes: Quake[]
  outbreaks: Outbreak[]
  news: Headline[]
  errors: Partial<Record<'natural' | 'earthquakes' | 'outbreaks' | 'news', string>>
  attribution: string
}

const BASE = import.meta.env.VITE_API_BASE ?? ''

async function get<T>(path: string, params?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const qs = params
    ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
    : ''
  const r = await fetch(`${BASE}${path}${qs}`, { signal })
  if (!r.ok) {
    let detail = r.statusText
    try {
      const body = await r.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* not JSON */
    }
    throw new Error(`${r.status}: ${detail}`)
  }
  return r.json()
}

export const api = {
  places: () => get<Place[]>('/api/places'),
  series: (p: { lat: number; lon: number; km: number; start_year: number; end_year: number; z: number; drop: number }, signal?: AbortSignal) =>
    get<Series>('/api/series', p, signal),
  geocode: (q: string) => get<GeoResult[]>('/api/geocode', { q }),
  reverse: (lat: number, lon: number, signal?: AbortSignal) => get<ReverseResult | null>('/api/reverse', { lat, lon }, signal),
  terrain: (lat: number, lon: number, km: number, signal?: AbortSignal) => get<TerrainInfo>('/api/terrain', { lat, lon, km }, signal),
  extra: <T,>(kind: ExtraKind, p: { lat: number; lon: number; km: number; start_year: number; end_year: number }, signal?: AbortSignal) =>
    get<ExtraResult<T>>(`/api/extra/${kind}`, p, signal),
  street: (lat: number, lon: number, signal?: AbortSignal) => get<StreetNearby>('/api/street', { lat, lon }, signal),
  streetImageUrl: (img: Pick<StreetImage, 'provider' | 'id'>, size: 'thumb' | 'full' = 'full') =>
    `${BASE}/api/street/image/${img.provider}/${img.id}?size=${size}`,
  streetSequence: (img: StreetImage) =>
    get<{ prev: StreetImage | null; next: StreetImage | null }>(`/api/street/sequence/${img.provider}/${img.sequence}/${img.sequence_index ?? 0}`),
  sharp: (lat: number, lon: number, signal?: AbortSignal) =>
    get<{ passes: HlsPass[]; attribution: string }>('/api/sharp-imagery', { lat, lon }, signal),
  weather: (lat: number, lon: number, signal?: AbortSignal) => get<Forecast>('/api/weather', { lat, lon }, signal),
  events: (p: { lat: number; lon: number; place?: string; country?: string }, signal?: AbortSignal) =>
    get<EventsResult>('/api/events', p, signal),
}
