export interface Place {
  id: string
  name: string
  country?: string
  lat: number
  lon: number
  km: number
  about?: string
  featured?: boolean
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
  /** Trusted value used for statistics (null when the composite failed quality control). */
  ndvi: number | null
  /** Value as measured, shown faintly even when not trusted. */
  ndvi_raw: number | null
  good_fraction: number | null
  cloudy_fraction: number | null
  trusted: boolean
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
  good_fraction: number
  seasonal_rise: number | null
  prior_precip_pct: number | null
  checks: QualityCheck[]
  explanation: Explanation
}

export interface QualityCheck { check: string; status: 'pass' | 'warn' | 'fail'; detail: string }
export interface Driver {
  id: string
  title: string
  level: 'supported' | 'possible' | 'not supported'
  for: string[]
  against: string[]
  sources: string[]
}
export interface Explanation {
  confidence: 'high' | 'medium' | 'low'
  summary: string
  drivers: Driver[]
  caveat: string
}
export interface ExplainResult {
  event: AnomalyEvent
  context: { burned_pct: number | null; landcover_change: { changed: boolean; detail: string } | null }
  notes: string[]
}

export interface Stats {
  params: { z: number; drop: number; min_usable_fraction: number; min_baseline_years: number; antecedent_days: number; min_deviation: number }
  series: StatPoint[]
  events: AnomalyEvent[]
  methods: {
    composites_evaluated: number
    composites_excluded_quality: number
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
export interface EventsResult {
  natural: NaturalEvent[]
  earthquakes: Quake[]
  errors: Partial<Record<'natural' | 'earthquakes', string>>
  attribution: string
}

const BASE = import.meta.env.VITE_API_BASE ?? ''

async function get<T>(path: string, params?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const qs = params
    ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
    : ''
  const unreachable = 'Can\'t reach the EarthOS data server. If you\'re running locally, start the backend (uvicorn app.main:app --port 8000).'
  let r: Response
  try {
    r = await fetch(`${BASE}${path}${qs}`, { signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new Error(unreachable)
  }
  if (!r.ok) {
    let detail: string | null = null
    try {
      const body = await r.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* not JSON */
    }
    // A gateway error without our JSON body means the backend itself is down (e.g. the dev proxy couldn't connect).
    if (detail == null && r.status >= 502 && r.status <= 504) throw new Error(unreachable)
    throw new Error(detail ?? `${r.status}: ${r.statusText}`)
  }
  return r.json()
}

// ---------- hazard screening ----------
export interface SourceRef { name: string; use?: string; licence?: string; citation?: string; url?: string }
export interface OfficialLink { name: string; url: string }
export type SuscClass = 'lower' | 'medium' | 'high'
export type SuscMode = 'combined' | 'landslide' | 'flood'
export interface Susceptibility {
  bounds: { west: number; east: number; south: number; north: number }
  cell_m: number
  summary: {
    classes: Record<SuscClass, { share: number; uncertain_share: number }>
    uncertain_share: number
    unassessed_share?: number
    hand_unknown_share?: number
    slope_driven_share_of_high: number
    by_hazard?: { landslide: Record<SuscClass, number>; flood: Record<SuscClass | 'unknown', number> }
  }
  at_point: {
    class: SuscClass | 'unassessed'; uncertain: boolean
    landslide_class?: SuscClass; flood_class?: SuscClass | 'unknown'; driver?: string; range: [SuscClass, SuscClass]
    landslide_points: number; flood_points: number; slope_deg: number; hand_m: number | null; land_cover: string
  } | null
  terrain: { elevation_m: [number, number]; steep_share: number; drainage_share: number }
  land_cover: Record<string, number>
  method: string
  wording: string
  sources: SourceRef[]
  limits: string[]
  error?: string
}
export type TriggerLevel = 'none' | 'watch' | 'warning' | 'unavailable'
export interface TriggerInputs { fc24: number | null; fc72: number | null; ante7: number | null; soil: number | null }
export type TriggerRule = Partial<Record<keyof TriggerInputs, number>>
export interface Trigger {
  /** live = forecast-based (recent days); reconstructed = observed rain stands in for the forecast (older days) */
  mode?: 'live' | 'reconstructed'
  available?: boolean
  /** Inputs a rule needed but didn't have; with `incomplete`, the result can't be read as "no trigger". */
  missing_inputs?: (keyof TriggerInputs)[]
  incomplete?: boolean
  /** False outside the pilot area: the mm thresholds were set for Santa Ana and aren't validated elsewhere. */
  calibrated?: boolean
  level: TriggerLevel
  fired: TriggerRule[]
  inputs: TriggerInputs
  windows: { forecast_from: string | null; observed_from: string | null; observed_to: string | null; unobserved_days_before_forecast: number | null }
  rules: { watch: TriggerRule[]; warning: TriggerRule[] }
  errors: string[]
  sources: SourceRef[]
  notes: string[]
  error?: string
}
export interface LossPatch {
  id: number; label: string; lat: number; lon: number; area_ha: number; pixels: number; mean_slope_deg: number
  ndvi_baseline: number; ndvi_recent: number; ndvi_change: number; robust_z: number
}
export interface LossResult {
  label: string
  patches: LossPatch[]
  note?: string
  judged_share?: number
  judged_steep_share?: number
  recent_window: [string, string]
  baseline_windows: [number, string, string][]
  baseline_years_used: number[]
  n_baseline_years: number
  scenes: { recent: number; baseline: number; skipped?: number }
  qa: string
  thresholds?: Record<string, number>
  source: SourceRef
  bounds?: Susceptibility['bounds']
  has_overlay?: boolean
  computed?: string
}
export type LossStatus = (
  | ({ status: 'done' } & LossResult)
  | { status: 'running' | 'queued'; progress: number; started: number }
  | { status: 'not_started' | 'unavailable' | 'error' | 'busy'; error?: string }
) & { end?: string; latest?: boolean; overlay?: string; previous?: LossResult & { end: string } }
export interface Screening {
  area: { lat: number; lon: number; half_km: number }
  date: string
  notice: string
  official: OfficialLink[]
  susceptibility: Susceptibility
  overlay: string
  trigger: Trigger
  forest_loss: LossStatus
}
export interface BacktestEvent {
  date: string; lat: number; lon: number; trigger: string; accuracy: string; fatalities: string; title: string
  country: string; source: string; distance_km: number; origin: string; rain_triggered: boolean
  rain_mm?: number | null; ante7_mm?: number | null; soil?: number | null; level_on_day?: TriggerLevel
  hit?: Partial<Record<TriggerLevel, boolean>>
}
export interface BacktestScore {
  level: TriggerLevel; period: [string, string]; events: number; event_reports: number; hits: number
  hit_rate: number | null; hit_rate_ci: [number, number] | null
  misses: number; missed_events: { date: string; title: string }[]
  alert_episodes: number; no_event_alerts: number; no_event_alert_rate: number | null; no_event_alert_rate_ci: [number, number] | null
  alert_days: number; alert_days_per_year: number; enough_events: boolean
}
export interface BacktestBaseline {
  alert_days: number; events: number
  random?: { hit_rate_mean: number; hit_rate_95: [number, number]; no_event_alert_rate_mean: number | null; p_at_least_observed: number; draws: number }
  rain_only?: { threshold_mm: number; alert_days: number; hit_rate: number; hit_rate_ci: [number, number] | null; no_event_alert_rate: number | null }
}
export interface Backtest {
  place: { lat: number; lon: number; radius_km: number }
  period: [string, string]
  match_days: number
  scores: BacktestScore[]
  blocks: { block: 'earlier' | 'later'; period: [string, string]; scores: BacktestScore[] }[]
  split_note: string
  baselines: Record<'watch' | 'warning', BacktestBaseline>
  min_events_for_rate: number
  events: BacktestEvent[]
  rules: { watch: TriggerRule[]; warning: TriggerRule[] }
  method: string
  caveats: string[]
  sources: SourceRef[]
  notice: string
  /** False outside the Santa Ana pilot: thresholds weren't set or validated here. */
  calibrated?: boolean
}

// ---------- natural hazards near a place ----------
export type HazardType = 'cyclone' | 'tornado' | 'earthquake' | 'wildfire' | 'volcano' | 'flood' | 'landslide' | 'storm' | 'drought'
export interface HazardEvent {
  type: HazardType
  type_name: string
  title: string
  date: string
  lat: number
  lon: number
  distance_km: number
  detail: string
  severity: number
  source: string
  link?: string | null
  path?: [number, number][]
  satellite_check: string | null
}
export interface HazardEvents {
  period: [string, string]
  radius_km: Record<string, number>
  counts: Partial<Record<HazardType, number>>
  events: HazardEvent[]
  errors: string[]
  sources: Record<string, SourceRef>
  coverage: string[]
  notice: string
}
export interface ChangePatch {
  id: number; label: string; lat: number; lon: number; area_ha: number; pixels: number; mean_slope_deg: number
  before: number; after: number; change: number; robust_z: number
}
export interface ChangeResult {
  hazard: HazardType; event_date: string; index: 'NDVI' | 'NBR' | 'NDWI'; index_name?: string; looks_for: string; label: string
  patches: ChangePatch[]; note?: string; flagged_ha?: number; judged_share?: number
  before_window: [string, string]; after_window: [string, string]
  scenes: { before: number; after: number }; scene_dates?: { before: string[]; after: string[] }
  qa: string; method?: string; source: SourceRef; bounds?: Susceptibility['bounds']; has_overlay?: boolean
}
export type ChangeStatus = (
  | ({ status: 'done' } & ChangeResult)
  | { status: 'running' | 'queued'; progress: number }
  | { status: 'not_started' | 'unavailable' | 'error' | 'busy'; error?: string }
) & { overlay: string; hazard: HazardType; event_date: string; area: { lat: number; lon: number; half_km: number } }

// ---------- where to inspect first ----------
export interface InspectSite {
  id: string; rank: number; kind: 'slope' | 'stream corridor'; score: number
  parts: Record<'susceptibility' | 'exposure' | 'recent_loss' | 'history' | 'size', number>
  lat: number; lon: number; area_ha: number; high_share: number; uncertain_share: number
  reasons: string[]; bbox: [number, number, number, number]; square_m: number
}
export interface SuscValidation {
  events_in_area: number; events_usable: number; excluded_vague_location: number
  share_in_high: number | null; share_in_medium_or_high: number | null
  area_share: Record<SuscClass, number> & { unassessed?: number }
  area_share_within_100m: Record<SuscClass, number>
  table: { class: SuscClass; events: number; event_share: number | null; area_share_within_100m: number; frequency_ratio: number | null }[]
  missed: { date: string; title: string }[]
  events: { date: string; title: string; lat: number; lon: number; accuracy: string; origin: string; class_at_point: SuscClass | 'unassessed'; highest_within_100m: SuscClass }[]
  method: string; caveat: string
}
export interface Priority {
  sites: InspectSite[]
  total_sites: Record<'slope' | 'stream corridor', number>
  validation: SuscValidation
  area: { lat: number; lon: number; half_km: number }
  bounds: Susceptibility['bounds']
  rainfall: { available: boolean; window?: [string, string]; rain_mm?: number; normal_mm?: number | null; percent_of_normal?: number | null; years_compared?: number; note?: string }
  evidence: { layer: string; source: string; date: string; resolution: string }[]
  forest_loss_used: boolean
  calibrated?: boolean
  weights: Record<string, number>
  method: string
  notice: string
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
  sharp: (lat: number, lon: number, date: string, signal?: AbortSignal) =>
    get<{ passes: HlsPass[]; attribution: string }>('/api/sharp-imagery', { lat, lon, date }, signal),
  explain: (p: { lat: number; lon: number; km: number; start_year: number; end_year: number; event_start: string; direction: string }, signal?: AbortSignal) =>
    get<ExplainResult>('/api/explain', p, signal),
  weather: (lat: number, lon: number, signal?: AbortSignal) => get<Forecast>('/api/weather', { lat, lon }, signal),
  events: (p: { lat: number; lon: number }, signal?: AbortSignal) => get<EventsResult>('/api/events', p, signal),
  screening: (p: { lat: number; lon: number; country?: string; date?: string }, signal?: AbortSignal) =>
    get<Screening>('/api/screening', p, signal),
  forestLoss: (p: { lat: number; lon: number; half_km: number; end: string; start?: boolean }, signal?: AbortSignal) =>
    get<LossStatus>('/api/screening/forest-loss', { ...p, start: p.start ? 'true' : undefined }, signal),
  backtest: (lat: number, lon: number, signal?: AbortSignal) => get<Backtest>('/api/screening/backtest', { lat, lon }, signal),
  hazardEvents: (p: { lat: number; lon: number; start?: string; end?: string }, signal?: AbortSignal) =>
    get<HazardEvents>('/api/hazards/events', p, signal),
  hazardChange: (p: { lat: number; lon: number; hazard: HazardType; date: string; start?: boolean }, signal?: AbortSignal) =>
    get<ChangeStatus>('/api/hazards/change', { ...p, start: p.start ? 'true' : undefined }, signal),
  priority: (lat: number, lon: number, signal?: AbortSignal) => get<Priority>('/api/screening/priority', { lat, lon }, signal),
  url: (path: string) => `${BASE}${path}`,
}
