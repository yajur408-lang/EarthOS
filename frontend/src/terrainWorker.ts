// Decodes Terrarium elevation PNGs off the main thread so panning and zooming never stutter.
// Height (m) = R*256 + G + B/256 - 32768.
interface Job {
  id: number
  url: string
  samples: number
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, url, samples } = e.data
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`terrain ${res.status}`)
    const bmp = await createImageBitmap(await res.blob())
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bmp, 0, 0)
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    bmp.close()
    const out = new Float32Array(samples * samples)
    const step = (canvas.width - 1) / (samples - 1)
    for (let j = 0; j < samples; j++) {
      const row = Math.round(j * step) * canvas.width
      for (let i = 0; i < samples; i++) {
        const o = (row + Math.round(i * step)) * 4
        // Show the sea surface rather than the sea floor, as Google Earth does.
        out[j * samples + i] = Math.max(px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768, 0)
      }
    }
    ;(self as unknown as Worker).postMessage({ id, heights: out }, [out.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: String(err) })
  }
}
