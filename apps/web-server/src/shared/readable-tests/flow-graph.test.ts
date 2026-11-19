import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import type { FlowBox, InvocationGraph } from '../../../../../shared/test-view/flow-graph'
import { extractTestsFromSource } from '../ast-extractor'
import { suiteHelperResolver } from './suite-helpers'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function fromBody(body: string) {
  const file = 'probe.spec.ts'
  const source = `test('probe', async () => {\n${body}\n})`
  const result = extractTestsFromSource(file, source, undefined, undefined, { kind: 'before' })
  expect(result.parseError).toBeUndefined()
  return result.tests[0].readable.graph!.sections[0]
}
function onLine(graph: InvocationGraph, line: number): FlowBox {
  const boxes = graph.boxes.filter(box => box.range?.startLine === line)
  expect(boxes).toHaveLength(1)
  return boxes[0]
}
function next(graph: InvocationGraph, from: FlowBox, kind: string) {
  const matches = graph.edges.filter(edge => edge.from === from.id && edge.kind === kind)
  expect(matches).toHaveLength(1)
  return graph.boxes.find(box => box.id === matches[0].to)!
}

it('preserves retry, healthy exit, thrown timeout and the caller continuations across a retained helper', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-')))
  dirs.push(dir)
  const file = path.join(dir, 'probe.spec.ts')
  const helper = path.join(dir, 'health.ts')
  const source = "import {poll} from './health'\ntest('probe', async () => {\n  await poll()\n  await publish()\n})"
  const body = [
    'export async function poll() {', '  while (beforeDeadline()) {', '    try {',
    '      const response = await check()', '      if (response.ok) return', '    } catch { /* retry the health check */ }',
    '    await wait()', '  }', '  throw new Error("timeout")', '}',
  ].join('\n')
  fs.writeFileSync(helper, body)
  const extract = () => extractTestsFromSource(file, source, undefined, suiteHelperResolver(dir),
    { kind: 'recorded-run', runId: 'run1' }).tests[0].readable.graph!
  const graph = extract()
  expect(extract()).toEqual(graph)
  expect(graph).toMatchObject({ schemaVersion: 1, case: { file, line: 2, title: 'probe' }, origin: { kind: 'recorded-run', runId: 'run1' } })
  for (const [location, text] of [[file, source], [helper, body]]) {
    expect(graph.revisions[location]).toBe(createHash('sha256').update(text).digest('hex'))
  }
  const [caller, poll] = graph.sections
  const call = onLine(caller, 3)
  expect(call.invocation).toBe(poll.id)
  expect(call.collapsedCount).toBeGreaterThan(0)
  expect(poll.parent).toBe(caller.id)
  expect(poll.definition.file).toBe(helper)
  expect(source.slice(call.range!.startOffset, call.range!.endOffset)).toBe('await poll()')
  expect(call.range).toMatchObject({ startLine: 3, startColumn: 3, endColumn: 15 })
  expect(next(caller, call, 'next')).toEqual(onLine(caller, 4))
  expect(next(caller, call, 'exception').id).toBe('error-end')
  const decision = onLine(poll, 2)
  expect(next(poll, decision, 'loop-exit')).toEqual(onLine(poll, 9))
  expect(next(poll, onLine(poll, 9), 'throw').id).toBe('error-end')
  expect(next(poll, onLine(poll, 7), 'loop-back')).toEqual(decision)
  const healthy = poll.boxes.find(box => box.label === 'Return')!
  expect(next(poll, healthy, 'return').id).toBe('end')
  expect(next(poll, onLine(poll, 4), 'exception')).toEqual(onLine(poll, 6))
  expect(next(poll, onLine(poll, 6), 'next')).toEqual(onLine(poll, 7))
  fs.writeFileSync(helper, body+'\n// new revision')
  expect(extract().revisions).toEqual({ ...graph.revisions, [helper]: createHash('sha256').update(body+'\n// new revision').digest('hex') })
})

