import { Credit, CustomHeightmapTerrainProvider, WebMercatorTilingScheme } from 'cesium'

// Open Terrain Tiles (Terrarium PNG: height = R*256 + G + B/256 - 32768 m), public on AWS with CORS.
// Attribution: https://github.com/tilezen/joerd/blob/master/docs/attribution.md
const URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium'
const SAMPLES = 65
const MAX_LEVEL = 14

export const TERRAIN_CREDIT =
  'Terrain: Terrain Tiles (Mapzen/AWS) · USGS 3DEP, SRTM, GMTED2010 · ETOPO1 (NOAA) · EU-DEM (Copernicus) · Geoscience Australia · Kartverket · LINZ · and others'

async function heights(x: number, y: number, level: number): Promise<Float32Array> {
  const res = await fetch(`${URL}/${level}/${x}/${y}.png`)
  if (!res.ok) throw new Error(`terrain ${res.status}`)
  const bmp = await createImageBitmap(await res.blob())
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  const out = new Float32Array(SAMPLES * SAMPLES)
  const step = (bmp.width - 1) / (SAMPLES - 1)
  for (let j = 0; j < SAMPLES; j++) {
    for (let i = 0; i < SAMPLES; i++) {
      const o = (Math.round(j * step) * bmp.width + Math.round(i * step)) * 4
      const h = px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768
      // Show the sea surface rather than the sea floor, as Google Earth does.
      out[j * SAMPLES + i] = Math.max(h, 0)
    }
  }
  return out
}

export function createTerrainProvider() {
  return new CustomHeightmapTerrainProvider({
    width: SAMPLES,
    height: SAMPLES,
    tilingScheme: new WebMercatorTilingScheme(),
    credit: new Credit(TERRAIN_CREDIT),
    // Returning undefined marks a tile unavailable; Cesium then upsamples the parent.
    callback: (x, y, level) => (level > MAX_LEVEL ? undefined : heights(x, y, level)),
  })
}
