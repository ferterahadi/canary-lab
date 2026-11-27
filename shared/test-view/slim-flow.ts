import type { ReadableNode } from '../readable-tests/types'
import type { FlowTopology } from './flow-graph'
import { layoutTestFlow } from './flow-layout'

type Point = { x: number; y: number }
type Original = ReturnType<typeof layoutTestFlow>
type Line = Original['edges'][number] & { junction?: Point }
type Diagram = Omit<Original, 'edges'> & {
  edges: Line[]
  rail?: { x: number; top: number; end: number }
  compact?: boolean
}

export function diagramLayout(nodes: ReadableNode[], topology: FlowTopology): Diagram {
  const original = layoutTestFlow(nodes, topology)
  if (topology.boxes.length > 32) return original
  const exits = topology.edges.filter((edge) => edge.kind === 'exception' && edge.label === 'Error')
  const sink = exits[0]?.to
  const sinkBox = original.nodes.find((box) => box.id === sink)
  if (
    !sinkBox ||
    sinkBox.shape !== 'terminal' ||
    exits.length < 2 ||
    exits.some((edge) => edge.to !== sink) ||
    topology.edges.some((edge) => edge.from === sink || (edge.to === sink && !exits.includes(edge)))
  )
    return original

  // A single possible topological order is proof that we can draw a spine.
  // Independent branches and cycles keep their ranked graph layout.
  const normal = topology.edges.filter((edge) => edge.to !== sink)
  const remaining = new Set(original.nodes.filter((box) => box.id !== sink).map((box) => box.id))
  const order: string[] = []
  while (remaining.size) {
    const ready = [...remaining].filter((id) => !normal.some((e) => e.to === id && remaining.has(e.from)))
    if (ready.length !== 1) return original
    order.push(ready[0])
    remaining.delete(ready[0])
  }
  const rank = new Map(order.map((id, index) => [id, index]))
  const detours = normal.filter((edge) => rank.get(edge.to)! !== rank.get(edge.from)! + 1)
  // Multiple bypasses may need independent tracks or ports. Keep their routing.
  if (detours.length > 1) return original

  const inset = 12,
    width = 192
  const center = inset + (detours.length ? 24 : 0) + width / 2
  const railX = center + width / 2 + 28
  let y = 22
  const originalById = new Map(original.nodes.map((box) => [box.id, box]))
  const placed = order.map((id) => {
    const box = originalById.get(id)!
    const terminal = box.shape === 'terminal'
    const decision = box.shape === 'decision'
    const helper = box.source?.kind === 'group' && box.source.origin === 'helper'
    const characters = helper ? 22 : 25
    const rows = Math.ceil(box.label.length / characters)
    const height = terminal ? 25 : decision ? 74 : Math.max(34, 13 + rows * 15)
    const result = { ...box, width: terminal ? 64 : width, height, x: center, y: y + height / 2 }
    y += height + (decision ? 26 : 18)
    return result
  })
  const byId = new Map(placed.map((box) => [box.id, box]))
  const end = placed[placed.length - 1]
  const errorEnd = { ...sinkBox, x: railX, y: end.y, width: 84, height: 25 }
  const normalLines = normal.map((edge) => {
    const a = byId.get(edge.from)!,
      b = byId.get(edge.to)!
    if (detours.includes(edge)) {
      const x = inset
      const start = { x: a.x - a.width / 2, y: a.y }
      const dest = { x: b.x - b.width / 2, y: b.y }
      return { ...edge, x: x + 3, y: (a.y + b.y) / 2, points: [start, { x, y: a.y }, { x, y: b.y }, dest] }
    }
    const start = { x: a.x, y: a.y + a.height / 2 }
    const dest = { x: b.x, y: b.y - b.height / 2 }
    return { ...edge, x: a.x + 15, y: (start.y + dest.y) / 2, points: [start, dest] }
  })
  const errorLines = exits.map((edge) => {
    const a = byId.get(edge.from)!
    const start = { x: a.x + a.width / 2 - (a.shape === 'io' ? 6 : 0), y: a.y }
    const junction = { x: railX, y: a.y }
    return { ...edge, ...junction, points: [start, junction], junction }
  })
  return {
    nodes: [...placed, errorEnd],
    edges: [...normalLines, ...errorLines],
    width: railX + errorEnd.width / 2 + inset,
    height: end.y + end.height / 2 + 18,
    compact: true,
    rail: { x: railX, top: Math.min(...errorLines.map((line) => line.y)), end: errorEnd.y - errorEnd.height / 2 },
  }
}

// Trim each segment locally so tight corners and short connectors never overshoot.
export function softLine(points: Point[], radius = 7) {
  if (!points.length) return ''
  let path = 'M' + points[0].x + ' ' + points[0].y
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1]
    const before = Math.hypot(b.x - a.x, b.y - a.y),
      after = Math.hypot(c.x - b.x, c.y - b.y)
    if (!before || !after) continue
    const r = Math.min(radius, before / 2, after / 2)
    path += ' L' + (b.x + ((a.x - b.x) * r) / before) + ' ' + (b.y + ((a.y - b.y) * r) / before)
    path += ' Q' + b.x + ' ' + b.y + ' ' + (b.x + ((c.x - b.x) * r) / after) + ' ' + (b.y + ((c.y - b.y) * r) / after)
  }
  const last = points[points.length - 1]
  return path + ' L' + last.x + ' ' + last.y
}
