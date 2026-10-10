import { useEffect, useMemo, useState } from 'react'
import {
  api, type AnomalyEvent, type BurnPoint, type ClimatePoint, type EviPoint, type ExtraKind, type ExtraResult,
  type LandcoverPoint, type LstPoint, type Series,
} from '../api'
import MiniChart from './MiniChart'

interface Props {
  series: Series
  km: number
  focus: AnomalyEvent | null
  cursorDate: string
  onDate: (d: string) => void
}

type Extra<T> = { loading: boolean; error: string | null; points: T[] }

/** Fetch one of the slower MODIS products after the main series is in. */
function useExtra<T>(kind: ExtraKind, series: Series, km: number): Extra<T> {
  const q = series.query
  const key = `${kind}|${q.lat}|${q.lon}|${km}|${q.start_year}|${q.end_year}`
  const [state, setState] = useState<{ key: string; error: string | null; points: T[] } | null>(null)
  useEffect(() => {
    const ctrl = new AbortController()
    api.extra<T>(kind, { lat: q.lat, lon: q.lon, km, start_year: q.start_year, end_year: q.end_year }, ctrl.signal)
      .then((r: ExtraResult<T>) => setState({ key, error: r.error ?? null, points: r.points }))
      .catch((e: Error) => !ctrl.signal.aborted && setState({ key, error: e.message, points: [] }))
    return () => ctrl.abort()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return state?.key === key ? { loading: false, error: state.error, points: state.points } : { loading: true, error: null, points: [] }
}

type ClimKey = Exclude<keyof ClimatePoint, 'date'>

/** Calendar-month summary of a daily variable; months with missing days are left blank for totals. */
function monthly(points: ClimatePoint[], key: ClimKey, how: 'sum' | 'mean') {
  const g = new Map<string, number[]>()
  const days = new Map<string, number>()
  for (const p of points) {
    const k = p.date.slice(0, 7)
    days.set(k, (days.get(k) ?? 0) + 1)
    const v = p[key]
    if (v != null) g.set(k, [...(g.get(k) ?? []), v])
  }
  const x: string[] = [], y: (number | null)[] = []
  for (const k of days.keys()) {
    const vals = g.get(k) ?? []
    const [yy, mm] = k.split('-').map(Number)
    const full = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
    x.push(`${k}-15`)
    if (how === 'sum') y.push(vals.length === full ? vals.reduce((a, b) => a + b, 0) : null)
    else y.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null)
  }
  return { x, y }
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// MODIS IGBP land-cover colours (standard legend).
const IGBP_COLORS: Record<string, string> = {
  'Evergreen needleleaf forest': '#05450a', 'Evergreen broadleaf forest': '#086a10', 'Deciduous needleleaf forest': '#54a708',
  'Deciduous broadleaf forest': '#78d203', 'Mixed forest': '#009900', 'Closed shrubland': '#c6b044', 'Open shrubland': '#dcd159',
  'Woody savanna': '#dade48', Savanna: '#fbff13', Grassland: '#b6ff05', 'Permanent wetland': '#27ff87', Cropland: '#c24f44',
  'Urban and built-up': '#a5a5a5', 'Cropland/natural mosaic': '#ff6d4c', 'Snow and ice': '#69fff8', Barren: '#f9ffa4', Water: '#1c0dff',
}

export default function Dashboard({ series, km, focus, cursorDate, onDate }: Props) {
  const evi = useExtra<EviPoint>('evi', series, km)
  const lst = useExtra<LstPoint>('lst', series, km)
  const burned = useExtra<BurnPoint>('burned', series, km)
  const landcover = useExtra<LandcoverPoint>('landcover', series, km)
  const clim = series.climate.points
  const st = series.stats?.series ?? []

  const cursor: Partial<Plotly.Shape> = {
    type: 'line', xref: 'x', yref: 'paper', x0: cursorDate, x1: cursorDate, y0: 0, y1: 1,
    line: { color: 'rgba(26,115,232,0.7)', width: 1, dash: 'dot' },
  }
  const focusShape: Partial<Plotly.Shape>[] = focus ? [{
    type: 'rect', xref: 'x', yref: 'paper', x0: focus.start, x1: focus.end, y0: 0, y1: 1,
    fillcolor: focus.direction === 'below' ? 'rgba(217,48,37,0.12)' : 'rgba(26,115,232,0.12)', line: { width: 0 },
  }] : []
  const timeLayout = useMemo<Partial<Plotly.Layout>>(() => ({
    shapes: [cursor, ...focusShape],
    xaxis: focus ? { type: 'date', range: [shift(focus.start, -400), shift(focus.end, 400)] } : { type: 'date' },
  }), [cursorDate, focus]) // eslint-disable-line react-hooks/exhaustive-deps

  const ndvi = useMemo<Plotly.Data[]>(() => {
    const x = st.map((p) => p.date)
    const band = (k: number) => st.map((p) => (p.ndvi_expected != null && p.ndvi_sigma != null ? p.ndvi_expected + k * 2 * p.ndvi_sigma : null))
    const flags = (f: (p: (typeof st)[number]) => boolean, name: string, marker: object) => {
      const pts = st.filter(f)
      return { x: pts.map((p) => p.date), y: pts.map((p) => p.ndvi), type: 'scatter', mode: 'markers', name, marker } as Plotly.Data
    }
    return [
      { x, y: band(1), type: 'scatter', mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
      { x, y: band(-1), type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(95,99,104,0.15)', name: 'Normal ±2σ', hoverinfo: 'skip' },
      { x, y: st.map((p) => p.ndvi_expected), type: 'scatter', mode: 'lines', name: 'Seasonal median', line: { color: '#80868b', width: 1, dash: 'dot' } },
      { x: series.ndvi.points.map((p) => p.date), y: series.ndvi.points.map((p) => p.ndvi), type: 'scatter', mode: 'lines', name: 'NDVI', line: { color: '#188038', width: 1.6 } },
      (() => {
        // Composites too cloudy to trust: shown for honesty, never used for the normal range or flags.
        const pts = st.filter((p) => p.trusted === false && p.ndvi_raw != null)
        return {
          x: pts.map((p) => p.date), y: pts.map((p) => p.ndvi_raw), type: 'scatter', mode: 'markers', name: 'Cloudy (excluded)',
          marker: { color: 'rgba(128,134,139,0.45)', size: 5 },
          customdata: pts.map((p) => Math.round(100 * (p.good_fraction ?? 0))),
          hovertemplate: '%{x}: %{y:.2f} (only %{customdata}% clear pixels, excluded)<extra></extra>',
        } as Plotly.Data
      })(),
      flags((p) => p.flag_below, 'Below normal', { color: '#d93025', size: 7, line: { color: '#fff', width: 1 } }),
      flags((p) => p.flag_above, 'Above normal', { color: '#1a73e8', size: 7, line: { color: '#fff', width: 1 } }),
      flags((p) => p.flag_threshold, 'Threshold flag', { symbol: 'x-thin', size: 9, line: { color: '#f9ab00', width: 2 } }),
    ]
  }, [series]) // eslint-disable-line react-hooks/exhaustive-deps

  // NDVI by day of year, one line per year.
  const seasonal = useMemo<Plotly.Data[]>(() => {
    const years = new Map<number, { x: string[]; y: (number | null)[] }>()
    for (const p of series.ndvi.points) {
      const y = +p.date.slice(0, 4)
      const g = years.get(y) ?? { x: [], y: [] }
      g.x.push(`2001${p.date.slice(4)}`)
      g.y.push(p.ndvi)
      years.set(y, g)
    }
    const last = Math.max(...years.keys())
    const med = new Map<string, number | null>()
    for (const p of st) med.set(`2001${p.date.slice(4)}`, p.ndvi_expected)
    const medX = [...med.keys()].sort()
    return [
      ...[...years.entries()].map(([y, g]) => ({
        x: g.x, y: g.y, type: 'scatter', mode: 'lines', name: String(y), showlegend: y === last,
        line: { color: y === last ? '#1a73e8' : 'rgba(95,99,104,0.25)', width: y === last ? 2.4 : 1 },
        hovertemplate: `${y} · %{x|%d %b}: %{y:.3f}<extra></extra>`,
      }) as Plotly.Data),
      { x: medX, y: medX.map((k) => med.get(k) ?? null), type: 'scatter', mode: 'lines', name: 'Median of all years', line: { color: '#202124', width: 1.5, dash: 'dash' } },
    ]
  }, [series]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mean NDVI z-score per year x month.
  const heat = useMemo<Plotly.Data[]>(() => {
    const cells = new Map<string, number[]>()
    for (const p of st) if (p.ndvi_z != null) {
      const k = p.date.slice(0, 7)
      cells.set(k, [...(cells.get(k) ?? []), p.ndvi_z])
    }
    if (!cells.size) return []
    const years = [...new Set([...cells.keys()].map((k) => +k.slice(0, 4)))].sort()
    const z = years.map((y) => MONTHS.map((_, m) => {
      const v = cells.get(`${y}-${String(m + 1).padStart(2, '0')}`)
      return v ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null
    }))
    return [{
      type: 'heatmap', x: MONTHS, y: years.map(String), z, zmid: 0, zmin: -4, zmax: 4,
      colorscale: [[0, '#b2182b'], [0.35, '#ef8a62'], [0.5, '#f7f7f7'], [0.65, '#67a9cf'], [1, '#2166ac']],
      colorbar: { thickness: 8, len: 0.9, title: { text: 'z', side: 'right' } }, xgap: 1, ygap: 1,
      hovertemplate: '%{y} %{x}: z %{z}<extra></extra>',
    } as Plotly.Data]
  }, [series]) // eslint-disable-line react-hooks/exhaustive-deps

  const climate = useMemo(() => {
    const rain = monthly(clim, 'precip_mm', 'sum')
    const byMonth = new Map<number, number[]>()
    rain.x.forEach((x, i) => {
      const v = rain.y[i]
      if (v != null) byMonth.set(+x.slice(5, 7), [...(byMonth.get(+x.slice(5, 7)) ?? []), v])
    })
    return {
      rain, rainMedian: rain.x.map((x) => median(byMonth.get(+x.slice(5, 7)) ?? [])),
      tmax: monthly(clim, 'tmax_c', 'mean'), tmin: monthly(clim, 'tmin_c', 'mean'),
      solar: monthly(clim, 'solar_kwh_m2', 'mean'), cloud: monthly(clim, 'cloud_pct', 'mean'),
      rh: monthly(clim, 'humidity_pct', 'mean'), soil: monthly(clim, 'soil_wetness', 'mean'),
      wind: monthly(clim, 'wind_m_s', 'mean'),
    }
  }, [clim])

  const temps: Plotly.Data[] = [
    { x: lst.points.map((p) => p.date), y: lst.points.map((p) => p.day_c), type: 'scatter', mode: 'lines', name: 'Surface, day (MODIS)', line: { color: '#e8710a', width: 1.2 }, connectgaps: true },
    { x: lst.points.map((p) => p.date), y: lst.points.map((p) => p.night_c), type: 'scatter', mode: 'lines', name: 'Surface, night (MODIS)', line: { color: '#5e35b1', width: 1.2 }, connectgaps: true },
    { x: climate.tmax.x, y: climate.tmax.y, type: 'scatter', mode: 'lines', name: 'Air max (monthly)', line: { color: '#d93025', width: 1.6, dash: 'dot' } },
    { x: climate.tmin.x, y: climate.tmin.y, type: 'scatter', mode: 'lines', name: 'Air min (monthly)', line: { color: '#1a73e8', width: 1.6, dash: 'dot' } },
  ]

  const lcYears = landcover.points.map((p) => String(p.year))
  const lcClasses = [...new Set(landcover.points.flatMap((p) => Object.keys(p.classes)))]

  return (
    <div className="dashboard">
      <MiniChart title="Vegetation greenness (NDVI)" subtitle="16-day · 250 m · grey band = normal range for the season"
        data={ndvi} layout={timeLayout} height={250} onPointClick={onDate} source="MODIS MOD13Q1 v061" />
      <MiniChart title="Seasonal cycle" subtitle="NDVI by day of year · each line is one year, latest in blue"
        data={seasonal} layout={{ xaxis: { type: 'date', tickformat: '%b' }, hovermode: 'closest' }} source="MODIS MOD13Q1 v061" />
      <MiniChart title="Anomaly calendar" subtitle="Mean NDVI z-score by month (red = below normal, blue = above)"
        data={heat} layout={{ hovermode: 'closest', yaxis: { type: 'category', autorange: 'reversed' }, margin: { l: 42, r: 6, t: 6, b: 24 } }}
        height={Math.max(160, 22 * (new Set(st.map((p) => p.date.slice(0, 4))).size) + 40)} empty="Needs at least 5 years of data." source="Derived from MOD13Q1" />
      <MiniChart title="Enhanced Vegetation Index (EVI)" subtitle="Less saturated than NDVI over dense forest"
        loading={evi.loading} error={evi.error} layout={timeLayout}
        data={[{ x: evi.points.map((p) => p.date), y: evi.points.map((p) => p.value), type: 'scatter', mode: 'lines', name: 'EVI', line: { color: '#0b8043', width: 1.4 } }]}
        source="MODIS MOD13Q1 v061" />
      <MiniChart title="Temperature" subtitle="Land surface (8-day, 1 km) vs air at 2 m (monthly mean)" loading={lst.loading} error={lst.error}
        data={temps} layout={{ ...timeLayout, yaxis: { title: { text: '°C' } } }} height={240} source="MODIS MOD11A2 v061 · NASA POWER" />
      <MiniChart title="Rainfall" subtitle="Monthly total vs the median for that month"
        data={[
          { x: climate.rain.x, y: climate.rain.y, type: 'bar', name: 'Monthly total', marker: { color: '#4285f4' } },
          { x: climate.rain.x, y: climate.rainMedian, type: 'scatter', mode: 'lines', name: 'Median for month', line: { color: '#202124', width: 1, dash: 'dot' } },
        ]} layout={{ ...timeLayout, yaxis: { title: { text: 'mm' } }, bargap: 0.15 }} source="NASA POWER (PRECTOTCORR)" />
      <MiniChart title="Sunlight and cloud" subtitle="Monthly means"
        data={[
          { x: climate.solar.x, y: climate.solar.y, type: 'scatter', mode: 'lines', name: 'Solar radiation (kWh/m²/day)', line: { color: '#f9ab00', width: 1.6 } },
          { x: climate.cloud.x, y: climate.cloud.y, type: 'scatter', mode: 'lines', name: 'Cloud cover (%)', yaxis: 'y2', line: { color: '#80868b', width: 1.4 } },
        ]} layout={{ ...timeLayout, yaxis2: { overlaying: 'y', side: 'right', showgrid: false, range: [0, 100] }, margin: { l: 42, r: 34, t: 26, b: 28 } }}
        source="NASA POWER (ALLSKY_SFC_SW_DWN, CLOUD_AMT)" />
      <MiniChart title="Humidity and soil moisture" subtitle="Monthly means"
        data={[
          { x: climate.rh.x, y: climate.rh.y, type: 'scatter', mode: 'lines', name: 'Relative humidity (%)', line: { color: '#12b5cb', width: 1.6 } },
          { x: climate.soil.x, y: climate.soil.y.map((v) => (v == null ? null : v * 100)), type: 'scatter', mode: 'lines', name: 'Root-zone soil wetness (%)', line: { color: '#795548', width: 1.6 } },
        ]} layout={{ ...timeLayout, yaxis: { range: [0, 100] } }} source="NASA POWER (RH2M, GWETROOT)" />
      <MiniChart title="Wind" subtitle="Monthly mean speed at 2 m"
        data={[{ x: climate.wind.x, y: climate.wind.y, type: 'scatter', mode: 'lines', name: 'Wind (m/s)', fill: 'tozeroy', fillcolor: 'rgba(66,133,244,0.12)', line: { color: '#4285f4', width: 1.4 } }]}
        layout={{ ...timeLayout, yaxis: { title: { text: 'm/s' } } }} height={170} source="NASA POWER (WS2M)" />
      <MiniChart title="Burned area" subtitle="Share of the area mapped as burned each month" loading={burned.loading} error={burned.error}
        data={[{ x: burned.points.map((p) => p.date), y: burned.points.map((p) => (p.burned_fraction == null ? null : p.burned_fraction * 100)), type: 'bar', name: 'Burned (%)', marker: { color: '#d93025' } }]}
        layout={{ ...timeLayout, yaxis: { title: { text: '%' }, rangemode: 'tozero' } }} height={170} source="MODIS MCD64A1 v061" />
      <MiniChart title="Land cover by year" subtitle="Share of pixels per IGBP class" loading={landcover.loading} error={landcover.error}
        data={lcClasses.map((c) => ({
          x: lcYears, y: landcover.points.map((p) => (p.classes[c] ?? 0) * 100), type: 'bar', name: c,
          marker: { color: IGBP_COLORS[c] ?? '#999' }, hovertemplate: `${c}: %{y:.0f}%<extra></extra>`,
        }) as Plotly.Data)}
        layout={{ barmode: 'stack', yaxis: { range: [0, 100], title: { text: '%' } }, hovermode: 'closest', legend: { orientation: 'h', y: -0.25, x: 0, font: { size: 9.5 } }, margin: { l: 42, r: 6, t: 6, b: 90 } }}
        height={300} empty="Land cover is published yearly with a lag; none for this period yet." source="MODIS MCD12Q1 v061 (annual, 500 m)" />
    </div>
  )
}

function shift(date: string, days: number) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
