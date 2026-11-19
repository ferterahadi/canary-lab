import { expect, it } from 'vitest'
import type { ReadableNode } from '@shared/readable-tests/types'
import { foldedTopology, completedStepCounts, layoutTestFlow, stepVisitKey } from './test-flow-layout'

const base = { text: '', fidelity: 'exact' as const, source: { file: 'suite.ts', startLine: 2, endLine: 2, snippet: 'return' } }
const exit: ReadableNode = { ...base, kind: 'leaf', role: 'action', id: 'exit', flow: { kind: 'return', label: 'Return' } }
const decision: ReadableNode = { ...base, kind: 'branch', id: 'ready', paths: [{ ...base, id: 'yes', role: 'then', children: [exit] }] }

it('routes the retry path back to the loop, the early return to End, and the timeout to its error terminator', () => {
  const loop: ReadableNode = { ...base, id: 'deadline', kind: 'loop', loopKind: 'while', children: [decision] }
  const failure: ReadableNode = { ...base, kind: 'leaf', role: 'action', id: 'timeout', flow: { kind: 'throw', label: 'Report timeout' } }
  const chart = layoutTestFlow([loop, failure])
  expect(chart.edges.map(({ from, to, label }) => [from, to, label])).toEqual(expect.arrayContaining([
    ['deadline', 'ready', 'Yes'], ['deadline', 'timeout', 'No'], ['ready', 'exit', 'Yes'], ['ready', 'deadline', 'No'],
    ['exit', 'end', ''], ['timeout', 'error-end', ''],
  ]))
  expect(chart.edges.filter(e => e.from === 'exit')).toHaveLength(1)
  expect(chart.nodes.find(n => n.id === 'ready')?.shape).toBe('decision')
})

it('counts completed named steps per test and starts fresh on retry', () => {
  const a = { id: 'a', name: 'poll', title: 'poll', location: 'poll.spec.ts:1' }
  const b = { ...a, id: 'b' }
  const time = '2026-01-01T00:00:00Z'
  const step = { title: 'Before deadline?', location: 'gateway.ts:16', category: 'test.step' }
  const counts = completedStepCounts([
    { type: 'test-begin', time, test: a }, { type: 'test-begin', time, test: b },
    { type: 'step-end', time, test: a, step }, { type: 'step-end', time, test: b, step },
    { type: 'test-begin', time, test: b }, { type: 'step-begin', time, test: b, step },
    { type: 'step-end', time, test: a, step },
  ])
  expect(counts.get('a')?.get(stepVisitKey(step.location, step.title))).toBe(2)
  expect(counts.get('b')?.size).toBe(0)
})

it('folds nested groups without losing an early return or the normal successor', () => {
  const loop: ReadableNode = { ...base, id: 'deadline', kind: 'loop', loopKind: 'while', children: [decision] }
  const after: ReadableNode = { ...base, kind: 'leaf', role: 'check', id: 'after' }
  const section = { id: 'test', label: 'Overview', nodes: [loop, after] }
  const full = foldedTopology(section)
  const fold = foldedTopology(section, ['deadline'])
  expect(fold.counts.get('deadline')).toBe(2)
  expect(fold.topology.boxes.map(box => box.id)).not.toContain('exit')
  expect(fold.topology.edges.map(edge => [edge.from, edge.to])).toEqual(expect.arrayContaining([
    ['start', 'deadline'], ['deadline', 'end'], ['deadline', 'after'],
  ]))
  expect(foldedTopology(section, []).topology).toEqual(full.topology)
  expect(layoutTestFlow(section.nodes, full.topology).nodes[0].id).toBe('start')
})
