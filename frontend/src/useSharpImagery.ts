import { useEffect, useState } from 'react'
import { api, type HlsPass } from './api'
import type { Bus } from './bus'
import type { ViewState } from './components/Globe'
import { useFetch } from './useFetch'

/** Camera height below which the 30 m layer is used. */
export const SHARP_BELOW_M = 300_000
const REQUERY_KM = 40
const DAY = 86_400_000

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)) * 111

/** Days between a pass and the chosen date (positive = pass is before the date). */
export const daysBefore = (pass: HlsPass, date: string) => Math.round((Date.parse(date) - Date.parse(pass.date)) / DAY)

/**
 * Passes ranked for a chosen date: clear passes close to the date first. Passes after the date get a heavier
 * penalty (they show the future relative to what you're looking at).
 */
export function rankPasses(passes: HlsPass[], date: string): HlsPass[] {
  const score = (p: HlsPass) => {
    const d = daysBefore(p, date)
    return p.cloud_pct + (d >= 0 ? d * 0.4 : -d * 1.0)
  }
  return [...passes].sort((a, b) => score(a) - score(b))
}

/**
 * Tracks the view centre and finds the clearest 30 m HLS pass near the chosen date.
 * Re-queries only after the camera settles and has moved ~40 km, or when the month changes.
 */
export function useSharpImagery(view: Bus<ViewState>, enabled: boolean, date: string) {
  const [anchor, setAnchor] = useState<{ lat: number; lon: number } | null>(null)
  useEffect(() => {
    // Wait until the camera settles: during a fly-to the centre sweeps hundreds of km.
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = view.subscribe((v) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!enabled || !v.centre || v.heightM > SHARP_BELOW_M) return
        const c = { lat: +v.centre.lat.toFixed(2), lon: +v.centre.lon.toFixed(2) }
        setAnchor((prev) => (!prev || km(prev, c) > REQUERY_KM ? c : prev))
      }, 500)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [view, enabled])

  // Passes are searched in a window around the date (rounded to mid-month, so stepping days reuses results).
  const month = date.slice(0, 7) + '-15'
  const key = enabled && anchor ? `${anchor.lat},${anchor.lon},${month}` : null
  const res = useFetch(key, (s) => api.sharp(anchor!.lat, anchor!.lon, month, s))
  const [override, setOverride] = useState<{ key: string; pass: HlsPass } | null>(null)
  const passes = res.data?.passes ?? []
  const ranked = rankPasses(passes, date)
  const pass = override && override.key === key ? override.pass : ranked[0] ?? null
  // A single pass only covers its satellite's swath; the next-best pass fills the gaps beneath it.
  const fill = ranked.find((p) => pass && (p.date !== pass.date || p.sensor !== pass.sensor)) ?? null
  return {
    pass,
    fill,
    passes: ranked,
    loading: res.loading,
    error: res.error,
    choose: (p: HlsPass) => key && setOverride({ key, pass: p }),
  }
}
