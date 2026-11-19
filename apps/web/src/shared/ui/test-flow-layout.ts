import type { PlaywrightPlaybackEvent } from '@shared/playback'
import dagre from '@dagrejs/dagre'
import type { ReadableGroupNode, ReadableNode } from '@shared/readable-tests/types'

import { buildFlowTopology, flowName, type FlowBox, type FlowTopology, type TestFlowGraph } from '@shared/test-view/flow-graph'

interface Box extends FlowBox { source?: ReadableNode; context?: ReadableNode }
interface Point { x: number; y: number }
interface Bounds extends Point { width: number; height: number }
interface Connection { label: string; points: Point[]; x: number; y: number }

export function stepVisitKey(location: string, title: string) {
  return JSON.stringify([location, title])
}

/** A retry starts its own counts. Unidentified legacy events cannot establish
 * which test or helper invocation ran. */
export function completedStepCounts(events?: readonly PlaywrightPlaybackEvent[]) {
  const counts = new Map<string, Map<string, number>>()
  for (const event of events ?? []) {
    const id = event.test.id
    if (!id) continue
    if (event.type === 'test-begin') counts.set(id, new Map())
    if (event.type !== 'step-end' || event.step.category !== 'test.step' || !event.step.location) continue
    const attempt = counts.get(id)
    if (!attempt) continue
    const key = stepVisitKey(event.step.location, event.step.title)
    attempt.set(key, (attempt.get(key) ?? 0) + 1)
  }
  return counts
}

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

/** Fold the existing graph at the group's boundary. An early exit keeps
 * its original destination even when its source is inside a folded group. */
export function foldedTopology(section: FlowSection, collapsed: readonly string[] = []) {
  const topology = section.topology ?? buildFlowTopology(section.nodes)
  const counts = new Map<string, number>()
  const owners = new Map<string, string>()
  function visit(node: ReadableNode, owner?: string): number {
    if (owner) owners.set(node.id, owner)
    if (node.kind === 'leaf' || (node.kind === 'group' && node.origin === 'helper')) return 1
    const children = node.kind === 'branch' ? node.paths.flatMap(path => path.children) : node.children
    const next = owner ?? (collapsed.includes(node.id) ? node.id : undefined)
    let count = 0
    for (const child of children) count += visit(child, next)
    if (node.kind === 'loop') {
      for (const part of [node.initializer, node.increment]) if (part) count += visit(part, next)
    }
    if (count) counts.set(node.id, count)
    return count + 1
  }
  section.nodes.forEach(n => visit(n))
  if (!owners.size) return { topology, counts }
  const redirected = new Map<string, string>()
  for (const box of topology.boxes) {
    const owner = box.sourceId && owners.get(box.sourceId)
    if (owner && box.sourceId) redirected.set(box.id, owner + box.id.slice(box.sourceId.length))
  }
  const visible = new Set(topology.boxes.filter(b => !redirected.has(b.id)).map(b => b.id))
  // Cleanup paths may have more specialized suffixes than their outer group.
  for (const [id, target] of redirected) {
    let owner = target
    while (!visible.has(owner) && owner.includes('/')) owner = owner.slice(0, owner.lastIndexOf('/'))
    redirected.set(id, owner)
  }
  const seen = new Set<string>()
  const edges = topology.edges.flatMap(edge => {
    const from = redirected.get(edge.from) ?? edge.from
    const to = redirected.get(edge.to) ?? edge.to
    const key = JSON.stringify([from, to, edge.kind, edge.label])
    if ((from === to && (redirected.has(edge.from) || redirected.has(edge.to))) || seen.has(key)) return []
    seen.add(key)
    return [{ ...edge, from, to }]
  })
  return { topology: { ...topology, boxes: topology.boxes.filter(box => visible.has(box.id)), edges }, counts }
}

/** Geometry consumes the same structural edges as source inspection. Old
 * rosters without a graph use the shared compiler on their retained nodes. */
export function layoutTestFlow(nodes: ReadableNode[], topology = buildFlowTopology(nodes)) {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 23, marginx: 12, marginy: 12 })
  const sources = new Map(sectionNodes({ id: 'test', label: '', nodes }).map(node => [node.id, node]))
  const boxes = new Map<string, Box>()
  for (const descriptor of topology.boxes) {
    const source = descriptor.sourceId ? sources.get(descriptor.sourceId) : undefined
    const box: Box = { ...descriptor, source }
    if (!source && descriptor.shape === 'terminal') {
      const adjacent = topology.edges.flatMap(edge => descriptor.id === topology.entry && edge.from === descriptor.id
        ? [edge.to] : edge.to === descriptor.id ? [edge.from] : [])
      const neighbor = adjacent.length === 1 ? topology.boxes.find(item => item.id === adjacent[0]) : undefined
      if (neighbor?.sourceId) box.context = sources.get(neighbor.sourceId)
    }
    boxes.set(box.id, box)
    const lines = Math.ceil(box.label.length / (box.shape === 'decision' ? 14 : 21))
    const height = box.shape === 'terminal' ? 30 : Math.max(44, Math.min(5, lines) * 16 + 16) * (box.shape === 'decision' ? 1.45 : 1)
    graph.setNode(box.id, { width: box.shape === 'terminal' ? 94 : 154, height })
  }
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
