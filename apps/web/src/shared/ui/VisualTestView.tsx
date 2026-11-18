import { useEffect, useRef } from 'react'
import type { ReadableNode, ReadableTest } from '@shared/readable-tests/types'
import { parseSourceLocation } from '@shared/lib/source-location'
import type { ReadableSourceSelection } from './ReadableTestView'

/** A line without a column cannot identify two calls on the same line, or two
 * invocations of the same helper. Only mark an unambiguous reported location. */
function observedNode(nodes: ReadableNode[], location: string | undefined): string | undefined {
  if (!location) return
  const { file, line } = parseSourceLocation(location)
  const matches: string[] = []
  function visit(node: ReadableNode) {
    if (node.source.file === file && node.source.startLine === Number(line)) matches.push(node.id)
    if (node.kind === 'branch') node.paths.forEach(path => path.children.forEach(visit))
    else if (node.kind !== 'leaf') node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return matches.length === 1 ? matches[0] : undefined
}

function nodeLabel(node: ReadableNode) {
  if (node.fidelity === 'unsupported' || node.fidelity === 'unresolved') return 'Inspect source'
  if (node.kind === 'branch') return 'Decision'
  if (node.kind === 'loop') return 'Repeat'
  if (node.kind === 'group') return node.controlRole ?? (node.origin === 'helper' ? 'Helper' : 'Group')
  const categories = node.english?.semanticCategories
  if (node.role === 'check' || categories?.includes('assertion')) return 'Check'
  if (categories?.includes('return')) return 'Return'
  return 'Step'
}

/** Compact single-line calls already have names and arguments. Keep the compiler's
 * wording for conditions, checks and multiline statements. */
function caption(node: ReadableNode) {
  if (!node.english) return node.text
  const snippet = node.source.snippet.trim()
  if ((node.kind === 'leaf' || (node.kind === 'group' && node.origin === 'helper')) &&
      !node.english.semanticCategories?.includes('assertion') && !snippet.includes('\n') && snippet.length <= 90) {
    return <code>{snippet}</code>
  }
  return node.english.spans.map((span, index) => span.kind === 'code'
    ? <code key={index}>{span.text}</code> : span.text)
}

export function VisualTestView({ test, location, selected, onSelect }: {
  test: ReadableTest
  location?: string
  selected?: string
  onSelect: (selection: ReadableSourceSelection) => void
}) {
  const active = observedNode(test.nodes, location)
  const returnFocus = useRef<HTMLButtonElement>(null)
  useEffect(() => { returnFocus.current?.focus({ preventScroll: true }) }, [])
  function sequence(nodes: ReadableNode[]) {
    return <ol className="cl-flow-sequence">{nodes.map(node => <li key={node.id}>
      <button type="button" className="cl-flow-node" data-running={node.id === active} data-kind={nodeLabel(node)}
        title={`Show source at ${node.source.file}:${node.source.startLine}`}
        ref={node.id === selected ? returnFocus : undefined}
        onClick={() => onSelect({ id: node.id, source: node.source })}>
        <strong>{nodeLabel(node)}</strong>{caption(node)}
        {node.id === active && <b>Running now</b>}
      </button>
      {node.kind === 'branch' && <div className="cl-flow-paths">
        {node.paths.map(path => <div key={path.id}><span>{path.role === 'then' ? 'Yes' : path.role === 'otherwise' ? 'No' : path.text}</span>{sequence(path.children)}</div>)}
        {node.paths.length === 1 && node.paths[0].role === 'then' && <div><span>No</span>Continue</div>}
      </div>}
      {(node.kind === 'loop' || node.kind === 'group') && <div className="cl-flow-body">
        {sequence(node.children)}
        {node.kind === 'loop' && <span>↻ Repeat while the loop continues</span>}
      </div>}
    </li>)}</ol>
  }
  return <div role="region" aria-label="Test flow" className="cl-test-flow">
    {test.completeness === 'partial' && <p>Some steps need inspection in Code.</p>}
    {location && !active && <p>Running step has no unique box in this view.</p>}
    {test.nodes.length ? sequence(test.nodes) : <p>No flow available for this source.</p>}
  </div>
}
