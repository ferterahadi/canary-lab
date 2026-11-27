import { observedBranches, type FlowVisit } from '@shared/test-view/flow-execution'
import { useId, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { ReadableTest } from '@shared/readable-tests/types'
import { shortSourceLocation } from '@shared/lib/source-location'
import type { ReadableSourceSelection } from '@/shared/ui/ReadableTestView'
import { layoutTestFlow, type FlowSection } from '@shared/test-view/flow-layout'
import { foldedTopology } from '@/shared/ui/test-flow-layout'
import { Tooltip } from './Tooltip'
import { diagramLayout, softLine } from '@shared/test-view/slim-flow'
import type { FlowEdge } from '@shared/test-view/flow-graph'
import { changeLabels } from './test-reader-model'
import type { StepChange } from './test-reader-model'
import {FlowLabel} from './FlowLabel'

interface ChartProps {
  comparison?: { captions: ReadonlyMap<string,string>; edgeSide: (edge: Pick<FlowEdge,'from'|'to'|'label'|'kind'>) => string | undefined }
  visits?: Map<string, FlowVisit>
  section: FlowSection
  reader?: { hints: ReadonlyMap<string, string>; stepByBox: ReadonlyMap<string, {helper?: string; change?: StepChange}>; openSource: (id: string) => void }
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
  onHelper: (id: string, box?: string) => void
}

function Chart({ section, reader, comparison, visits, checks, active, selected, following, collapsed, onFold, onInspect, fit, onFit, viewport, onSelect, onHelper }: ChartProps) {
  const fold = useMemo(() => foldedTopology(section, collapsed), [section, collapsed])
  const chart = useMemo<ReturnType<typeof diagramLayout>>(() => comparison ? layoutTestFlow(section.nodes, fold.topology, comparison.captions) : reader ? diagramLayout(section.nodes, fold.topology) : layoutTestFlow(section.nodes, fold.topology), [section, fold, reader, comparison])
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
  </div><div ref={sheet} onScroll={remember} onFocusCapture={() => { if (following && active) onInspect() }} className="cl-flow-sheet" data-compact={chart.compact || undefined} role="group" aria-label={section.label}>
    <svg viewBox={`0 0 ${chart.width} ${chart.height}`} width={chart.width} height={chart.height}
      style={{ maxWidth: fit ? '100%' : 'none' }} aria-label={section.label + ' flowchart'}>
      <defs><marker id={marker} viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto-start-reverse">
        <path d="M1.5 1.5 L6.5 4 L1.5 6.5" className="flow-arrowhead" fill="none" stroke="var(--text-secondary)" />
      </marker></defs>
      {chart.rail && <g className="flow-error-rail" aria-label="Error paths converge at End (error)">
        <text x={chart.rail.x} y={chart.rail.top - 14} textAnchor="middle">On error</text>
        <path d={`M${chart.rail.x} ${chart.rail.top} V${chart.rail.end}`} markerEnd={`url(#${marker})`} />
      </g>}
      {chart.edges.map((e, i) => {
        const observed = branches.has(JSON.stringify([e.from, e.to, e.label]))
        return <g key={i} className="cl-flow-edge" data-revision={comparison?.edgeSide(e)} data-from={e.from} data-to={e.to} data-error={e.label.toLowerCase() === 'error' || undefined} data-observed={observed || undefined}>
          {observed && <title>{e.label} branch observed in this attempt</title>}
          {e.junction ? <>
            <title>{e.label} → End (error)</title>
            <polyline points={e.points.map(p => p.x + ',' + p.y).join(' ')} />
            <circle cx={e.junction.x} cy={e.junction.y} r="1.8" />
          </> : !reader ? <polyline points={e.points.map(p => p.x + ',' + p.y).join(' ')} markerEnd={`url(#${marker})`} /> : <path d={softLine(e.points)} markerEnd={`url(#${marker})`} />}
          {e.label && !e.junction && <text x={e.x} y={e.y} dy=".3em">{e.label}{observed && ' ✓'}</text>}
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
        const step = reader?.stepByBox.get(box.id)
        const mark = box.shape === 'check' ? 'check' : step?.helper ? 'helper' : box.shape === 'action' ? 'action' : null
        const note = reader?.hints.get(box.id)
        const tooltip = source ? shortSourceLocation(`${source.file}:${source.startLine}`) : 'No single source line for this boundary'
        const snippet = source?.snippet ?? ''
        return <g key={box.id} transform={`translate(${box.x - w / 2},${box.y - h / 2})`}
          className="cl-flow-shape" data-diff={step?.change?.kind} data-helper={step?.helper ? true : undefined} data-shape={box.shape} data-error-end={box.id === 'error-end' || undefined} data-selected={selected === box.id || undefined} data-observation={state} data-lit={isActive} data-checked={checked}>
          {box.shape === 'decision'
            ? <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />
            : box.shape === 'io' ? <polygon points={`12,0 ${w},0 ${w - 12},${h} 0,${h}`} />
              : <rect width={w} height={h} rx={box.shape === 'terminal' ? h / 2 : reader ? 10 : 2} />}
          <foreignObject width={w} height={h}>
            <Tooltip label={node ? [tooltip, note].filter(Boolean).join('\n') : (box.id === 'start' ? 'First statement · ' : 'Boundary · ') + tooltip}
              snippet={box.reason ? box.reason + '\n' + snippet : snippet}>
              <button type="button" className="cl-flow-node" data-box={box.id} aria-current={selected === box.id ? 'location' : undefined} aria-disabled={!source || undefined} data-running={isActive} data-source={source && `${source.file}:${source.startLine}`}
                ref={selected === box.id ? focus : undefined}
                onClick={event => { remember()
                  if (reader && (event.metaKey || event.ctrlKey) && source) { reader.openSource(box.id); return }
                  if (step?.helper) { onHelper(step.helper, box.id); return }
                  const target = node ?? box.context; if (target) onSelect({ id: target.id, source: target.source }, box.id) }}>
                {chart.compact && mark && <i className="flow-step-mark" data-mark={mark} aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
                    {mark === 'check' ? <path d="m3.2 8.1 3.1 3.1 6.5-7"/> : mark === 'helper' ?
                      <path d="M11.6 3.2c-2.1-1-3.2.2-3.6 2.6l-.9 5.3c-.4 2.4-1.8 3.1-3.6 2.1M4.9 7.5h6.2"/> :
                      <><rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5.5 6.8h5"/></>}
                  </svg>
                </i>}
                {step?.change && <span className="reader-change" data-diff={step.change.kind}>{changeLabels[step.change.kind]}</span>}
                <span className="diagram-label">{!chart.compact && box.shape === 'check' && <small aria-hidden="true">✓ </small>}{step ? <FlowLabel label={box.label}/> : box.label}</span>{step?.change?.detail && <span className="flow-change-detail" title={step.change.detail}>{step.change.detail}</span>}{badge && <b className={badge === 'Selected' ? 'selection-caption' : undefined}>{badge}</b>}
              </button>
            </Tooltip>
          </foreignObject>
          {node && fold.counts.has(node.id) && <foreignObject x={w - 34} y={-6} width={42} height={23}>
            <button className="cl-flow-open" type="button" aria-expanded={!collapsed?.includes(node.id)}
              aria-label={`${collapsed?.includes(node.id) ? 'Expand' : 'Collapse'} ${box.label}, ${fold.counts.get(node.id)} steps`}
              onClick={() => onFold(node.id)}>{collapsed?.includes(node.id) ? '+' : '−'} {fold.counts.get(node.id)}</button>
          </foreignObject>}
          {helper && <foreignObject className="helper-entry" x={w - (chart.compact ? 37 : 34)} y={chart.compact ? (h - 24) / 2 : -6} width={chart.compact ? 34 : 42} height={24}>
            <button className="cl-flow-open" type="button" aria-label={'Show flow for ' + box.label}
              title={`Expand ${box.collapsedCount ?? node.children.length} steps`} onClick={event => { if (reader && (event.metaKey || event.ctrlKey)) reader.openSource(box.id); else onHelper(step?.helper ?? node.id, box.id) }}>{chart.compact ? <>{box.collapsedCount ?? node.children.length}<span aria-hidden="true"> ›</span></> : <>↳ {box.collapsedCount ?? node.children.length}</>}</button>
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
    {!chart.reader && (test.completeness === 'partial' || test.graph?.completeness === 'partial') && <p>Some steps need inspection in Code.</p>}
    <Chart {...chart} />
  </div>
}
