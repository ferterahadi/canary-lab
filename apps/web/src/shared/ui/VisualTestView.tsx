import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReadableTest } from '@shared/readable-tests/types'
import { shortSourceLocation } from '@shared/lib/source-location'
import type { ReadableSourceSelection } from './ReadableTestView'
import { layoutTestFlow, type FlowSection } from './test-flow-layout'
import { Tooltip } from './Tooltip'

function Chart({ section, checks, active, selected, onSelect, onHelper }: {
  section: FlowSection; checks: ReadonlyMap<number, number>; active?: string; selected?: string
  onSelect: (selection: ReadableSourceSelection) => void
  onHelper: (id: string) => void
}) {
  const chart = useMemo(() => layoutTestFlow(section.nodes, section.topology), [section])
  const activeBoxes = active ? chart.nodes.filter(box => box.sourceId === active) : []
  const activeBox = activeBoxes.length === 1 ? activeBoxes[0].id : undefined
  const marker = useId()
  const [fit, setFit] = useState(false)
  const sheet = useRef<HTMLDivElement>(null)
  const focus = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const viewport = sheet.current
    const running = viewport?.querySelector('[data-running="true"]')
    if (!viewport || !running) return
    const card = running.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    if (card.left < bounds.left) viewport.scrollLeft += card.left - bounds.left
    else if (card.right > bounds.right) viewport.scrollLeft += card.right - bounds.right
  }, [active, section, fit])
  useEffect(() => { focus.current?.focus({ preventScroll: true }) }, [section, selected])
  return <>{activeBoxes.length > 1 && <p>Running step has no unique box in this view.</p>}<div className="cl-flow-size">
    <button type="button" aria-pressed={fit} onClick={() => setFit(value => !value)}>{fit ? 'Actual size' : 'Fit to width'}</button>
  </div><div ref={sheet} className="cl-flow-sheet" role="group" aria-label={section.label}>
    <svg viewBox={`0 0 ${chart.width} ${chart.height}`} width={chart.width} height={chart.height}
      style={{ maxWidth: fit ? '100%' : 'none' }} aria-label={section.label + ' flowchart'}>
      <defs><marker id={marker} viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto-start-reverse">
        <path d="M0 0 L8 4 L0 8 z" fill="var(--text-secondary)" />
      </marker></defs>
      {chart.edges.map((e, i) => <g key={i} className="cl-flow-edge">
        <polyline points={e.points.map(p => p.x + ',' + p.y).join(' ')} markerEnd={`url(#${marker})`} />
        {e.label && <text x={e.x} y={e.y} dy=".3em">{e.label}</text>}
      </g>)}
      {chart.nodes.map(box => {
        const { width: w, height: h } = box
        const node = box.source
        const source = (node ?? box.context)?.source
        const isActive = box.id === activeBox
        const checked = node?.kind === 'loop' ? checks.get(node.source.startLine) : undefined
        const helper = node?.kind === 'group' && node.origin === 'helper' && node.children.length > 0
        const tooltip = source ? shortSourceLocation(`${source.file}:${source.startLine}`) : box.label
        const snippet = source?.snippet ?? ''
        return <g key={box.id} transform={`translate(${box.x - w / 2},${box.y - h / 2})`}
          className="cl-flow-shape" data-shape={box.shape} data-lit={isActive} data-checked={checked}>
          {box.shape === 'decision'
            ? <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />
            : box.shape === 'io' ? <polygon points={`12,0 ${w},0 ${w - 12},${h} 0,${h}`} />
              : <rect width={w} height={h} rx={box.shape === 'terminal' ? h / 2 : 2} />}
          <foreignObject width={w} height={h}>
            <Tooltip label={node ? tooltip : (box.id === 'start' ? 'First statement · ' : 'Boundary · ') + tooltip}
              snippet={box.reason ? box.reason + '\n' + snippet : snippet}>
              <button type="button" className="cl-flow-node" data-running={isActive} data-source={source && `${source.file}:${source.startLine}`}
                ref={node && selected === box.id ? focus : undefined}
                onClick={() => { if (node) onSelect({ id: node.id, source: node.source }); else if (box.context) onSelect({ id: box.context.id, source: box.context.source }) }}>
                <span>{box.label}</span>{isActive ? <b>Running now</b> : checked ? <b>Checked ×{checked}</b> : null}
              </button>
            </Tooltip>
          </foreignObject>
          {helper && <foreignObject x={w - 18} y={-6} width={23} height={23}>
            <button className="cl-flow-open" type="button" aria-label={'Show flow for ' + box.label}
              onClick={() => onHelper(box.id)}>↳</button>
          </foreignObject>}
        </g>
      })}
    </svg>
  </div></>
}

export function VisualTestView({ section, checks, active, location, selected, onSelect, onHelper, test }: {
  section: FlowSection; checks: ReadonlyMap<number, number>; active?: string; location?: string; selected?: string; test: ReadableTest
  onSelect: (selection: ReadableSourceSelection) => void
  onHelper: (id: string) => void
}) {
  if (test.graph && test.graph.schemaVersion !== 1) return <p>This flow version requires a newer Canary Lab. Open Code to inspect the source.</p>
  if (!test.nodes.length) return <p>No flow available for this source.</p>
  return <div role="region" aria-label="Test flow" className="cl-test-flow">
    {location && !active && <p>Running step has no unique box in this view.</p>}
    {(test.completeness === 'partial' || test.graph?.completeness === 'partial') && <p>Some steps need inspection in Code.</p>}
    <Chart checks={checks} section={section} active={active} selected={selected} onSelect={onSelect} onHelper={onHelper} />
  </div>
}
