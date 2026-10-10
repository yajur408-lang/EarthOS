import { Credit, CustomHeightmapTerrainProvider, WebMercatorTilingScheme } from 'cesium'
import { PROFILE } from './perf'
// `?worker` makes Vite bundle the worker as its own file in production builds.
import TerrainWorker from './terrainWorker.ts?worker'

// Open Terrain Tiles (Terrarium PNG encoding), public on AWS with CORS.
// Attribution: https://github.com/tilezen/joerd/blob/master/docs/attribution.md
const TILE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium'

export const TERRAIN_CREDIT =
  'Terrain: Terrain Tiles (Mapzen/AWS) · USGS 3DEP, SRTM, GMTED2010 · ETOPO1 (NOAA) · EU-DEM (Copernicus) · Geoscience Australia · Kartverket · LINZ · and others'

// The globe draws on demand, and Cesium only knows about its own downloads. Terrain decoded here
// must ask for a redraw, or freshly loaded tiles would wait until the camera next moves.
let onTileReady: () => void = () => {}
export function setTerrainRedraw(fn: () => void) {
  onTileReady = fn
}

/** Terrarium PNG -> heights grid (metres). Height = R*256 + G + B/256 - 32768; sea floor clamped to 0. */
async function decodeOnMainThread(url: string, samples: number): Promise<Float32Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`terrain ${res.status}`)
  const bmp = await createImageBitmap(await res.blob())
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  const out = new Float32Array(samples * samples)
  const step = (bmp.width - 1) / (samples - 1)
  for (let j = 0; j < samples; j++) {
    const row = Math.round(j * step) * bmp.width
    for (let i = 0; i < samples; i++) {
      const o = (row + Math.round(i * step)) * 4
      out[j * samples + i] = Math.max(px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768, 0)
    }
  }
  return out
}

// A small pool of decoder workers keeps PNG decoding off the main (rendering) thread.
// If workers can't start, decoding falls back to the main thread rather than leaving the globe blank.
type Job = { url: string; samples: number; resolve: (h: Float32Array) => void; reject: (e: Error) => void }
let pool: Worker[] | null = null
let workersBroken = typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined'
let next = 0
let jobId = 0
const pending = new Map<number, Job>()

function fallback(job: Job) {
  decodeOnMainThread(job.url, job.samples).then(job.resolve, job.reject).finally(() => setTimeout(onTileReady, 0))
}

function workers(): Worker[] | null {
  if (workersBroken) return null
  if (pool) return pool
  try {
    const n = Math.min(Math.max((navigator.hardwareConcurrency ?? 4) - 2, 1), 3)
    pool = Array.from({ length: n }, () => {
      const w = new TerrainWorker()
      w.onmessage = (e: MessageEvent<{ id: number; heights?: Float32Array; error?: string }>) => {
        const job = pending.get(e.data.id)
        if (!job) return
        pending.delete(e.data.id)
        if (e.data.heights) job.resolve(e.data.heights)
        else job.reject(new Error(e.data.error ?? 'terrain decode failed'))
        // Resolve first, then redraw on the next frame so Cesium picks the tile up.
        setTimeout(onTileReady, 0)
      }
      w.onerror = () => {
        // The worker script failed to load or crashed: decode everything on the main thread from now on.
        workersBroken = true
        pool?.forEach((p) => p.terminate())
        pool = null
        const jobs = [...pending.values()]
        pending.clear()
        jobs.forEach(fallback)
      }
      return w
    })
    return pool
  } catch {
    workersBroken = true
    return null
  }
}

function heights(x: number, y: number, level: number): Promise<Float32Array> {
  const url = `${TILE_URL}/${level}/${x}/${y}.png`
  const samples = PROFILE.terrainSamples
  return new Promise((resolve, reject) => {
    const job: Job = { url, samples, resolve, reject }
    const ws = workers()
    if (!ws) return fallback(job)
    const id = ++jobId
    pending.set(id, job)
    ws[next++ % ws.length].postMessage({ id, url, samples })
  })
}

export function createTerrainProvider() {
  return new CustomHeightmapTerrainProvider({
    width: PROFILE.terrainSamples,
    height: PROFILE.terrainSamples,
    tilingScheme: new WebMercatorTilingScheme(),
    credit: new Credit(TERRAIN_CREDIT),
    // Returning undefined marks a tile unavailable; Cesium then upsamples the parent.
    callback: (x, y, level) => (level > PROFILE.terrainMaxLevel ? undefined : heights(x, y, level)),
  })
}
