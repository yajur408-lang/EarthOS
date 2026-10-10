// Rendering budget per device class. Phones get fewer pixels and coarser tiles so the globe stays smooth.
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
export const isMobile = coarse || (typeof window !== 'undefined' && window.innerWidth < 760)
const lowPower = isMobile || (typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= 4)

export const PROFILE = {
  /** Max device-pixel ratio to render at (screens are often 2-3x; rendering all those pixels is the biggest GPU cost). */
  maxPixelRatio: isMobile ? 1.25 : lowPower ? 1.5 : 1.75,
  /** Cesium's tile-detail threshold: higher = coarser tiles, fewer downloads. Default is 2. */
  screenSpaceError: isMobile ? 2.5 : lowPower ? 2 : 1.5,
  terrainSamples: isMobile ? 33 : 65,
  terrainMaxLevel: isMobile ? 12 : 14,
  /** Second 30 m pass layered underneath to fill swath gaps (twice the tile downloads). */
  sharpFill: !lowPower,
  antialias: !isMobile,
}
