import { observedBranches, type FlowVisit } from '@shared/test-view/flow-execution'
import { useId, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { ReadableTest } from '@shared/readable-tests/types'
import { shortSourceLocation } from '@shared/lib/source-location'
import type { ReadableSourceSelection } from './ReadableTestView'
import { layoutTestFlow, type FlowSection } from '@shared/test-view/flow-layout'
import { foldedTopology } from './test-flow-layout'
import { Tooltip } from './Tooltip'

interface ChartProps {
  visits?: Map<string, FlowVisit>
  section: FlowSection
  checks: ReadonlyMap<number, number>
  active?: string
  selected?: string
  following: boolean
  collapsed?: string[]
  onFold: (id: string) => void
  onInspect: () => void
  fit: boolean
  onFit: (fit: boolean) => void
  viewport: RefObject<{ left: number; top: number; ancestors: [HTMLElement, number, number][] } | null>
  onSelect: (selection: ReadableSourceSelection, box: string) => void
  onHelper: (id: string) => void
}

function Chart({ section, visits, checks, active, selected, following, collapsed, onFold, onInspect, fit, onFit, viewport, onSelect, onHelper }: ChartProps) {
  const fold = useMemo(() => foldedTopology(section, collapsed), [section, collapsed])
  const chart = useMemo(() => layoutTestFlow(section.nodes, fold.topology), [section, fold])
  const branches = useMemo(() => observedBranches(section.topology, visits), [section, visits])
  const activeBoxes = active ? chart.nodes.filter(box => box.sourceId === active) : []
  const activeBox = activeBoxes.length === 1 ? activeBoxes[0].id : undefined
  const marker = useId()
  const sheet = useRef<HTMLDivElement>(null)
  const focus = useRef<HTMLButtonElement>(null)
  function remember() {
    const el = sheet.current
    if (!el) return
    const ancestors: [HTMLElement, number, number][] = []
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth)
        ancestors.push([parent, parent.scrollLeft, parent.scrollTop])
    }
    viewport.current = { left: el.scrollLeft, top: el.scrollTop, ancestors }
  }
  useLayoutEffect(() => {
    const saved = viewport.current
    const el = sheet.current
    if (!el) return
    if (saved) {
      el.scrollLeft = saved.left
      el.scrollTop = saved.top
      for (const [parent, x, y] of saved.ancestors) {
        if (parent.isConnected) { parent.scrollLeft = x; parent.scrollTop = y }
      }
    } else if (focus.current) focus.current.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    focus.current?.focus({ preventScroll: true })
  }, [viewport])
  useLayoutEffect(() => {
    if (!following || !activeBox) return
    const el = sheet.current
    const running = el?.querySelector('[data-running="true"]')
    if (!el || !running) return
    const card = running.getBoundingClientRect()
    const bounds = el.getBoundingClientRect()
    if (card.left < bounds.left) el.scrollLeft += card.left - bounds.left
    else if (card.right > bounds.right) el.scrollLeft += card.right - bounds.right
    if (card.top < bounds.top) el.scrollTop += card.top - bounds.top
    else if (card.bottom > bounds.bottom) el.scrollTop += card.bottom - bounds.bottom
  }, [activeBox, following, fit])
  return <>{activeBoxes.length > 1 && <p>Running step has no unique box in this view.</p>}<div className="cl-flow-size">
    <button type="button" aria-pressed={fit} onClick={() => onFit(!fit)}>{fit ? 'Actual size' : 'Fit to width'}</button>
  </div><div ref={sheet} onScroll={remember} onFocusCapture={() => { if (following && active) onInspect() }} className="cl-flow-sheet" role="group" aria-label={section.label}>
    <svg viewBox={`0 0 ${chart.width} ${chart.height}`} width={chart.width} height={chart.height}
      style={{ maxWidth: fit ? '100%' : 'none' }} aria-label={section.label + ' flowchart'}>
      <defs><marker id={marker} viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto-start-reverse">
        <path d="M0 0 L8 4 L0 8 z" fill="var(--text-secondary)" />
      </marker></defs>
      {chart.edges.map((e, i) => {
        const observed = branches.has(JSON.stringify([e.from, e.to, e.label]))
        return <g key={i} className="cl-flow-edge" data-observed={observed || undefined}>
          {observed && <title>{e.label} branch observed in this attempt</title>}
          <polyline points={e.points.map(p => p.x + ',' + p.y).join(' ')} markerEnd={`url(#${marker})`} />
          {e.label && <text x={e.x} y={e.y} dy=".3em">{e.label}{observed && ' ✓'}</text>}
        </g>
      })}
      {chart.nodes.map(box => {
        const { width: w, height: h } = box
        const node = box.source
        const source = (node ?? box.context)?.source
        const isActive = box.id === activeBox
        const checked = node?.kind === 'loop' ? checks.get(node.source.startLine) : undefined
        const visit = visits?.get(box.id)
        const state = visit?.failed ? 'failed' : visit?.completed ? 'observed' : visit?.skipped ? 'skipped' : undefined
        const badge = isActive ? 'Running now' : state === 'failed' ? 'Step failed' : checked ? 'Checked ×' + checked
          : state === 'observed' ? 'Observed ×' + visit!.completed : state === 'skipped' ? 'Skipped' : selected === box.id ? 'Selected' : undefined
        const helper = node?.kind === 'group' && node.origin === 'helper' && node.children.length > 0
        const tooltip = source ? shortSourceLocation(`${source.file}:${source.startLine}`) : 'No single source line for this boundary'
        const snippet = source?.snippet ?? ''
        return <g key={box.id} transform={`translate(${box.x - w / 2},${box.y - h / 2})`}
          className="cl-flow-shape" data-shape={box.shape} data-selected={selected === box.id || undefined} data-observation={state} data-lit={isActive} data-checked={checked}>
          {box.shape === 'decision'
            ? <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />
            : box.shape === 'io' ? <polygon points={`12,0 ${w},0 ${w - 12},${h} 0,${h}`} />
              : <rect width={w} height={h} rx={box.shape === 'terminal' ? h / 2 : 2} />}
          <foreignObject width={w} height={h}>
            <Tooltip label={node ? tooltip : (box.id === 'start' ? 'First statement · ' : 'Boundary · ') + tooltip}
              snippet={box.reason ? box.reason + '\n' + snippet : snippet}>
              <button type="button" className="cl-flow-node" data-box={box.id} aria-current={selected === box.id ? 'location' : undefined} aria-disabled={!source || undefined} data-running={isActive} data-source={source && `${source.file}:${source.startLine}`}
                ref={selected === box.id ? focus : undefined}
                onClick={() => { remember(); const target = node ?? box.context; if (target) onSelect({ id: target.id, source: target.source }, box.id) }}>
                <span>{box.shape === 'check' && <small aria-hidden="true">✓ </small>}{box.label}</span>{badge && <b>{badge}</b>}
              </button>
            </Tooltip>
          </foreignObject>
          {node && fold.counts.has(node.id) && <foreignObject x={w - 34} y={-6} width={42} height={23}>
            <button className="cl-flow-open" type="button" aria-expanded={!collapsed?.includes(node.id)}
              aria-label={`${collapsed?.includes(node.id) ? 'Expand' : 'Collapse'} ${box.label}, ${fold.counts.get(node.id)} steps`}
              onClick={() => onFold(node.id)}>{collapsed?.includes(node.id) ? '+' : '−'} {fold.counts.get(node.id)}</button>
          </foreignObject>}
          {helper && <foreignObject x={w - 34} y={-6} width={42} height={23}>
            <button className="cl-flow-open" type="button" aria-label={'Show flow for ' + box.label}
              title={`Expand ${box.collapsedCount ?? node.children.length} steps`} onClick={() => onHelper(node.id)}>↳ {box.collapsedCount ?? node.children.length}</button>
          </foreignObject>}
        </g>
      })}
    </svg>
  </div></>
}

export function VisualTestView({ location, test, ...chart }: ChartProps & { location?: string; test: ReadableTest }) {
  if (test.graph && test.graph.schemaVersion !== 1) return <p>This flow version requires a newer Canary Lab. Open Code to inspect the source.</p>
  if (!test.nodes.length) return <p>No flow available for this source.</p>
  return <div role="region" aria-label="Test flow" className="cl-test-flow">
    {location && !chart.active && <p>Running step has no unique box in this view.</p>}
    {(test.completeness === 'partial' || test.graph?.completeness === 'partial') && <p>Some steps need inspection in Code.</p>}
    <Chart {...chart} />
  </div>
}
