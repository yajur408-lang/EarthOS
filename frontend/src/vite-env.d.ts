/// <reference types="vite/client" />
declare const CESIUM_BASE_URL: string
interface ImportMetaEnv {
  /** Backend origin in production, e.g. https://api.earthos.app (empty = same origin / dev proxy). */
  readonly VITE_API_BASE?: string
}
