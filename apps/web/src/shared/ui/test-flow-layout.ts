import dagre from '@dagrejs/dagre'
import type { ReadableGroupNode, ReadableNode } from '@shared/readable-tests/types'

type Shape = 'terminal' | 'decision' | 'io' | 'action' | 'check'
interface Box { id: string; label: string; shape: Shape; source?: ReadableNode; context?: ReadableNode }
interface Point { x: number; y: number }
interface Bounds extends Point { width: number; height: number }
interface Connection { label: string; points: Point[]; x: number; y: number }
interface Destinations { end: string; fail: string; breakTo?: string; continueTo?: string }

export function flowName(node: ReadableNode) {
  if (node.kind === 'group' && node.children.some(n => n.kind === 'group' && n.controlRole === 'finally')) return 'Inspect try / finally'
  const label = (node.flow?.label ?? node.english?.text ?? node.text).replace(/\s+/g, ' ').trim()
  return label.length > 52 ? label.slice(0, 51).trimEnd() + '…' : label
}
export interface FlowSection { id: string; label: string; nodes: ReadableNode[]; implementation?: ReadableGroupNode['implementation'] }

export function flowSections(nodes: ReadableNode[]): FlowSection[] {
  const sections: FlowSection[] = [{ id: 'test', label: 'Test overview', nodes }]
  const helpers: ReadableGroupNode[] = []
  function visit(node: ReadableNode) {
    if (node.kind === 'group' && node.origin === 'helper') helpers.push(node)
    else if (node.kind === 'branch') node.paths.forEach(path => path.children.forEach(visit))
    else if (node.kind !== 'leaf') node.children.forEach(visit)
  }
  nodes.forEach(visit)
  for (const helper of helpers) {
    sections.push({ id: helper.id, label: flowName(helper), nodes: helper.children, implementation: helper.implementation })
    helper.children.forEach(visit)
  }
  return sections
}

export function sectionNodes(section: FlowSection): ReadableNode[] {
  function flatten(node: ReadableNode): ReadableNode[] {
    if (node.kind === 'branch') return [node, ...node.paths.flatMap(p => p.children.flatMap(flatten))]
    if (node.kind === 'loop' || (node.kind === 'group' && node.origin !== 'helper')) return [node, ...node.children.flatMap(flatten)]
    return [node]
  }
  return section.nodes.flatMap(flatten)
}

/** Build successors backwards so exits never acquire an edge to the statement
 * that happens to follow them in source. Each helper is its own call boundary. */
