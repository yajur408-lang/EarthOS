import { useEffect, useState } from 'react'
import { api, type HlsPass } from './api'
import type { Bus } from './bus'
import type { ViewState } from './components/Globe'
import { useFetch } from './useFetch'

/** Camera height below which the 30 m layer is used. */
export const SHARP_BELOW_M = 300_000
const REQUERY_KM = 40

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)) * 111

/** Passes ranked clearest first, with a mild preference for recent dates. */
export function rankPasses(passes: HlsPass[]): HlsPass[] {
  const now = Date.now()
  const score = (p: HlsPass) => p.cloud_pct + ((now - Date.parse(p.date)) / 86_400_000) * 0.05
  return [...passes].sort((a, b) => score(a) - score(b))
}

/**
 * Tracks the view centre and finds the clearest recent 30 m HLS pass there.
 * Re-queries only after the view moves ~40 km, so panning around doesn't spam NASA CMR.
 */
export function useSharpImagery(view: Bus<ViewState>, enabled: boolean) {
  const [anchor, setAnchor] = useState<{ lat: number; lon: number } | null>(null)
  useEffect(() => view.subscribe((v) => {
    if (!enabled || !v.centre || v.heightM > SHARP_BELOW_M) return
    const c = { lat: +v.centre.lat.toFixed(2), lon: +v.centre.lon.toFixed(2) }
    setAnchor((prev) => (!prev || km(prev, c) > REQUERY_KM ? c : prev))
  }), [view, enabled])

  const key = enabled && anchor ? `${anchor.lat},${anchor.lon}` : null
  const res = useFetch(key, (s) => api.sharp(anchor!.lat, anchor!.lon, s))
  const [override, setOverride] = useState<{ key: string; pass: HlsPass } | null>(null)
  const passes = res.data?.passes ?? []
  const ranked = rankPasses(passes)
  const pass = override && override.key === key ? override.pass : ranked[0] ?? null
  // A single pass only covers its satellite's swath; the next-clearest pass fills the gaps beneath it.
  const fill = ranked.find((p) => pass && (p.date !== pass.date || p.sensor !== pass.sensor)) ?? null
  return {
    pass,
    fill,
    passes,
    loading: res.loading,
    error: res.error,
    choose: (p: HlsPass) => key && setOverride({ key, pass: p }),
  }
}
