type PlotlyModule = typeof import('plotly.js-dist-min')
let plotlyPromise: Promise<PlotlyModule> | null = null
export const loadPlotly = () => (plotlyPromise ??= import('plotly.js-dist-min'))

export const CHART = {
  text: '#47535f',
  grid: '#e9edf0',
  font: "'IBM Plex Sans', system-ui, sans-serif",
}
