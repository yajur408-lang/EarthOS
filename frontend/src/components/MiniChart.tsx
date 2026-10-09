import { useEffect, useRef } from 'react'
import { CHART, loadPlotly } from '../plotly'

interface Props {
  title: string
  subtitle?: string
  source?: string
  data: Plotly.Data[] | null
  layout?: Partial<Plotly.Layout>
  height?: number
  loading?: boolean
  error?: string | null
  empty?: string
  onPointClick?: (x: string) => void
}

/** A titled, theme-consistent Plotly chart card. */
export default function MiniChart({ title, subtitle, source, data, layout, height = 220, loading, error, empty, onPointClick }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const hasData = !!data && data.some((d) => ((d as { x?: unknown[] }).x?.length ?? (d as { z?: unknown[] }).z?.length ?? 0) > 0)

  useEffect(() => {
    // Draw only once visible: Plotly sizes itself from the container, which is 0 while hidden.
    if (!hasData || loading || error || !ref.current) return
    let cancelled = false
    const el = ref.current
    loadPlotly().then((Plotly) => {
      if (cancelled) return
      const base: Partial<Plotly.Layout> = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: CHART.text, size: 10.5, family: CHART.font },
        margin: { l: 42, r: 10, t: 6, b: 28 },
        height,
        hovermode: 'x unified',
        showlegend: (data?.filter((d) => (d as { showlegend?: boolean }).showlegend !== false).length ?? 0) > 1,
        legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 10 } },
        xaxis: { gridcolor: CHART.grid, zeroline: false },
        yaxis: { gridcolor: CHART.grid, zeroline: false },
      }
      const merged = { ...base, ...layout, xaxis: { ...base.xaxis, ...layout?.xaxis }, yaxis: { ...base.yaxis, ...layout?.yaxis } }
      if (merged.showlegend) merged.margin = { ...merged.margin, t: 26 }
      Plotly.react(el, data!, merged, { displayModeBar: false, responsive: true })
      const plot = el as unknown as Plotly.PlotlyHTMLElement
      plot.removeAllListeners?.('plotly_click')
      if (onPointClick) plot.on('plotly_click', (ev) => ev.points[0] && onPointClick(String(ev.points[0].x).slice(0, 10)))
    })
    return () => {
      cancelled = true
    }
  }, [data, layout, height, hasData, loading, error, onPointClick])

  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) loadPlotly().then((P) => P.purge(el))
    }
  }, [])

  return (
    <section className="mini">
      <header>
        <h4>{title}</h4>
        {subtitle && <span>{subtitle}</span>}
      </header>
      {loading && <div className="mini-state" style={{ height }}><span className="spinner" aria-hidden /> Loading…</div>}
      {!loading && error && <div className="mini-state" style={{ height: 60 }}>{error}</div>}
      {!loading && !error && !hasData && <div className="mini-state" style={{ height: 60 }}>{empty ?? 'No data for this place and period.'}</div>}
      <div ref={ref} style={{ display: !loading && !error && hasData ? 'block' : 'none' }} />
      {source && <footer>{source}</footer>}
    </section>
  )
}
