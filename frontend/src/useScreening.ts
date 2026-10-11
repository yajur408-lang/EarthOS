import { useEffect, useState } from 'react'
import { api, type ChangeStatus, type HazardType, type LossStatus, type Screening } from './api'
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

/** A 30 m before/after change check for one event: asks for status, starts it on request, polls while it runs. */
export function useChangeJob(place: { lat: number; lon: number } | null, sel: { hazard: HazardType; date: string } | null) {
  const key = place && sel ? `${place.lat},${place.lon},${sel.hazard},${sel.date}` : null
  const [state, setState] = useState<{ key: string; status: ChangeStatus } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [startReq, setStartReq] = useState<string | null>(null)
  useEffect(() => {
    if (!key || !place || !sel) return
    let stop = false
    ;(async () => {
      let first = true
      while (!stop) {
        try {
          const st = await api.hazardChange({ lat: place.lat, lon: place.lon, hazard: sel.hazard, date: sel.date, start: first && startReq === key })
          if (stop) return
          setState({ key, status: st })
          if (st.status !== 'running' && st.status !== 'queued') return
        } catch {
          /* keep polling */
        }
        first = false
        await new Promise((r) => setTimeout(r, 4000))
      }
    })()
    return () => {
      stop = true
    }
  }, [key, nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  const status = state && state.key === key ? state.status : null
  return {
    status,
    loading: !!key && !status,
    run: () => {
      setStartReq(key)
      setNonce((n) => n + 1)
    },
  }
}