export function layoutTestFlow(nodes: ReadableNode[]) {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 23, marginx: 12, marginy: 12 })
  const boxes = new Map<string, Box>()
  let edgeId = 0
  function add(box: Box) {
    boxes.set(box.id, box)
    const lines = Math.ceil(box.label.length / (box.shape === 'decision' ? 14 : 21))
    const height = box.shape === 'terminal' ? 30 : Math.max(44, Math.min(5, lines) * 16 + 16) * (box.shape === 'decision' ? 1.45 : 1)
    graph.setNode(box.id, { width: box.shape === 'terminal' ? 94 : 154, height })
    return box.id
  }
  function edge(from: string, to: string, label = '') {
    graph.setEdge(from, to, { label, width: label.length * 6, height: label ? 12 : 0, labelpos: 'c' }, String(edgeId++))
  }
  const end = add({ id: 'end', shape: 'terminal', label: 'End', context: nodes.at(-1) })
  const fail = 'error-end'
  function sequence(items: ReadableNode[], next: string, dest: Destinations): string {
    for (let index = items.length - 1; index >= 0; index--) {
      const node = items[index], kind = node.flow?.kind
      const shape: Shape = node.kind === 'loop' || node.kind === 'branch' ? 'decision'
        : kind === 'io' || kind === 'return-io' ? 'io' : kind === 'check' ? 'check' : 'action'
      const id = add({ id: node.id, source: node, shape, label: flowName(node) })
      if (node.kind === 'loop') {
        const body = sequence(node.children, id, { ...dest, breakTo: next, continueTo: id })
        for (const back of graph.inEdges(id) ?? []) {
          const line = graph.edge(back)
          if (!line.label) Object.assign(line, { label: 'Repeat', width: 36, height: 12 })
        }
        edge(id, body, 'Yes')
        if (node.flow?.label !== 'Repeat') edge(id, next, 'No')
        next = node.loopKind === 'do-while' ? body : id
        continue
      }
      if (node.kind === 'branch') {
        let fallthrough = next
        for (const path of [...node.paths].reverse()) {
          const isCase = path.role === 'case' || path.role === 'default'
          const target = sequence(path.children, isCase ? fallthrough : next, isCase ? { ...dest, breakTo: next } : dest)
          edge(id, target, path.role === 'then' ? 'Yes' : path.role === 'otherwise' ? 'No' : path.text)
          fallthrough = target
        }
        if (!node.paths.some(p => p.role === 'otherwise' || p.role === 'default')) {
          edge(id, next, node.paths.some(p => p.role === 'then') ? 'No' : 'No match')
        }
      } else if (node.kind === 'group' && node.origin !== 'helper') {
        const handler = node.children.find(n => n.kind === 'group' && n.controlRole === 'catch')
        const cleanup = node.children.find(n => n.kind === 'group' && n.controlRole === 'finally')
        // A finally can redirect any pending return or exception. Treat this
        // compound statement as a source-inspectable operation until modeled.
        if (cleanup) edge(id, next)
        else if (handler?.kind === 'group') {
          const onError = sequence(handler.children, next, dest)
          edge(id, sequence(node.children.filter(n => n !== handler), next, { ...dest, fail: onError }))
          edge(id, onError, 'Error')
        } else edge(id, sequence(node.children, next, dest))
      } else {
        const target = kind === 'return' || kind === 'return-io' ? dest.end : kind === 'throw' ? dest.fail
          : kind === 'break' ? dest.breakTo : kind === 'continue' ? dest.continueTo : kind === 'opaque' ? undefined : next
        if (target === fail && !boxes.has(fail)) add({ id: fail, shape: 'terminal', label: 'End (error)', context: node })
        if (target) edge(id, target)
      }
      next = id
    }
    return next
  }
  const entry = sequence(nodes, end, { end, fail })
  edge(add({ id: 'start', shape: 'terminal', label: 'Start', context: nodes[0] }), entry)
  dagre.layout(graph)
  const placed = [...boxes.values()].map(box => ({ ...box, ...graph.node(box.id) as Bounds }))
  const byId = new Map(placed.map(b => [b.id, b]))
  // Dagre clips to rectangles. Extend the actual arrow to the diamond or
  // slanted input/output perimeter, otherwise it appears to stop in mid-air.
  function perimeter(id: string, near: Point, point: Point) {
    const b = byId.get(id)!
    if (b.shape !== 'decision' && b.shape !== 'io') return point
    const dx = near.x - b.x, dy = near.y - b.y
    const scale = b.shape === 'decision' ? Math.abs(dx) / (b.width / 2) + Math.abs(dy) / (b.height / 2)
      : Math.max(Math.abs(dy) / (b.height / 2), Math.abs(dx + 12 * dy / b.height) / ((b.width - 12) / 2))
    return scale ? { x: b.x + dx / scale, y: b.y + dy / scale } : point
  }
  const edges = graph.edges().map(e => {
    const line = graph.edge(e) as Connection
    const points = [...line.points]
    points[0] = perimeter(e.v, points[1], points[0])
    const last = points.length - 1
    points[last] = perimeter(e.w, points[last - 1], points[last])
    return { ...line, points, from: e.v, to: e.w }
  })
  return { nodes: placed, edges, width: graph.graph().width as number, height: graph.graph().height as number }
}
