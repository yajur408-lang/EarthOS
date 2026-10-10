import { useEffect, useState } from 'react'
import { api, type LossStatus, type Screening } from './api'
import { useFetch } from './useFetch'

/**
 * Hazard screening for a place: susceptibility + rainfall trigger at once, then the forest-loss watch,
 * which can take minutes on a first visit, polled every few seconds until it finishes.
 */
export function useScreening(place: { lat: number; lon: number; country: string | null } | null, enabled: boolean) {
  const key = enabled && place ? `${place.lat},${place.lon},${place.country ?? ''}` : null
  const res = useFetch<Screening>(key, (s) => api.screening({ lat: place!.lat, lon: place!.lon, country: place!.country ?? undefined }, s))
  const [loss, setLoss] = useState<{ key: string; status: LossStatus } | null>(null)

  const initial = res.data?.forest_loss ?? null
  const running = (loss && loss.key === key ? loss.status : initial)?.status === 'running'
  useEffect(() => {
    if (!key || !res.data || !running) return
    const a = res.data.area
    const end = res.data.forest_loss.end
    let stop = false
    const tick = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 4000))
        if (stop) return
        try {
          const st = await api.forestLoss({ lat: a.lat, lon: a.lon, half_km: a.half_km, end })
          if (stop) return
          setLoss({ key, status: { ...st, overlay: res.data!.forest_loss.overlay } })
          if (st.status !== 'running') return
        } catch {
          /* keep polling */
        }
      }
    }
    tick()
    return () => {
      stop = true
    }
  }, [key, res.data, running])

  const lossStatus = loss && loss.key === key ? loss.status : initial
  return { ...res, loss: lossStatus }
}
