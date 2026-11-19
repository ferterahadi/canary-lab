import type { ReadableFidelity, ReadableNode, ReadableSource } from '../readable-tests/types'

export type GraphOrigin = { kind: 'working-tree' | 'before' | 'after' } | { kind: 'recorded-run'; runId: string }
export type FlowRange = Omit<ReadableSource, 'snippet'>
export type EdgeKind = 'next' | 'branch' | 'loop-body' | 'loop-exit' | 'loop-back' | 'return' | 'throw' | 'break' | 'continue' | 'exception'
export interface FlowEdge { from: string; to: string; kind: EdgeKind; label: string }
export interface FlowBox {
  id: string
  label: string
  shape: 'terminal' | 'decision' | 'io' | 'action' | 'check'
  /** Absent for structural start/end nodes. A cleanup can have several continuations at the same source. */
  sourceId?: string
  range?: FlowRange
  fidelity?: ReadableFidelity
  reason?: string
  boundary?: 'declaration' | 'callback' | 'invocation'
  invocation?: string
  collapsedCount?: number
}
export interface FlowTopology { entry: string; exit: string; boxes: FlowBox[]; edges: FlowEdge[] }
export interface InvocationGraph extends FlowTopology {
  id: string
  definition: FlowRange
  parent?: string
}
export interface TestFlowGraph {
  schemaVersion: 1
  origin: GraphOrigin
  case: { file: string; line: number; title: string }
  /** SHA-256 of each complete source file used by this graph. */
  revisions: Record<string, string>
  completeness: 'complete' | 'partial'
  sections: InvocationGraph[]
}

export function flowRange({ snippet: _snippet, ...range }: ReadableSource): FlowRange { return range }

export function flowName(node: ReadableNode) {
  const label = (node.flow?.label ?? node.english?.text ?? node.text).replace(/\s+/g, ' ').trim()
  return label.length > 52 ? label.slice(0, 51).trimEnd() + '…' : label
}

interface Destinations {
  returned: () => string
  failed: () => string
  breakTo?: () => string
  continueTo?: () => string
}

/** Compile backwards from continuations. Each helper has its own section:
 * normal completion resumes its call's normal edge, an exception its error edge. */