it('executes finally before resuming each pending completion and allows cleanup to override it', () => {
  const g = fromBody('try {\n  if (stop) return\n  throw problem\n} catch {\n  if (recover) return\n  throw failure\n} finally {\n  if (override) throw replacement\n  count++\n}\nfinished++')
  for (const [line, kind, expected] of [[3, 'return', 'end'], [6, 'return', 'end'], [7, 'throw', 'error-end']] as const) {
    const transfer = g.boxes.find(box => box.range?.startLine === line && g.edges.some(e => e.from === box.id && e.kind === kind))!
    const cleanup = next(g, transfer, kind)
    expect(cleanup.range?.startLine).toBe(8)
    const condition = next(g, cleanup, 'next')
    const paths = g.edges.filter(e => e.from === condition.id && e.kind === 'branch')
    const override = g.boxes.find(b => b.id === paths.find(e => e.label === 'Yes')!.to)!
    expect(next(g, override, 'throw').id).toBe('error-end')
    const count = g.boxes.find(b => b.id === paths.find(e => e.label === 'No')!.to)!
    expect(next(g, count, 'next').id).toBe(expected)
  }
  expect(next(g, onLine(g, 4), 'throw')).toEqual(onLine(g, 5))
})

it('routes continue through the increment, break past the loop, and switch fallthrough through the next case body', () => {
  const g = fromBody('for (let i=0; i<3; i++) {\n  try {\n    if (skip) continue\n    break\n  } finally {\n    counter++\n  }\n}\nswitch (mode) {\ncase 1: first++\ncase 2: second++; break\ndefault: other++\n}\nlast++')
  const increment = g.boxes.find(b => b.label === 'i++')!
  const condition = g.boxes.find(b => b.shape === 'decision' && b.range?.startLine === 2)!
  expect(next(g, increment, 'loop-back')).toEqual(condition)
  for (const [kind, expected] of [['continue', increment], ['break', onLine(g,10)]] as const) {
    const transfer = g.boxes.find(b => b.label === kind)!
    // "break" occurs in the switch as well; use the pending loop transfer.
    const loopTransfer = kind === 'break' ? onLine(g,5) : transfer
    const cleanup = next(g, loopTransfer, kind)
    expect(next(g, next(g, cleanup, 'next'), 'next')).toEqual(expected)
  }
  expect(next(g, onLine(g,11), 'next').range?.startLine).toBe(12)
  expect(next(g, g.boxes.find(b=>b.range?.startLine===12 && b.label==='break')!, 'break')).toEqual(onLine(g,15))
  const doWhile = fromBody('do {\n  value++\n} while (ready)\nlast++')
  expect(doWhile.edges.find(e=>e.from===doWhile.entry)?.to).toBe(onLine(doWhile,3).id)
})

it('keeps repeated calls distinct, bounds recursion and preserves declarations, callbacks and unsupported jumps', () => {
  const file = 'probe.spec.ts'
  const source = `function again() { again() }
test('probe', async () => {
  function unused() { throw new Error('never called') }
  await again()
  await again()
  transport.on('data', () => { skip++ })
  await test.step('inside', async () => { return })
  after++
  outer: while (true) { break outer }
})`
  const graph = extractTestsFromSource(file, source, undefined, undefined, { kind: 'after' }).tests[0].readable.graph!
  expect(graph.completeness).toBe('partial')
  expect(graph.sections).toHaveLength(3)
  const [g, a, b] = graph.sections
  expect(a.id).not.toBe(b.id)
  expect(a.definition).toEqual(b.definition)
  expect(a.boxes.some(box=>box.reason && box.range?.file===file)).toBe(true)
  expect(onLine(g,3).boundary).toBe('declaration')
  expect(onLine(g,6)).toMatchObject({ boundary:'callback', reason:expect.any(String) })
  expect(g.boxes.some(box=>box.label==='Raise error')).toBe(false)
  const ret = g.boxes.find(box=>box.label==='Return')!
  expect(next(g,ret,'return')).toEqual(onLine(g,8))
  const jump = onLine(g,9)
  expect(jump.reason).toBeTruthy()
  expect(g.edges.filter(e=>e.from===jump.id)).toHaveLength(0)
})

it('keeps unawaited helpers, generators and detached step bodies out of the synchronous path', () => {
  const g = fromBody([
    'async function task() { await background() }',
    'function* entries() { yield 42 }',
    'task()',
    'const it = entries()',
    "test.step('detached', async () => { return })",
    'value++',
  ].join('\n'))
  for (const line of [4, 5, 6]) {
    const node = onLine(g, line)
    expect(node).toMatchObject({ boundary: 'callback', reason: expect.any(String) })
    expect(node.invocation).toBeUndefined()
    expect(next(g, node, 'next')).toEqual(onLine(g, line + 1))
  }
})
