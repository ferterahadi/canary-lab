import type { PlaywrightPlaybackEvent } from '@shared/playback'
import { buildFlowTopology } from '@shared/test-view/flow-graph'
import type { ReadableNode } from '@shared/readable-tests/types'
import type { FlowSection } from '@shared/test-view/flow-layout'

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
