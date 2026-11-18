import { expect, it } from 'vitest'
import type { ReadableNode } from '@shared/readable-tests/types'
import { layoutTestFlow } from './test-flow-layout'

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
