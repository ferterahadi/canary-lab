import { describe, it, expect } from 'vitest'
import type { Requirement } from '../../../../shared/coverage/types'
import type { LastPassingRun, PassingRunIndex } from './grounding'
import { computeCoverageLedger, type CoverageTestInput } from './ledger'

function req(id: string, pathTypes: Requirement['pathTypes'], extra: Partial<Requirement> = {}): Requirement {
  return { id, title: id, text: `${id} text`, pathTypes, ...extra }
}

function indexOf(...names: string[]): PassingRunIndex {
  const byTestName = new Map<string, LastPassingRun>()
  for (const name of names) {
    byTestName.set(name, { testName: name, runId: `run-${name}`, env: 'local', at: '2026-01-01T00:00:00Z' })
  }
  return { byTestName }
}

describe('computeCoverageLedger — gap classes', () => {
  it('untested: requirement with no annotated test', () => {
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy'])],
      tests: [],
      index: indexOf(),
    })
    expect(ledger.requirements[0].gapType).toBe('untested')
    expect(ledger.coveragePct).toBe(0)
  })

  it('unverified: annotated test exists but no passing run (the dangerous one)', () => {
    const tests: CoverageTestInput[] = [{ name: 'logs in', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy'])],
      tests,
      index: indexOf(), // 'logs in' never passed
    })
    expect(ledger.requirements[0].gapType).toBe('unverified')
    expect(ledger.requirements[0].annotatedTestNames).toEqual(['logs in'])
    expect(ledger.requirements[0].verifiedTestNames).toEqual([])
  })

  it('verified: annotated test with a passing run covering all implied paths', () => {
    const tests: CoverageTestInput[] = [{ name: 'logs in', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy'])],
      tests,
      index: indexOf('logs in'),
    })
    expect(ledger.requirements[0].gapType).toBe('verified')
    expect(ledger.requirements[0].lastPassingRun?.runId).toBe('run-logs in')
    expect(ledger.coveragePct).toBe(100)
  })

  it('path-incomplete: happy verified but sad path missing', () => {
    const tests: CoverageTestInput[] = [{ name: 'happy login', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy', 'sad'])],
      tests,
      index: indexOf('happy login'),
    })
    const r = ledger.requirements[0]
    expect(r.gapType).toBe('path-incomplete')
    expect(r.pathCoverage).toEqual([
      { path: 'happy', verified: true },
      { path: 'sad', verified: false },
    ])
  })

  it('path-incomplete becomes verified once the sad path has a passing run', () => {
    const tests: CoverageTestInput[] = [
      { name: 'happy login', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'bad password rejected', requirements: ['R1'], pathTypes: ['sad'] },
    ]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy', 'sad'])],
      tests,
      index: indexOf('happy login', 'bad password rejected'),
    })
    expect(ledger.requirements[0].gapType).toBe('verified')
  })

  it('path is only counted from VERIFIED tests (annotated-but-unverified sad test does not satisfy)', () => {
    const tests: CoverageTestInput[] = [
      { name: 'happy login', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'sad login', requirements: ['R1'], pathTypes: ['sad'] },
    ]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy', 'sad'])],
      tests,
      index: indexOf('happy login'), // sad login annotated but never passed
    })
    expect(ledger.requirements[0].gapType).toBe('path-incomplete')
  })
})

describe('computeCoverageLedger — totals + %', () => {
  it('computes verified ÷ total with one decimal', () => {
    const requirements = [req('R1', ['happy']), req('R2', ['happy']), req('R3', ['happy'])]
    const tests: CoverageTestInput[] = [
      { name: 't1', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 't2', requirements: ['R2'], pathTypes: ['happy'] },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests, index: indexOf('t1') })
    // R1 verified, R2 unverified, R3 untested → 1/3
    expect(ledger.totals).toMatchObject({ total: 3, verified: 1, unverified: 1, untested: 1, pathIncomplete: 0 })
    expect(ledger.coveragePct).toBe(33.3)
  })

  it('excludes deprecated requirements from the denominator', () => {
    const requirements = [req('R1', ['happy']), req('R2', ['happy'], { deprecated: true })]
    const tests: CoverageTestInput[] = [{ name: 't1', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests, index: indexOf('t1') })
    expect(ledger.totals.total).toBe(1)
    expect(ledger.coveragePct).toBe(100)
  })

  it('empty requirement set yields 0% (no divide-by-zero)', () => {
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [], tests: [], index: indexOf() })
    expect(ledger.coveragePct).toBe(0)
  })
})

describe('computeCoverageLedger — tests + orphans', () => {
  it('defaults a test with no pathTypes to happy', () => {
    const tests: CoverageTestInput[] = [{ name: 't1', requirements: ['R1'] }]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy'])],
      tests,
      index: indexOf('t1'),
    })
    expect(ledger.tests[0].pathTypes).toEqual(['happy'])
    expect(ledger.requirements[0].gapType).toBe('verified')
  })

  it('flags orphan annotations pointing at unknown requirement ids', () => {
    const tests: CoverageTestInput[] = [{ name: 't1', requirements: ['R1', 'R99'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy'])],
      tests,
      index: indexOf('t1'),
    })
    expect(ledger.orphanRequirementIds).toEqual(['R99'])
  })

  it('marks tests verified/unverified and carries the passing run', () => {
    const tests: CoverageTestInput[] = [
      { name: 'passing', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'never ran', requirements: ['R1'], pathTypes: ['happy'] },
    ]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy'])],
      tests,
      index: indexOf('passing'),
    })
    expect(ledger.tests.find((t) => t.name === 'passing')?.verified).toBe(true)
    expect(ledger.tests.find((t) => t.name === 'never ran')?.verified).toBe(false)
  })
})
