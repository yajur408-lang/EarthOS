export const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

export const shiftDate = (d: string, days: number) => {
  const t = new Date(d + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() + days)
  return t.toISOString().slice(0, 10)
}

export const prettyDate = (d: string) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** Signed fixed-point number, or an en dash when missing. */
export function fmt(v: number | null | undefined, nd = 2, signed = true) {
  return v == null ? '–' : (signed && v >= 0 ? '+' : '') + v.toFixed(nd)
}

export function fmtLatLon(lat: number, lon: number, nd = 4) {
  return `${Math.abs(lat).toFixed(nd)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(nd)}°${lon >= 0 ? 'E' : 'W'}`
}

export function fmtDistance(m: number) {
  return m >= 10_000 ? `${Math.round(m / 1000).toLocaleString()} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

/** Accepts "lat, lon", "lat lon", and hemisphere forms like "9.9N 84.1W". */
export function parseLatLon(text: string): { lat: number; lon: number } | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?$/)
  if (!m) return null
  let lat = +m[1], lon = +m[3]
  if (m[2]?.toUpperCase() === 'S') lat = -Math.abs(lat)
  if (m[4]?.toUpperCase() === 'W') lon = -Math.abs(lon)
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
}

/** Camera height for a comfortable view of a pin's averaging box. */
export const viewHeightFor = (km: number) => Math.max(12_000, km * 16_000)
