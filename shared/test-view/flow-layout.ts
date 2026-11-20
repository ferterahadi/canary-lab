import { layoutFlowColumn } from './flow-layout-column'
import dagre from '@dagrejs/dagre'
import type { ReadableGroupNode, ReadableNode } from '../readable-tests/types'

import { buildFlowTopology, flowName, type FlowBox, type FlowTopology, type TestFlowGraph } from './flow-graph'

interface Box extends FlowBox { source?: ReadableNode; context?: ReadableNode }
interface Point { x: number; y: number }
interface Bounds extends Point { width: number; height: number }
interface Connection { label: string; points: Point[]; x: number; y: number }

export interface FlowSection { id: string; label: string; parent?: string; nodes: ReadableNode[]; topology?: FlowTopology; implementation?: ReadableGroupNode['implementation'] }

export function flowSections(nodes: ReadableNode[], graph?: TestFlowGraph): FlowSection[] {
  const sections: FlowSection[] = [{ id: 'test', label: 'Test overview', nodes }]
  const helpers: { node: ReadableGroupNode; parent: string }[] = []
  function visit(node: ReadableNode, parent: string) {
    if (node.kind === 'group' && node.origin === 'helper') helpers.push({ node, parent })
    else if (node.kind === 'branch') node.paths.forEach(path => path.children.forEach(n => visit(n, parent)))
    else if (node.kind !== 'leaf') node.children.forEach(n => visit(n, parent))
  }
  nodes.forEach(n => visit(n, 'test'))
  for (const { node: helper, parent } of helpers) {
    sections.push({ parent, id: helper.id, label: flowName(helper), nodes: helper.children, implementation: helper.implementation })
    helper.children.forEach(n => visit(n, helper.id))
  }
  const byId = new Map(graph?.sections.map(section => [section.id, section]))
  return sections.map(section => ({ ...section, topology: byId.get(section.id) }))
}

export function sectionNodes(section: FlowSection): ReadableNode[] {
  function flatten(node: ReadableNode): ReadableNode[] {
    if (node.kind === 'branch') return [node, ...node.paths.flatMap(p => p.children.flatMap(flatten))]
    if (node.kind === 'loop') return [...(node.initializer ? [node.initializer] : []), node, ...node.children.flatMap(flatten), ...(node.increment ? [node.increment] : [])]
    if (node.kind === 'group' && node.origin !== 'helper') return [node, ...node.children.flatMap(flatten)]
    return [node]
  }
  return section.nodes.flatMap(flatten)
}

/** Geometry consumes the same structural edges as source inspection. Old
 * rosters without a graph use the shared compiler on their retained nodes. */
export function layoutTestFlow(nodes: ReadableNode[], topology = buildFlowTopology(nodes)) {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 23, marginx: 12, marginy: 12 })
  const sources = new Map(sectionNodes({ id: 'test', label: '', nodes }).map(node => [node.id, node]))
  const boxes = new Map<string, Box & { width: number; height: number }>()
  for (const descriptor of topology.boxes) {
    const source = descriptor.sourceId ? sources.get(descriptor.sourceId) : undefined
    const box: Box = { ...descriptor, source }
    if (!source && descriptor.shape === 'terminal') {
      const adjacent = topology.edges.flatMap(edge => descriptor.id === topology.entry && edge.from === descriptor.id
        ? [edge.to] : edge.to === descriptor.id ? [edge.from] : [])
      const neighbor = adjacent.length === 1 ? topology.boxes.find(item => item.id === adjacent[0]) : undefined
      if (neighbor?.sourceId) box.context = sources.get(neighbor.sourceId)
    }
    const lines = Math.ceil(box.label.length / (box.shape === 'decision' ? 14 : 21))
    const height = box.shape === 'terminal' ? 30 : Math.max(44, Math.min(5, lines) * 16 + 16) * (box.shape === 'decision' ? 1.45 : 1)
    const width = box.shape === 'terminal' ? 94 : 154
    boxes.set(box.id, { ...box, width, height })
  }
  // Dagre inserts intermediate ranks along each long edge. A shared error
  // destination makes even a sequence of calls quadratic in size.
  if (boxes.size > 32) {
    const order = new Map([...sources.keys()].map((id, i) => [id, i]))
    const rank = (box: Box) => box.id === topology.entry ? -1 : order.get(box.sourceId ?? '') ?? sources.size
    return layoutFlowColumn([...boxes.values()].sort((a, b) => rank(a) - rank(b)), topology.edges)
  }
  for (const { id, width, height } of boxes.values()) graph.setNode(id, { width, height })
  topology.edges.forEach(({ from, to, label }, index) => {
    graph.setEdge(from, to, { label, width: label.length * 6, height: label ? 12 : 0, labelpos: 'c' }, String(index))
  })
  dagre.layout(graph)
  const placed = [...boxes.values()].map(box => ({ ...box, ...graph.node(box.id) as Bounds }))
  // Geometry also sets keyboard reading order. The compiler emits continuations backwards.
  placed.sort((a, b) => a.y - b.y || a.x - b.x)
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
