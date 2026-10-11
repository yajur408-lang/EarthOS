// Field inspection sheets: export the ranked squares for a local team, and read their findings back in.
import type { InspectSite, Priority } from './api'
import { downloadBlob } from './exporters'

export const FINDINGS = ['signs_seen', 'no_signs', 'unsure', 'not_accessible'] as const
export type Finding = (typeof FINDINGS)[number]
const SIGNS = 'cracks in ground or walls; tilted trees, posts or walls; seepage or springs; recent erosion or scarps; debris or blocked drains; water marks'

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const osm = (s: InspectSite) => `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`

export function exportFieldCsv(place: string, p: Priority) {
  const head = ['site_id', 'kind', 'rank', 'score', 'centre_lat', 'centre_lon', 'south', 'north', 'west', 'east', 'high_susceptibility_ha',
    'why_listed', 'map_link', 'inspected_by', 'inspection_date', `finding (${FINDINGS.join(' / ')})`, `signs_seen (${SIGNS})`, 'notes', 'photo_refs']
  const rows = p.sites.map((s) => [s.id, s.kind, s.rank, s.score, s.lat, s.lon, ...s.bbox, s.area_ha, s.reasons.join('; '), osm(s), '', '', '', '', '', ''])
  const meta = [
    `# EarthOS field inspection sheet - ${place} - generated ${new Date().toISOString().slice(0, 10)}`,
    `# Screening tool, not an official warning. Squares are ${p.sites[0]?.square_m ?? 250} m; rank 1 = inspect first. Do not enter unsafe slopes or flowing water.`,
    '# Fill in the last six columns on site, then import this file on the EarthOS Hazards tab to see how many listed squares showed signs.',
  ]
  const text = [...meta, head.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n')
  downloadBlob(`earthos-field-sheet-${slug(place)}.csv`, new Blob([text], { type: 'text/csv;charset=utf-8' }))
}

export function exportFieldGeoJson(place: string, p: Priority) {
  const fc = {
    type: 'FeatureCollection',
    name: `EarthOS inspection squares - ${place}`,
    features: p.sites.map((s) => {
      const [south, north, west, east] = s.bbox
      return {
        type: 'Feature',
        properties: { site_id: s.id, kind: s.kind, rank: s.rank, score: s.score, why_listed: s.reasons.join('; '), high_susceptibility_ha: s.area_ha },
        geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
      }
    }),
  }
  downloadBlob(`earthos-inspection-squares-${slug(place)}.geojson`, new Blob([JSON.stringify(fc, null, 1)], { type: 'application/geo+json' }))
}

export function printFieldSheet(place: string, p: Priority) {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
  const rows = p.sites.map((s) => `<tr><td><b>${s.id}</b></td><td>${s.kind}</td><td>${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</td>
    <td>${esc(s.reasons.join('; '))}</td><td class="fill"></td><td class="fill"></td><td class="fill wide"></td></tr>`).join('')
  const html = `<!doctype html><meta charset="utf-8"><title>EarthOS field sheet - ${esc(place)}</title>
<style>body{font:12px system-ui,sans-serif;margin:16px}h1{font-size:18px;margin:0 0 4px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #999;padding:4px;vertical-align:top;text-align:left}.fill{width:70px}.wide{width:200px}p{margin:4px 0}</style>
<h1>EarthOS field inspection sheet - ${esc(place)}</h1>
<p><b>Screening tool, not an official warning.</b> Squares of ${p.sites[0]?.square_m ?? 250} m, ranked separately for slopes (L) and stream corridors (F). Never enter unsafe slopes or flowing water; report danger to the CNE / municipality.</p>
<p>Finding: S = signs seen, N = no signs, U = unsure, X = not accessible. Signs to look for: ${SIGNS}.</p>
<table><tr><th>Site</th><th>Kind</th><th>Centre (lat, lon)</th><th>Why listed</th><th>Finding</th><th>Date / by</th><th>Signs and notes</th></tr>${rows}</table>
<p>Generated ${new Date().toISOString().slice(0, 10)} from open data: SRTM terrain, ESA WorldCover 2021, NASA HLS, NASA POWER, NASA Global Landslide Catalog.</p>
<script>window.onload=()=>window.print()</script>`
  const w = window.open('', '_blank')
  if (w) {
    w.document.write(html)
    w.document.close()
  }
}

export interface FieldSummary {
  rows: number
  matched: number
  byKind: Record<string, { inspected: number; signs: number; none: number; unsure: number; inaccessible: number }>
  topHalfSignsRate: number | null
  bottomHalfSignsRate: number | null
  unknownIds: string[]
}

/** Read a completed field sheet (the CSV exported above, edited in any spreadsheet). */
export function readFieldCsv(text: string, sites: InspectSite[]): FieldSummary {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
  const parse = (line: string) => {
    const out: string[] = []
    let cur = '', q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false
        else cur += c
      } else if (c === '"') q = true
      else if (c === ',') { out.push(cur); cur = '' } else cur += c
    }
    out.push(cur)
    return out
  }
  const head = parse(lines[0] ?? '').map((h) => h.toLowerCase())
  const iId = head.findIndex((h) => h.startsWith('site_id'))
  const iFinding = head.findIndex((h) => h.startsWith('finding'))
  const byId = new Map(sites.map((s) => [s.id, s]))
  const byKind: FieldSummary['byKind'] = {}
  const unknownIds: string[] = []
  const ranked: { rank: number; kind: string; signs: boolean }[] = []
  let matched = 0
  for (const line of lines.slice(1)) {
    const cells = parse(line)
    const id = (cells[iId] ?? '').trim()
    const raw = (cells[iFinding] ?? '').trim().toLowerCase()
    if (!id || !raw) continue
    const site = byId.get(id)
    if (!site) { unknownIds.push(id); continue }
    const f: Finding | null = raw.startsWith('sign') || raw === 's' || raw === 'yes' ? 'signs_seen'
      : raw.startsWith('no') || raw === 'n' ? 'no_signs'
        : raw.startsWith('uns') || raw === 'u' ? 'unsure'
          : raw.startsWith('not') || raw === 'x' ? 'not_accessible' : null
    if (!f) continue
    matched++
    const k = (byKind[site.kind] ??= { inspected: 0, signs: 0, none: 0, unsure: 0, inaccessible: 0 })
    if (f === 'not_accessible') { k.inaccessible++; continue }
    k.inspected++
    if (f === 'signs_seen') k.signs++
    else if (f === 'no_signs') k.none++
    else k.unsure++
    if (f !== 'unsure') ranked.push({ rank: site.rank, kind: site.kind, signs: f === 'signs_seen' })
  }
  // Does rank mean anything? Compare the top and bottom half of each list among decided inspections.
  const half = (top: boolean) => {
    const sel = ranked.filter((r) => (top ? r.rank <= 12 : r.rank > 12))
    return sel.length ? sel.filter((r) => r.signs).length / sel.length : null
  }
  return { rows: lines.length - 1, matched, byKind, topHalfSignsRate: half(true), bottomHalfSignsRate: half(false), unknownIds }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'place'
