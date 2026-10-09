import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// CesiumJS ships Web Workers, widgets CSS and assets that must be served as static files.
// See https://cesium.com/learn/cesiumjs-learn/cesiumjs-quickstart/ (Vite section).
const cesiumSource = 'node_modules/cesium/Build/Cesium'
const cesiumBaseUrl = 'cesiumStatic'

export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`),
  },
  plugins: [
    react(),
    viteStaticCopy({
      // Directory structure is preserved, so strip "node_modules/cesium/Build/Cesium".
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((dir) => ({
        src: `${cesiumSource}/${dir}`,
        dest: cesiumBaseUrl,
        rename: { stripBase: 4 },
      })),
    }),
  ],
  server: {
    // The browser only ever talks to our own API; keyed services stay server-side.
    proxy: { '/api': 'http://localhost:8000' },
    // OneDrive-synced folders can swallow file-change events; polling keeps hot reload reliable.
    watch: { usePolling: true, interval: 300 },
  },
})