export function buildFlowTopology(nodes: ReadableNode[]): FlowTopology {
  const boxes = new Map<string, FlowBox>()
  const edges: FlowEdge[] = []
  let extraCleanupPaths = 0
  function terminal(id: string, label: string) {
    boxes.set(id, { id, label, shape: 'terminal' })
    return id
  }
  const end = terminal('end', 'End')
  const errorEnd = () => terminal('error-end', 'End (error)')
  function edge(from: string, to: string, kind: EdgeKind = 'next', label = '') {
    edges.push({ from, to, kind, label })
  }
  function sequence(items: ReadableNode[], next: string, dest: Destinations, suffix: string): string {
    for (const node of [...items].reverse()) {
      const id = node.id + suffix
      const kind = node.flow?.kind
      const helper = node.kind === 'group' && node.origin === 'helper'
      const shape = node.kind === 'loop' || node.kind === 'branch' ? 'decision'
        : kind === 'io' || kind === 'return-io' ? 'io' : kind === 'check' ? 'check' : 'action'
      const reason = node.flow?.reason ?? (node.fidelity === 'unsupported' || node.fidelity === 'unresolved' ? node.text : undefined)
      boxes.set(id, { id, label: flowName(node), shape, sourceId: node.id, range: flowRange(node.source),
        fidelity: node.fidelity, ...(reason ? { reason } : {}), ...(node.flow?.boundary ? { boundary: node.flow.boundary } : {}),
        ...(helper ? { invocation: node.id, boundary: 'invocation' as const } : {}) })
      const successor = next
      const normal = () => successor
      if (node.flow?.mayThrow) edge(id, dest.failed(), 'exception', 'Error')
      if (node.kind === 'loop') {
        const edgeStart = edges.length
        const repeat = node.increment ? sequence([node.increment], id, dest, suffix) : id
        const body = sequence(node.children, repeat, { ...dest, breakTo: normal, continueTo: () => repeat }, suffix)
        for (let i = edgeStart; i < edges.length; i++) {
          const back = edges[i]
          if (back.to === id && back.kind === 'next') { back.kind = 'loop-back'; back.label = 'Repeat' }
        }
        edge(id, body, 'loop-body', 'Yes')
        if (!(node.unconditional ?? (node.loopKind === 'for' && node.flow?.label === 'Repeat'))) edge(id, successor, 'loop-exit', 'No')
        next = node.initializer ? sequence([node.initializer], id, dest, suffix) : node.loopKind === 'do-while' ? body : id
        continue
      }
      if (node.kind === 'branch') {
        let fallthrough = successor
        for (const path of [...node.paths].reverse()) {
          const clause = path.role === 'case' || path.role === 'default'
          const target = sequence(path.children, clause ? fallthrough : successor, clause ? { ...dest, breakTo: normal } : dest, suffix)
          edge(id, target, 'branch', path.role === 'then' ? 'Yes' : path.role === 'otherwise' ? 'No' : path.text)
          fallthrough = target
        }
        if (!node.paths.some(p => p.role === 'otherwise' || p.role === 'default'))
          edge(id, successor, 'branch', node.paths.some(p => p.role === 'then') ? 'No' : 'No match')
      } else if (node.kind === 'group' && kind === 'try') {
        const handler = node.children.find(n => n.kind === 'group' && n.controlRole === 'catch')
        const cleanup = node.children.find(n => n.kind === 'group' && n.controlRole === 'finally')
        const routes = new Map<string, string>()
        // A single unconditional exit from finally would lose the pending return,
        // throw, break or continue. Share a copy only for identical destinations.
        function viaCleanup(target: string): string {
          if (!cleanup) return target
          const known = routes.get(target)
          if (known) return known
          if (routes.size && ++extraCleanupPaths > 128) {
            const boundary = cleanup.id + suffix + '/unresolved'
            boxes.set(boundary, { id: boundary, sourceId: cleanup.id, label: 'Inspect cleanup', shape: 'action',
              range: flowRange(cleanup.source), fidelity: 'unresolved', reason: 'Cleanup continuation expansion limit reached' })
            routes.set(target, boundary)
            return boundary
          }
          const entry = sequence([cleanup], target, dest, suffix + '/finally-' + routes.size)
          routes.set(target, entry)
          return entry
        }
        const guarded: Destinations = cleanup ? {
          returned: () => viaCleanup(dest.returned()), failed: () => viaCleanup(dest.failed()),
          breakTo: dest.breakTo && (() => viaCleanup(dest.breakTo!())),
          continueTo: dest.continueTo && (() => viaCleanup(dest.continueTo!())),
        } : dest
        const after = viaCleanup(successor)
        const caught = handler ? sequence([handler], after, guarded, suffix) : undefined
        const body = node.children.filter(n => n !== handler && n !== cleanup)
        edge(id, sequence(body, after, caught ? { ...guarded, failed: () => caught } : guarded, suffix))
      } else if (node.kind === 'group' && !helper) {
        const after = kind === 'return' ? dest.returned() : successor
        const bodyDest = node.flow?.boundary === 'callback' ? { ...dest, returned: () => after } : dest
        edge(id, sequence(node.children, after, bodyDest, suffix))
      } else if (kind === 'return' || kind === 'return-io') edge(id, dest.returned(), 'return')
      else if (kind === 'throw') edge(id, dest.failed(), 'throw')
      else if (kind === 'break' && dest.breakTo) edge(id, dest.breakTo(), 'break')
      else if (kind === 'continue' && dest.continueTo) edge(id, dest.continueTo(), 'continue')
      else if (kind !== 'opaque' && kind !== 'break' && kind !== 'continue' && (node.fidelity !== 'unsupported' || node.flow?.boundary === 'declaration')) edge(id, successor)
      if (helper && !node.flow?.mayThrow) edge(id, dest.failed(), 'exception', 'Error')
      next = id
    }
    return next
  }
  const first = sequence(nodes, end, { returned: () => end, failed: errorEnd }, '')
  const entry = terminal('start', 'Start')
  edge(entry, first)
  return { entry, exit: end, boxes: [...boxes.values()], edges }
}

export function buildTestFlowGraph(
  nodes: ReadableNode[], provenance: Pick<TestFlowGraph, 'origin' | 'case' | 'revisions'>, definition: ReadableSource,
): TestFlowGraph {
  const sections: InvocationGraph[] = []
  function section(id: string, body: ReadableNode[], source: ReadableSource, parent?: string) {
    sections.push({ id, definition: flowRange(source), ...(parent ? { parent } : {}), ...buildFlowTopology(body) })
    function visit(node: ReadableNode) {
      if (node.kind === 'group' && node.origin === 'helper' && node.implementation) {
        section(node.id, node.children, node.implementation.source, id)
      } else if (node.kind === 'branch') node.paths.forEach(path => path.children.forEach(visit))
      else if (node.kind !== 'leaf') node.children.forEach(visit)
    }
    body.forEach(visit)
  }
  section('test', nodes, definition)
  const sizes = new Map(sections.map(s => [s.id, s.boxes.filter(b => b.sourceId).length]))
  for (const current of sections) {
    for (const box of current.boxes) if (box.invocation) box.collapsedCount = sizes.get(box.invocation)
  }
  return { schemaVersion: 1, ...provenance, completeness: sections.some(s => s.boxes.some(b => b.reason)) ? 'partial' : 'complete', sections }
}
