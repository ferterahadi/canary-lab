import { flowSections, layoutTestFlow } from '../../../../../../../shared/test-view/flow-layout'
import { shortSourceLocation } from '../../../../../../../shared/lib/source-location'
import type { ReadableTest } from '../../../../../../../shared/readable-tests/types'
import type { HistoricalFlow } from './types'
import { wrapSvgText } from './flowchart-svg'
import { escapeAttr, escapeHtml } from './text'

/** Local fragments work in a saved HTML file, including without JavaScript.
 * Only boxes with a source get a link; structural boundaries have none. */
export function renderVisualFlow(test: ReadableTest, caseIndex: number, history?: HistoricalFlow): string | undefined {
  const graph = test.graph
  if (graph?.schemaVersion !== 1) return undefined
  const charts = flowSections(test.nodes, graph).map((section, sectionIndex) => {
    if (!section.topology) return ''
    const chart = layoutTestFlow(section.nodes, section.topology)
    const prefix = `visual-${caseIndex}-${sectionIndex}`
    const sources: string[] = []
    const edges = chart.edges.map(edge => `<g><polyline points="${edge.points.map(p => p.x + ',' + p.y).join(' ')}" fill="none" stroke="var(--flow-line)" marker-end="url(#${prefix}-arrow)" />
      ${edge.label ? `<text x="${edge.x}" y="${edge.y}" text-anchor="middle">${escapeHtml(edge.label)}</text>` : ''}</g>`).join('')
    const boxes = chart.nodes.map((box, i) => {
      const { width: w, height: h } = box
      const shape = box.shape === 'decision' ? `<polygon points="${w/2},0 ${w},${h/2} ${w/2},${h} 0,${h/2}"/>`
        : box.shape === 'io' ? `<polygon points="12,0 ${w},0 ${w-12},${h} 0,${h}"/>`
        : `<rect width="${w}" height="${h}" rx="${box.shape === 'terminal' ? h/2 : 2}"/>`
      const label = (box.shape === 'check' ? '✓ ' : '') + box.label
      const lines = wrapSvgText(label, box.shape === 'decision' ? 15 : 22)
      const text = lines.map((line, j) => `<tspan x="${w/2}" y="${h/2 + (j-(lines.length-1)/2)*13+4}">${escapeHtml(line)}</tspan>`).join('')
      const source = box.source?.source
      const id = prefix + '-source-' + i
      const visit = history?.visits[section.id]?.[box.id]
      const observations = visit ? [
        visit.completed && `Observed ×${visit.completed}`, visit.failed && `Failed ×${visit.failed}`,
        visit.skipped && `Skipped ×${visit.skipped}`,
      ].filter(Boolean).join(' · ') : ''
      if (source) {
        const location = shortSourceLocation(source.file + ':' + source.startLine)
        sources.push(`<div id="${id}" tabindex="-1"><strong>${escapeHtml(location)}–${source.endLine}</strong>
          ${observations ? `<p>${observations}</p>` : ''}<pre><code>${escapeHtml(source.snippet)}</code></pre><a href="#${id}-box">Back to diagram</a></div>`)
      }
      const tone = box.shape === 'check' ? 'assert' : 'neutral'
      const content = `<title>${escapeHtml([label, box.reason, observations].filter(Boolean).join(' · '))}</title><g fill="var(--flow-${tone}-fill)" stroke="var(--flow-${tone}-line)">${shape}</g>
        <text text-anchor="middle">${text}</text>${observations ? `<text x="${w/2}" y="${h-2}" text-anchor="middle">${observations}</text>` : ''}`
      return `<g transform="translate(${box.x-w/2},${box.y-h/2})">${source ? `<a id="${id}-box" href="#${id}" aria-label="${escapeAttr('Inspect source for ' + label)}">${content}</a>` : content}</g>`
    }).join('')
    const body = `<div class="visual-diagram"><svg xmlns="http://www.w3.org/2000/svg" width="${chart.width}" height="${chart.height}" viewBox="0 0 ${chart.width} ${chart.height}" role="group" aria-label="${escapeAttr(section.label)}">
      <defs><marker id="${prefix}-arrow" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8z" fill="var(--flow-line)"/></marker></defs>
      ${edges}${boxes}</svg></div>${sources.length ? `<details class="drawer"><summary>Source excerpts (${sources.length})</summary>${sources.join('')}</details>` : ''}`
    return sectionIndex === 0 ? body : `<details class="drawer"><summary>${escapeHtml(section.label)} · ${sources.length} source ${sources.length === 1 ? 'step' : 'steps'}</summary>${body}</details>`
  })
  const provenance = graph.origin.kind === 'recorded-run' ? 'Retained suite for run ' + graph.origin.runId : 'Working tree at export'
  const evidence = history ? `Attempt ${history.attempt} · ${Object.keys(history.visits).length ? 'recorded step observations' : 'no mapped step outcomes'}${history.incomplete ? ' · partial evidence' : ''}` : 'Historical step evidence unavailable.'
  const revisions = Object.entries(graph.revisions).map(([file, hash]) => `<li><code>${escapeHtml(shortSourceLocation(file))} · ${escapeHtml(hash)}</code></li>`).join('')
  return `<section class="subsection visual-flow"><h3>Visual test flow</h3><p>${escapeHtml(provenance)} · ${evidence}</p>
    <details class="drawer"><summary>Source revisions</summary><ul>${revisions}</ul></details>${graph.completeness === 'partial' ? '<p>Some control flow requires source inspection.</p>' : ''}${charts.join('')}</section>`
}
