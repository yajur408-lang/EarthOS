type PlotlyModule = typeof import('plotly.js-dist-min')
let plotlyPromise: Promise<PlotlyModule> | null = null
export const loadPlotly = () => (plotlyPromise ??= import('plotly.js-dist-min'))

export const CHART = {
  text: '#3c4043',
  grid: '#eceff1',
  font: 'Roboto, system-ui, sans-serif',
}
