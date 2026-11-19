import { describe, expect, it } from 'vitest'
import type { FlowStamp, PlaywrightPlaybackEvent } from '../playback'
import type { FlowBox, InvocationGraph, TestFlowGraph } from './flow-graph'
import { flowAttempts, observedBranches, projectFlowAttempt } from './flow-execution'

const test = { id: 'alpha', name: 'case', title: 'case', location: 'spec.ts:1' }
const graph: TestFlowGraph = {
  schemaVersion: 1, case: { file: 'spec.ts', line: 1, title: 'case' }, origin: { kind: 'recorded-run', runId: 'run' },
  completeness: 'complete', revisions: { 'spec.ts': 'spec', 'helper.ts': 'helper' },
  sections: [section('test', [box('call', 'spec.ts', 2, 'inspect')]),
    section('inspect', [box('check', 'helper.ts', 4), box('exit', 'helper.ts', 5)])],
}
function box(id: string, file: string, line: number, invocation?: string): FlowBox {
  return { id, sourceId: id, invocation, shape: 'decision', label: id, range: { file, startLine: line, endLine: line } }
}
function section(id: string, boxes: FlowBox[]): InvocationGraph {
  return { id, definition: boxes[0].range!, entry: 'start', exit: 'end', boxes, edges: [] }
}
function event(seq: number, type: PlaywrightPlaybackEvent['type'], stepId?: number, line = 4, extra: Partial<FlowStamp> = {}): PlaywrightPlaybackEvent {
  const flow = { stream: 'stream', retry: 0, execution: 1, sequence: seq, stepId, revision: type.startsWith('test') || line === 2 ? 'spec' : 'helper', ...extra }
  const shared = { flow, time: 'now', test }
  if (type === 'test-begin') return { ...shared, type }
  if (type === 'test-end') return { ...shared, type, status: 'failed', passed: false, durationMs: 5, retry: flow.retry }
  return { ...shared, type, step: { category: 'test.step', location: (line === 2 ? 'spec' : 'helper') + '.ts:' + line, title: line === 4 ? 'check' : 'exit' } }
}

describe('flow observations', () => {
  it('isolates parallel cases, retries and execution streams, including delayed step ends', () => {
    const start = event(0, 'test-begin')
    const check = event(1, 'step-begin', 1)
    const fail = event(2, 'step-end', 1, 4, { outcome: 'failed' })
    const retry = [event(0, 'test-begin'), check].map(e => ({ ...e, flow: { ...e.flow!, retry: 1 } }))
    const parallel = [start, check].map(e => ({ ...e, test: { ...test, id: 'beta' } }))
    const rerun = { ...start, flow: { ...start.flow!, execution: 2, stream: 'later' } }
    const cases = flowAttempts('run', [start, ...parallel, check, fail, event(3, 'test-end'), ...retry, fail, rerun])
    const [first, second, third] = cases.get('alpha')!
    expect(cases.get('beta')).toHaveLength(1)
    expect(projectFlowAttempt(graph, first, true).sections.get('inspect')?.get('check')?.failed).toBe(1)
    expect(projectFlowAttempt(graph, second, true).active?.box.id).toBe('check')
    expect(projectFlowAttempt(graph, second, false).active).toBeUndefined()
    expect(projectFlowAttempt(graph, third, true).sections.size).toBe(0)
  })
  it('deduplicates delivery, clears open steps across gaps, and counts only a named predicate evaluation', () => {
    const done = event(2, 'step-end', 1, 4, { outcome: 'completed' })
    const events = [event(0, 'test-begin'), event(1, 'step-begin', 1), done, done, event(3, 'step-begin', 2), event(5, 'step-end', 2, 5, { outcome: 'completed' })]
    const overlay = projectFlowAttempt(graph, flowAttempts('run', events).get('alpha')![0], true)
    expect(overlay.incomplete).toBe(true)
    expect(overlay.sections.get('inspect')?.get('check')).toMatchObject({ checks: 1, completed: 1 })
    expect(overlay.sections.get('inspect')?.has('exit')).toBe(false)
    expect(overlay.active).toBeUndefined()
  })
  it('resolves a repeated helper only under an observed invocation and restores a nested parent', () => {
    const repeated = { ...graph, sections: [...graph.sections, section('again', graph.sections[1].boxes)] }
    const events = [event(0, 'test-begin'), event(1, 'step-begin', 1, 2), event(2, 'step-begin', 2, 4, { parentId: 1 })]
    const project = (ev: PlaywrightPlaybackEvent[]) => projectFlowAttempt(repeated, flowAttempts('run', ev).get('alpha')![0], true)
    expect(project(events).active?.section.id).toBe('inspect')
    expect(project([...events, event(3, 'step-end', 2, 4, { outcome: 'completed' })]).active?.box.id).toBe('call')
    expect(project([events[0], event(1, 'step-begin', 2)]).unavailable).toBe(1)
  })
  it('clears live state on interruption and withholds exact matches for legacy, changed or unrelated source', () => {
    const start = event(0, 'test-begin')
    const step = event(1, 'step-begin', 1)
    const attempt = flowAttempts('run', [start, step]).get('alpha')![0]
    expect(projectFlowAttempt(graph, { ...attempt, status: 'interrupted' }, true).active).toBeUndefined()
    expect(projectFlowAttempt({ ...graph, revisions: { ...graph.revisions, 'helper.ts': 'edited' } }, attempt, true).unavailable).toBe(1)
    expect(projectFlowAttempt(graph, { ...attempt, runId: 'other' }, true).reason).toBeTruthy()
    const legacy = flowAttempts('run', [start, step].map(e => ({ ...e, flow: undefined })))
    expect(projectFlowAttempt(graph, legacy.get('alpha')![0], true).reason).toBeTruthy()
    expect(flowAttempts('run', [step]).size).toBe(0)
  })
})

it('marks an observed branch only when the destination has one possible incoming edge', () => {
  const branch = { from: 'check', to: 'exit', label: 'Yes', kind: 'branch' as const }
  const topology = { ...graph.sections[1], edges: [branch] }
  const visit = { completed: 1, checks: 1, failed: 0, skipped: 0 }
  const visits = new Map([['check', visit], ['exit', visit]])
  expect([...observedBranches(topology, visits)]).toEqual([JSON.stringify(['check', 'exit', 'Yes'])])
  expect(observedBranches({ ...topology, edges: [branch, { ...branch, from: 'other' }] }, visits).size).toBe(0)
  expect(observedBranches(topology, new Map([['check', visit]])).size).toBe(0)
})
