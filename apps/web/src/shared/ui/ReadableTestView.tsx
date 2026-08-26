import type { ReactNode } from 'react'
import type {
  ReadableBranchNode,
  ReadableBranchPath,
  ReadableFidelity,
  ReadableLeafNode,
  ReadableNode,
  ReadableSource,
  ReadableTest,
} from '../api/types'

export interface ReadableSourceSelection {
  id: string
  source: ReadableSource
}

export function ReadableTestView({
  test,
  selectedNodeId,
  onSourceSelect,
}: {
  test: ReadableTest
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  if (test.nodes.length === 0) {
    return (
      <div data-testid="readable-test-empty" className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
        No executable steps found in this test body.
      </div>
    )
  }

  return (
    <ol data-testid="readable-test-tree" className="m-0 flex list-none flex-col gap-1.5 p-0">
      {test.nodes.map((node) => (
        <ReadableNodeRow
          key={node.id}
          node={node}
          selectedNodeId={selectedNodeId}
          onSourceSelect={onSourceSelect}
        />
      ))}
    </ol>
  )
}

function ReadableNodeRow({
  node,
  selectedNodeId,
  onSourceSelect,
}: {
  node: ReadableNode
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  const children = node.kind === 'group' || node.kind === 'loop' ? node.children : []
  return (
    <li data-readable-kind={node.kind}>
      <ReadableRow
        id={node.id}
        label={nodeLabel(node)}
        text={node.text}
        fidelity={node.fidelity}
        source={node.source}
        selected={selectedNodeId === node.id}
        onSourceSelect={onSourceSelect}
      />
      {node.kind === 'branch' ? (
        <ReadableBranchPaths
          branch={node}
          selectedNodeId={selectedNodeId}
          onSourceSelect={onSourceSelect}
        />
      ) : children.length > 0 ? (
        <ReadableChildren>
          {children.map((child) => (
            <ReadableNodeRow
              key={child.id}
              node={child}
              selectedNodeId={selectedNodeId}
              onSourceSelect={onSourceSelect}
            />
          ))}
        </ReadableChildren>
      ) : null}
      {node.fidelity === 'unresolved' && (
        <pre
          data-testid={`readable-source-${node.id}`}
          className="cl-code-shell ml-3 mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md px-2 py-1.5 text-[10.5px]"
          style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          <code>{node.source.snippet}</code>
        </pre>
      )}
    </li>
  )
}

function ReadableBranchPaths({
  branch,
  selectedNodeId,
  onSourceSelect,
}: {
  branch: ReadableBranchNode
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  return (
    <ReadableChildren>
      {branch.paths.map((path) => (
        <ReadablePathRow
          key={path.id}
          path={path}
          selectedNodeId={selectedNodeId}
          onSourceSelect={onSourceSelect}
        />
      ))}
    </ReadableChildren>
  )
}

function ReadablePathRow({
  path,
  selectedNodeId,
  onSourceSelect,
}: {
  path: ReadableBranchPath
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  return (
    <li data-readable-kind="path">
      <ReadableRow
        id={path.id}
        label="Path"
        text={path.text}
        fidelity={path.fidelity}
        source={path.source}
        selected={selectedNodeId === path.id}
        onSourceSelect={onSourceSelect}
      />
      {path.children.length > 0 && (
        <ReadableChildren>
          {path.children.map((child) => (
            <ReadableNodeRow
              key={child.id}
              node={child}
              selectedNodeId={selectedNodeId}
              onSourceSelect={onSourceSelect}
            />
          ))}
        </ReadableChildren>
      )}
    </li>
  )
}

function ReadableChildren({ children }: {
  children: ReactNode
}) {
  return (
    <ol
      className="ml-3 mt-1.5 flex list-none flex-col gap-1.5 border-l pl-3"
      style={{ borderColor: 'var(--border-default)' }}
    >
      {children}
    </ol>
  )
}

function ReadableRow({
  id,
  label,
  text,
  fidelity,
  source,
  selected,
  onSourceSelect,
}: {
  id: string
  label: string
  text: string
  fidelity: ReadableFidelity
  source: ReadableSource
  selected: boolean
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  return (
    <button
      type="button"
      data-testid={`readable-node-${id}`}
      data-fidelity={fidelity}
      aria-pressed={selected}
      aria-label={`Show source for ${text}, ${sourceLabel(source)}`}
      onClick={() => onSourceSelect?.({ id, source })}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
      style={{
        background: selected ? 'var(--accent-soft)' : undefined,
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
      }}
    >
      <span
        className="mt-0.5 w-[3.75rem] shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 text-xs leading-5" style={{ color: 'var(--text-primary)' }}>
        {text}
      </span>
      <span
        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px]"
        title={fidelityTitle(fidelity)}
        style={{
          border: '1px solid var(--border-default)',
          color: fidelity === 'unresolved' ? 'var(--text-secondary)' : 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {fidelityLabel(fidelity)}
      </span>
      <span
        className="mt-0.5 shrink-0 text-[9.5px]"
        title={source.file}
        style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
      >
        {sourceLabel(source)}
      </span>
    </button>
  )
}

function nodeLabel(node: ReadableNode): string {
  if (node.kind === 'group') return 'Step'
  if (node.kind === 'branch') return 'Decision'
  if (node.kind === 'loop') return 'Loop'
  return leafLabel(node)
}

function leafLabel(node: ReadableLeafNode): string {
  switch (node.role) {
    case 'setup': return 'Setup'
    case 'action': return 'Action'
    case 'check': return 'Check'
    case 'helper': return 'Helper'
    case 'unknown': return 'Source'
  }
}

function fidelityLabel(fidelity: ReadableFidelity): string {
  switch (fidelity) {
    case 'exact': return 'authored'
    case 'derived': return 'rule-based'
    case 'unresolved': return 'source only'
  }
}

function fidelityTitle(fidelity: ReadableFidelity): string {
  switch (fidelity) {
    case 'exact': return 'Original wording written in the test'
    case 'derived': return 'Deterministically described from source code'
    case 'unresolved': return 'Could not translate safely; inspect the source'
  }
}

function sourceLabel(source: ReadableSource): string {
  const file = source.file.split(/[\\/]/).pop() ?? source.file
  const line = source.startLine === source.endLine
    ? `L${source.startLine}`
    : `L${source.startLine}–${source.endLine}`
  return `${file}:${line}`
}
