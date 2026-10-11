import { useEffect, useState } from 'react'
import { api, type LossStatus, type Screening } from './api'
import { useFetch } from './useFetch'

/**
 * Hazard screening for a place on a chosen day: susceptibility + the rainfall trigger for that day at once, then the
 * forest-loss watch for the 90 days up to it. That job can take minutes on a first run; it is polled until it finishes.
 * Recent days run it automatically; older days run it when `runLoss` is called.
 */
export function useScreening(place: { lat: number; lon: number; country: string | null } | null, enabled: boolean, date: string) {
  const key = enabled && place ? `${place.lat},${place.lon},${place.country ?? ''},${date}` : null
  const res = useFetch<Screening>(key, (s) => api.screening({ lat: place!.lat, lon: place!.lon, country: place!.country ?? undefined, date }, s))
  const [loss, setLoss] = useState<{ key: string; status: LossStatus } | null>(null)
  const [nonce, setNonce] = useState(0)

  const initial = res.data?.forest_loss ?? null
  const status = loss && loss.key === key ? loss.status : initial
  const busy = status?.status === 'running' || status?.status === 'queued'

  useEffect(() => {
    if (!key || !res.data || !busy) return
    const a = res.data.area
    const end = res.data.forest_loss.end!
    let stop = false
    ;(async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 4000))
        if (stop) return
        try {
          const st = await api.forestLoss({ lat: a.lat, lon: a.lon, half_km: a.half_km, end })
          if (stop) return
          setLoss({ key, status: st })
          if (st.status !== 'running' && st.status !== 'queued') return
        } catch {
          /* keep polling */
        }
      }
    })()
    return () => {
      stop = true
    }
  }, [key, res.data, busy, nonce])

  const runLoss = async () => {
    if (!key || !res.data?.forest_loss.end) return
    const a = res.data.area
    const st = await api.forestLoss({ lat: a.lat, lon: a.lon, half_km: a.half_km, end: res.data.forest_loss.end, start: true })
    setLoss({ key, status: st })
    setNonce((n) => n + 1)
  }

  return { ...res, loss: status, runLoss }
}
