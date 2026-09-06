import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dirtySummaryView } from './review-view'
import { testRequirementsOf, testRequirementsReader } from './test-requirements'
import type { DirtySpec, SpecStrength } from './detect'

let featureDir: string

beforeEach(() => {
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-view-'))
})

afterEach(() => {
  fs.rmSync(featureDir, { recursive: true, force: true })
})

const LIVE = `// @requirement checkout-1
test('applies voucher', async () => { expect(1).toBeTruthy() })
test('untagged', async () => { expect(2).toBe(2) })
`

function strength(tests: SpecStrength['tests']): SpecStrength {
  return { verdict: 'weaker', baseline: 'run-start', tests }
}

describe('dirtySummaryView', () => {
  it('is clean with no specs for a missing or clean record', () => {
    expect(dirtySummaryView(null, featureDir)).toEqual({ status: 'clean', specs: [] })
    expect(dirtySummaryView({ status: 'clean', dirtySpecs: [] }, featureDir)).toEqual({ status: 'clean', specs: [] })
  })

  it('passes a hash-only spec through without a strength', () => {
    const spec: DirtySpec = { file: 'e2e/a.spec.ts', affectedTests: ['applies voucher'] }
    expect(dirtySummaryView({ status: 'dirty', dirtySpecs: [spec] }, featureDir)).toEqual({
      status: 'dirty',
      specs: [{ file: 'e2e/a.spec.ts', affectedTests: ['applies voucher'] }],
    })
  })

  it('attaches the live @req ids to each changed test that carries them', () => {
    fs.mkdirSync(path.join(featureDir, 'e2e'))
    fs.writeFileSync(path.join(featureDir, 'e2e', 'a.spec.ts'), LIVE)
    const spec: DirtySpec = {
      file: 'e2e/a.spec.ts',
      affectedTests: ['applies voucher', 'untagged'],
      strength: strength([
        { kind: 'changed', name: 'applies voucher', verdict: 'weaker', changes: [] },
        { kind: 'changed', name: 'untagged', verdict: 'equivalent', changes: [] },
        { kind: 'deleted', name: 'gone', verdict: 'weaker', changes: [] },
      ]),
    }
    const view = dirtySummaryView({ status: 'dirty', dirtySpecs: [spec] }, featureDir)
    const tests = view.specs[0].strength!.tests
    expect(tests[0]).toMatchObject({ name: 'applies voucher', requirements: ['checkout-1'] })
    expect(tests[1]).not.toHaveProperty('requirements')
    expect(tests[2]).not.toHaveProperty('requirements')
    expect(view.specs[0].strength!.baseline).toBe('run-start')
  })

  it('carries no @req ids when the live spec is gone', () => {
    const spec: DirtySpec = {
      file: 'e2e/missing.spec.ts',
      affectedTests: ['applies voucher'],
      strength: strength([{ kind: 'deleted', name: 'applies voucher', verdict: 'weaker', changes: [] }]),
    }
    const view = dirtySummaryView({ status: 'dirty', dirtySpecs: [spec] }, featureDir)
    expect(view.specs[0].strength!.tests[0]).not.toHaveProperty('requirements')
  })
})

describe('testRequirementsReader', () => {
  it('reads the source once, and only on the first lookup', () => {
    let reads = 0
    const read = testRequirementsReader('e2e/a.spec.ts', () => { reads += 1; return LIVE })
    expect(reads).toBe(0)
    expect(read('applies voucher')).toEqual(['checkout-1'])
    expect(read('untagged')).toBeUndefined()
    expect(read('nope')).toBeUndefined()
    expect(reads).toBe(1)
  })

  it('answers undefined for every test when the source cannot be read', () => {
    const read = testRequirementsReader('e2e/a.spec.ts', () => undefined)
    expect(read('applies voucher')).toBeUndefined()
  })

  it('maps every declared test by name', () => {
    expect([...testRequirementsOf('e2e/a.spec.ts', LIVE).keys()]).toEqual(['applies voucher', 'untagged'])
  })
})
