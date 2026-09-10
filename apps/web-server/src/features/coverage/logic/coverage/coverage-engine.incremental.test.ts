import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Requirement } from '../../../../../../../shared/coverage/types'
import { applyExternalCoverageMappings, buildCoverageMappingContext, runCoverageEngine, type RunCoverageEngineDeps } from './coverage-engine'
import { requirementsSetHash } from './fingerprints'
import { readCoverageRunState } from './run-state'

let root: string
let featureDir: string
let spec: string
let requirements: Requirement[]
const feature = 'checkout'
const source = `import { test, expect } from '@playwright/test'
test('first', async () => { expect(1).toBe(1) })
test('second', async () => { expect(2).toBe(2) })
`

function writeSummary(): void {
  fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), JSON.stringify({
    feature, generatedAt: '2026-09-06T00:00:00Z', docsHash: 'docs',
    requirements, requirementsHash: requirementsSetHash(requirements),
  }))
}

const args = () => ({ featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs'), feature, incremental: true })

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mapping-cache-')))
  featureDir = path.join(root, 'features', feature)
  spec = path.join(featureDir, 'e2e', 'checkout.spec.ts')
  fs.mkdirSync(path.dirname(spec), { recursive: true })
  fs.mkdirSync(path.join(featureDir, 'docs'))
  fs.mkdirSync(path.join(root, 'logs'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `module.exports = { config: { name: 'checkout', description: 'checkout', envs: ['local'], featureDir: __dirname } }`)
  fs.writeFileSync(spec, source)
  requirements = [{ id: 'R1', title: 'Checkout', text: 'Complete checkout', pathTypes: ['happy'] }]
  writeSummary()
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('incremental mapping with real source inputs', () => {
  it('reuses examined negative answers, then examines only an edited or added test', async () => {
    const propose = vi.fn<NonNullable<RunCoverageEngineDeps['propose']>>(async () => [])
    await runCoverageEngine(args(), { propose })
    await runCoverageEngine(args(), { propose })
    expect(propose).toHaveBeenCalledTimes(1)
    expect(readCoverageRunState(featureDir)?.mappingInference?.tests.first).toBeDefined()

    fs.writeFileSync(spec, source.replace('expect(1)', 'expect(3)'))
    await runCoverageEngine(args(), { propose })
    expect(propose.mock.calls[1][0].tests.map((test) => test.name)).toEqual(['first'])

    fs.appendFileSync(spec, "test('third', async () => { expect(3).toBe(3) })\n")
    await runCoverageEngine(args(), { propose })
    expect(propose.mock.calls[2][0].tests.map((test) => test.name)).toEqual(['third'])
  })

  it('keeps newly written tags reusable but remaps when those annotations are removed', async () => {
    const propose = vi.fn<NonNullable<RunCoverageEngineDeps['propose']>>(async () => [{ testName: 'first', requirements: ['R1'], pathTypes: ['happy' as const], source: 'agent' as const }])
    await runCoverageEngine(args(), { propose })
    const tagged = fs.readFileSync(spec, 'utf-8')
    expect(tagged).toContain('@req-R1')
    await runCoverageEngine(args(), { propose })
    expect(propose).toHaveBeenCalledTimes(1)
    fs.writeFileSync(spec, source)
    await runCoverageEngine(args(), { propose })
    expect(propose.mock.calls[1][0].tests.map((test) => test.name)).toEqual(['first'])
  })

  it('invalidates imported helpers, enclosing hooks and dependency lockfiles', async () => {
    const helper = path.join(featureDir, 'e2e', 'helper.ts')
    fs.writeFileSync(helper, 'export const value = 1\n')
    fs.writeFileSync(spec, `import { value } from './helper'\n${source}`)
    const propose = vi.fn<NonNullable<RunCoverageEngineDeps['propose']>>(async () => [])
    await runCoverageEngine(args(), { propose })
    fs.writeFileSync(helper, 'export const value = 2\n')
    await runCoverageEngine(args(), { propose })
    expect(propose.mock.calls[1][0].tests).toHaveLength(2)
    fs.appendFileSync(spec, 'test.beforeEach(async () => { await reset() })\n')
    await runCoverageEngine(args(), { propose })
    expect(propose.mock.calls[2][0].tests).toHaveLength(2)
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}')
    await runCoverageEngine(args(), { propose })
    expect(propose.mock.calls[3][0].tests).toHaveLength(2)
    // Four engine passes, each re-parsing the spec and its helper through the
    // TypeScript compiler. That fits the default 5s budget on an idle machine
    // and does not under v8 coverage with every worker busy.
  }, 30_000)

  it('examines unchanged tests against changed and newly scoped requirements', async () => {
    const propose = vi.fn<NonNullable<RunCoverageEngineDeps['propose']>>(async () => [])
    await runCoverageEngine(args(), { propose })
    requirements[0].text = 'Checkout must reject an expired card'
    writeSummary()
    await runCoverageEngine(args(), { propose })
    expect(propose.mock.calls[1][0].tests).toHaveLength(2)
    requirements.push({ id: 'R2', title: 'Refund', text: 'Refund an order', pathTypes: ['happy'] })
    writeSummary()
    await runCoverageEngine({ ...args(), requirementIds: ['R2'] }, { propose })
    expect(propose.mock.calls[2][0].requirements.map((r) => r.id)).toEqual(['R2'])
    expect(propose.mock.calls[2][0].tests).toHaveLength(2)
    await runCoverageEngine(args(), { propose })
    expect(propose).toHaveBeenCalledTimes(3)
  })

  it('keeps explicit full re-inference available and rejects changes during an incremental pass', async () => {
    const propose = vi.fn<NonNullable<RunCoverageEngineDeps['propose']>>(async () => [])
    await runCoverageEngine(args(), { propose })
    await runCoverageEngine({ ...args(), incremental: false }, { propose })
    expect(propose).toHaveBeenCalledTimes(2)
    fs.writeFileSync(spec, source.replace('expect(1)', 'expect(5)'))
    await expect(runCoverageEngine(args(), { propose: async () => {
      fs.writeFileSync(spec, source.replace('expect(1)', 'expect(6)'))
      return []
    } })).rejects.toThrow('Mapping inputs changed')
  })

  it('pins the external roster, remembers complete negative answers, and rejects stale submissions', () => {
    const context = buildCoverageMappingContext(args())
    expect(context.tests.map((test) => test.testName)).toEqual(['first', 'second'])
    const inference = { snapshot: context.inferenceSnapshot!, roster: context.tests.map((test) => test.testName) }
    applyExternalCoverageMappings({ ...args(), mappings: [], inference })
    expect(buildCoverageMappingContext(args()).tests).toEqual([])
    fs.writeFileSync(spec, source.replace('expect(1)', 'expect(7)'))
    expect(buildCoverageMappingContext(args()).tests.map((test) => test.testName)).toEqual(['first'])
    expect(() => applyExternalCoverageMappings({ ...args(), mappings: [], inference })).toThrow('Mapping inputs changed')
  })

  it('refuses incremental proposals outside the pinned test and requirement scope', async () => {
    requirements.push({ id: 'R2', title: 'Refund', text: 'Refund an order', pathTypes: ['happy'] })
    writeSummary()
    const out = await runCoverageEngine({ ...args(), requirementIds: ['R1'] }, { propose: async () => [
      { testName: 'unknown', requirements: ['R1'], source: 'agent' },
      { testName: 'first', requirements: ['R2'], source: 'agent' },
    ] })
    expect(out.applied).toEqual([])
    expect(fs.readFileSync(spec, 'utf-8')).toBe(source)
  })

  it('external inference uses canonical source paths and ignores answers for omitted tests', () => {
    const context = buildCoverageMappingContext(args())
    const result = applyExternalCoverageMappings({ ...args(), inference: { snapshot: context.inferenceSnapshot!, roster: ['first'] }, mappings: [
      { testName: 'second', requirements: ['R1'], source: 'agent' },
      { testName: 'first', file: 'wrong-file.ts', requirements: ['R1'], pathTypes: ['sad'], confidence: 0.3, source: 'agent' },
    ] })
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].file).toBe('e2e/checkout.spec.ts')
    expect(result.applied[0].issues).toContain('low confidence (0.30)')
    expect(buildCoverageMappingContext(args()).tests.map((test) => test.testName)).toEqual(['second'])
  })

  it('invalidates a requirement changed while an incremental mapper worked', async () => {
    await expect(runCoverageEngine(args(), { propose: async () => {
      requirements[0].text = 'It should refund an order.'
      writeSummary()
      return []
    } })).rejects.toThrow('Mapping inputs changed')
  })

  it('does not cache a full inference when its source changed during the agent call', async () => {
    await runCoverageEngine({ ...args(), incremental: false }, { propose: async () => {
      fs.writeFileSync(spec, source.replace('expect(1)', 'expect(99)'))
      return []
    } })
    expect(readCoverageRunState(featureDir)?.mappingInference).toBeUndefined()
  })
})
