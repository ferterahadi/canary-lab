import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mappingInferenceSnapshot, rememberMappingInference, unexaminedMappingTests, type MappingInferenceCache, type MappingTestInput } from './mapping-cache'

let featureDir: string
const tests: MappingTestInput[] = [{ name: 'test', file: 'e2e/test.spec.ts', bodySource: 'expect(value).toBe(1)', assertions: ['expect(value).toBe(1)'] }]
const requirements = [{ id: 'R1', title: 'It works', text: 'It should work.', pathTypes: ['happy' as const] }]
const snapshot = () => mappingInferenceSnapshot(featureDir, tests, requirements)
beforeEach(() => {
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mapping-inputs-'))
  fs.mkdirSync(path.join(featureDir, 'e2e'))
  fs.writeFileSync(path.join(featureDir, 'e2e/test.spec.ts'), "test('test', () => { expect(value).toBe(1) })")
})
afterEach(() => fs.rmSync(featureDir, { recursive: true, force: true }))

it('tracks transitive and cyclic imports, including an unresolved helper becoming available', () => {
  fs.mkdirSync(path.join(featureDir, 'support'))
  fs.writeFileSync(path.join(featureDir, 'support/a.ts'), "import './b'; export const a=1")
  fs.writeFileSync(path.join(featureDir, 'support/b.ts'), "import './a'; export const b=2")
  fs.writeFileSync(path.join(featureDir, 'e2e/test.spec.ts'), "import '../support/a'; import './missing'; test('test', () => { expect(value).toBe(1) })")
  const before = snapshot()
  expect(before.tests.test).toBeTruthy()
  fs.writeFileSync(path.join(featureDir, 'support/b.ts'), "import './a'; export const b=3")
  expect(snapshot()).not.toEqual(before)
  const beforeResolve = snapshot()
  fs.writeFileSync(path.join(featureDir, 'e2e/missing.ts'), 'export const value=1')
  expect(snapshot()).not.toEqual(beforeResolve)
})

it('tracks support data and dynamic helpers, handles directory cycles, and excludes generated results', () => {
  const dataDir = path.join(featureDir, 'e2e/data')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dataDir, 'a.json'), '{"value":1}')
  fs.writeFileSync(path.join(dataDir, 'b.json'), '{"value":2}')
  fs.symlinkSync(dataDir, path.join(dataDir, 'cycle'))
  fs.mkdirSync(path.join(featureDir, 'e2e/test-results'))
  const before = snapshot()
  fs.writeFileSync(path.join(featureDir, 'e2e/test-results/run.json'), 'run 1')
  expect(snapshot()).toEqual(before)
  fs.writeFileSync(path.join(dataDir, 'a.json'), '{"value":3}')
  expect(snapshot()).not.toEqual(before)
})

it('re-examines inputs it cannot read instead of remembering a partial fingerprint', () => {
  fs.rmSync(path.join(featureDir, 'e2e/test.spec.ts'))
  expect(snapshot().tests).toEqual({})
  expect(unexaminedMappingTests(tests, snapshot(), undefined)).toEqual(tests)
  fs.rmSync(path.join(featureDir, 'e2e'), { recursive: true })
  expect(snapshot().tests).toEqual({})
})

it('does not reuse incomplete legacy caches or stale requirements and prunes deleted tests', () => {
  const current = snapshot()
  for (const prior of [{ version: 0 }, { version: 1 }, { version: 1, tests: { test: { fingerprint: current.tests.test } } }]) {
    expect(unexaminedMappingTests(tests, current, prior as MappingInferenceCache)).toEqual(tests)
  }
  const remembered = rememberMappingInference(current, ['test'], undefined)
  expect(unexaminedMappingTests(tests, current, remembered)).toEqual([])
  expect(rememberMappingInference({ ...current, tests: {} }, [], remembered).tests).toEqual({})
  expect(rememberMappingInference({ ...current, tests: { test: 'changed' } }, [], remembered).tests).toEqual({})
  expect(rememberMappingInference(current, ['test'], { version: 0 } as unknown as MappingInferenceCache).tests.test).toBeDefined()
})

it('disables reuse if a compiler config cannot be read', () => {
  const config = path.join(featureDir, 'tsconfig.json')
  fs.writeFileSync(config, '{}')
  fs.chmodSync(config, 0o000)
  try { expect(snapshot().tests).toEqual({}) }
  finally { fs.chmodSync(config, 0o600) }
})
