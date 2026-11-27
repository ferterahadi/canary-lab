import { expect, it } from 'vitest'
import { extractTestsFromSource } from '../ast-extractor'
import { localSourceHelper } from './suite-helpers'
import { diagramLayout } from '../../../../../shared/test-view/slim-flow'

it('keeps nested call sites navigable and outside the observed call graph', () => {
  const source = [
    'function limit() { return 1500 }',
    'function read(n: number) { return n }',
    "test('latency', () => {",
    '  const value = read(limit())',
    '  expect(value.elapsedMs).toBeLessThan(1500)',
    '})',
  ].join('\n')
  const { readable } = extractTestsFromSource('fixture.spec.ts', source, undefined, localSourceHelper, {
    kind: 'working-tree',
  }).tests[0]
  const nav = readable.navigation!
  expect(nav.calls.map((c) => [c.name, c.line, c.contentColumn])).toEqual([
    ['read', 4, 14],
    ['limit', 4, 19],
  ])
  expect(nav.definitions.find((d) => d.name === 'limit')?.source.snippet).toContain('function limit()')
  expect(readable.graph!.sections).toHaveLength(2)
  expect(readable.nodes[1].flow?.caption).toBe('Check response time is under 1.5 seconds')
  const graph = readable.graph!.sections[0]
  const chart = diagramLayout(readable.nodes, graph)
  expect(chart.rail).toBeDefined()
  expect(chart.width).toBeLessThan(320)
  expect(chart.edges.map((e) => [e.from, e.to, e.label]).sort()).toEqual(
    graph.edges.map((e) => [e.from, e.to, e.label]).sort()
  )
})
