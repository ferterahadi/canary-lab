import type { FlowBox, FlowEdge } from './flow-graph'

interface SizedBox extends FlowBox { width: number; height: number }

/** Keep source order in large sections. Long edges to the same destination
 * share a rail, so every possible exception can reach one error terminator
 * without introducing a chain of invisible ranking nodes per statement. */
export function layoutFlowColumn<T extends SizedBox>(boxes: T[], edges: FlowEdge[]) {
  const rows = new Map(boxes.map((box, i) => [box.id, i]))
  const intervals = new Map<string, { first: number; last: number; lane: number; back: boolean }>()
  const branches = new Map<string, number>()
  // Give the adjacent successor the vertical path even when the compiler
  // emitted an exception edge first.
  const adjacent = new Map<string, FlowEdge>()
  for (const edge of edges) {
    if (rows.get(edge.to) === rows.get(edge.from)! + 1 && !adjacent.has(edge.from)) adjacent.set(edge.from, edge)
  }
  const routes = edges.map(edge => {
    const from = rows.get(edge.from)!
    const to = rows.get(edge.to)!
    // A single adjacent edge can drop straight into the next shape. Other
    // parallel edges retain their own label and port.
    if (adjacent.get(edge.from) === edge) return { edge, port: 0 }
    const port = branches.get(edge.from) ?? (adjacent.has(edge.from) ? 1 : 0)
    branches.set(edge.from, port + 1)
    const back = to <= from
    const key = (back ? 'back:' : 'forward:') + edge.to
    const rail = intervals.get(key) ?? { first: from, last: from, lane: 0, back }
    rail.first = Math.min(rail.first, from, to)
    rail.last = Math.max(rail.last, from, to)
    intervals.set(key, rail)
    return { edge, port, rail }
  })
  const ends = { back: [] as number[], forward: [] as number[] }
  for (const rail of [...intervals.values()].sort((a, b) => a.first - b.first)) {
    const lanes = rail.back ? ends.back : ends.forward
    const free = lanes.findIndex(end => end < rail.first)
    rail.lane = free < 0 ? lanes.length : free
    lanes[rail.lane] = rail.last
  }
  const labelWidth = edges.reduce((w, edge) => Math.max(w, edge.label.length * 7 + 12), 32)
  const half = boxes.reduce((w, box) => Math.max(w, box.width / 2), 0)
  const margin = 12
  const sideWidth = (lanes: number[]) => lanes.length ? labelWidth + lanes.length * 16 : 0
  const x = margin + sideWidth(ends.back) + half
  let y = margin
  const placed = boxes.map(box => {
    const center = y + box.height / 2
    y += box.height + 28 + 16 * Math.max(0, (branches.get(box.id) ?? 1) - 1)
    return { ...box, x, y: center }
  })
  const lines = routes.map(({ edge, rail, port }) => {
    const from = placed[rows.get(edge.from)!]
    const to = placed[rows.get(edge.to)!]
    const start = { x, y: from.y + from.height / 2 }
    const target = { x, y: to.y - to.height / 2 }
    const labelY = start.y + 12 + 16 * port
    if (!rail) return { ...edge, x: x + labelWidth / 2, y: labelY, points: [start, target] }
    const sign = rail.back ? -1 : 1
    const side = x + sign * (half + labelWidth + rail.lane * 16)
    const entry = { x: x + sign * (to.width / 2 - (to.shape === 'io' ? 6 : 0)), y: to.y }
    return { ...edge, x: x + sign * (half + labelWidth / 2), y: labelY - 5,
      points: [start, { x, y: labelY }, { x: side, y: labelY }, { x: side, y: entry.y }, entry] }
  })
  return { nodes: placed, edges: lines, width: x + half + sideWidth(ends.forward) + margin, height: y }
}
