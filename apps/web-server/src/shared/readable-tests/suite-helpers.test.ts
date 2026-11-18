import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { extractTestsFromSource } from '../ast-extractor'
import { suiteHelperResolver } from './suite-helpers'

let dir: string
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-suite-'))) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function extract(source: string) {
  return extractTestsFromSource(path.join(dir, 'probe.spec.ts'), source, undefined, suiteHelperResolver(dir)).tests[0].readable.nodes
}

it('resolves the bound import through a local helper and retains the definition file, lines and exit', () => {
  const helper = path.join(dir, 'health.ts')
  fs.writeFileSync(helper, [
    'export async function poll(deadline: number) {',
    '  while (Date.now() < deadline) {',
    '    if (healthy()) return',
    '  }',
    '  throw new Error("timeout")',
    '}',
  ].join('\n'))
  const nodes = extract("import {poll as wait} from './health'\nasync function recover() { await wait(3000) }\ntest('probe', async () => { await recover() })")
  expect(nodes[0]).toMatchObject({ kind: 'group', children: [{ kind: 'group',
    implementation: {
      source: { file: helper, startLine: 1, endLine: 6, snippet: expect.stringContaining('throw new Error("timeout")') },
      story: { steps: [{ kind: 'flow', flowKind: 'loop', source: { file: helper, startLine: 2 } }, { source: { startLine: 5 } }] },
    }, children: [
    { kind: 'loop', flow: { label: 'Before deadline?' }, source: { file: helper, startLine: 2 },
      children: [{ kind: 'branch', paths: [{ children: [{ flow: { kind: 'return' } }] }] }] },
    { flow: { kind: 'throw', label: 'Report timeout' } },
  ] }] })
})

it('respects bindings, recursion, and the retained suite boundary', () => {
  const root = path.join(dir, 'suite')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(dir, 'other.ts'), 'export function read() { external() }')
  fs.symlinkSync(path.join(dir, 'other.ts'), path.join(root, 'linked.ts'))
  fs.writeFileSync(path.join(root, 'local.ts'), 'export function recurse() { recurse() }')
  const source = [
    "import {read} from './linked'",
    "import {recurse} from './local'",
    "test('bound', async ({recurse}) => { await read(); await recurse() })",
    "test('cycle', async () => { recurse() })",
  ].join('\n')
  const [bound, cycle] = extractTestsFromSource(path.join(root, 'example.spec.ts'), source, undefined, suiteHelperResolver(root)).tests
  expect(bound.readable.nodes.map(n => n.kind)).toEqual(['leaf', 'leaf'])
  expect(cycle.readable.nodes[0]).toMatchObject({ kind: 'group', children: [{ fidelity: 'unresolved' }] })
})
