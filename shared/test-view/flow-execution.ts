import type { PlaywrightPlaybackEvent } from '../playback'
import { playbackLocationKey } from '../playback-identity'
import { parseSourceLocation } from '../lib/source-location'
import type { FlowBox, FlowTopology, InvocationGraph, TestFlowGraph } from './flow-graph'

export interface FlowAttempt {
  key: string
  runId: string
  caseId: string
  retry: number
  execution?: number
  events: PlaywrightPlaybackEvent[]
  status?: string
}

/** Modern records identify their attempt even if two workers interleave or
 * a late record from an interrupted execution arrives after its replacement. */
export function flowAttempts(runId: string, events: readonly PlaywrightPlaybackEvent[]) {
  const cases = new Map<string, FlowAttempt[]>()
  const attempts = new Map<string, FlowAttempt>()
  const legacy = new Map<string, FlowAttempt>()
  for (const event of events) {
    const id = event.test.id
    if (!id) continue
    const stamp = event.flow
    const list = cases.get(id) ?? []
    const key = stamp ? JSON.stringify([runId, stamp.stream, stamp.execution, id, stamp.instance, stamp.retry])
      : event.type === 'test-begin' ? JSON.stringify([runId, id, list.length]) : legacy.get(id)?.key
    if (!key) continue
    let attempt = attempts.get(key)
    if (!attempt) {
      if (event.type !== 'test-begin') continue
      attempt = { key, runId, caseId: id, retry: stamp?.retry ?? 0, execution: stamp?.execution ?? event.execution, events: [] }
      attempts.set(key, attempt)
      if (!stamp) legacy.set(id, attempt)
      list.push(attempt)
      cases.set(id, list)
    }
    if (attempt.status) continue
    attempt.events.push(event)
    if (event.type === 'test-end') {
      attempt.status = event.status
      attempt.retry = event.retry
      if (!stamp) legacy.delete(id)
    }
  }
  return cases
}

interface Target { section: InvocationGraph; box: FlowBox }
export interface FlowVisit { checks: number; completed: number; failed: number; skipped: number }
export interface FlowOverlay {
  sections: Map<string, Map<string, FlowVisit>>
  active?: Target
  unavailable: number
  incomplete: boolean
  reason?: string
}

/** Fold one authoritative attempt. A step end records an observation, never
 * a predicate's value. An uninstrumented branch cannot acquire an outcome. */
export function projectFlowAttempt(graph: TestFlowGraph | undefined, attempt: FlowAttempt, live: boolean): FlowOverlay {
  const overlay: FlowOverlay = { sections: new Map(), unavailable: 0, incomplete: false }
  const first = attempt.events[0]
  const source = first?.type === 'test-begin' && parseSourceLocation(first.test.location)
  if (!source || graph?.schemaVersion !== 1 || graph.origin.kind !== 'recorded-run' || graph.origin.runId !== attempt.runId
    || graph.case.file !== source.file || graph.case.line !== Number(source.line) || graph.case.title !== first.test.title
    || !first.flow?.revision || graph.revisions[source.file] !== first.flow.revision) {
    overlay.reason = 'This attempt has no matching recorded source revision.'
    return overlay
  }
  const byLocation = new Map<string, Target[]>()
  for (const section of graph.sections) for (const box of section.boxes) {
    if (!box.range || !box.sourceId) continue
    const key = box.range.file + ':' + box.range.startLine
    const targets = byLocation.get(key) ?? []
    targets.push({ section, box })
    byLocation.set(key, targets)
  }
  const open = new Map<number, Target | undefined>()
  let previous = -1
  for (const event of attempt.events) {
    const stamp = event.flow
    if (!stamp || stamp.sequence <= previous) continue
    if (stamp.sequence !== previous + 1) { open.clear(); overlay.incomplete = true }
    previous = stamp.sequence
    if (event.type !== 'step-begin' && event.type !== 'step-end') continue
    const id = stamp.stepId
    if (id === undefined) { overlay.incomplete = true; continue }
    if (event.type === 'step-begin') {
      const location = event.step.location
      let targets = location ? byLocation.get(playbackLocationKey(location)) ?? [] : []
      targets = targets.filter(t => stamp.revision && graph.revisions[t.box.range!.file] === stamp.revision)
      const parent = stamp.parentId === undefined ? undefined : open.get(stamp.parentId)
      if (parent?.box.invocation) targets = targets.filter(t => t.section.id === parent.box.invocation)
      if (stamp.column) {
        const col = stamp.column
        targets = targets.filter(({ box: { range } }) => range && (range.startColumn ?? 1) <= col
          && (range.endLine !== range.startLine || col < (range.endColumn ?? Infinity)))
      }
      if (targets.length > 1 && event.step.category === 'test.step') {
        const named = targets.filter(t => t.box.label === event.step.title)
        if (named.length) targets = named
      }
      const target = targets.length === 1 ? targets[0] : undefined
      if (!target) overlay.unavailable++
      open.set(id, target)
    } else {
      const target = open.get(id)
      if (!open.has(id)) overlay.incomplete = true
      open.delete(id)
      if (!target || !stamp.outcome) continue
      const visits = overlay.sections.get(target.section.id) ?? new Map<string, FlowVisit>()
      const visit = visits.get(target.box.id) ?? { checks: 0, completed: 0, failed: 0, skipped: 0 }
      visit[stamp.outcome]++
      if (stamp.outcome === 'completed' && event.step.category === 'test.step'
        && target.box.shape === 'decision' && target.box.label === event.step.title) visit.checks++
      visits.set(target.box.id, visit)
      overlay.sections.set(target.section.id, visits)
    }
  }
  if (live && !attempt.status) overlay.active = [...open.values()].at(-1)
  return overlay
}

/** Seeing a box enter through its only possible incoming edge proves that
 * branch. Multiple predecessors, cleanup copies and unlabeled edges stay neutral. */
export function observedBranches(section: FlowTopology | undefined, visits: ReadonlyMap<string, FlowVisit> | undefined) {
  const evidence = new Set<string>()
  if (!section || !visits?.size) return evidence
  const incoming = new Map<string, number>()
  for (const edge of section.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  for (const edge of section.edges) {
    if (edge.kind !== 'branch' && edge.kind !== 'loop-body' && edge.kind !== 'loop-exit') continue
    const target = visits.get(edge.to)
    if (visits.get(edge.from)?.completed && target && (target.completed || target.failed) && incoming.get(edge.to) === 1) {
      evidence.add(JSON.stringify([edge.from, edge.to, edge.label]))
    }
  }
  return evidence
}
