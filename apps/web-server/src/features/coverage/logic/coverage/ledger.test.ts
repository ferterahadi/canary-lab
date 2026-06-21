import { describe, it, expect } from 'vitest'
import type { Requirement } from '../../../../../../../shared/coverage/types'
import type { LastPassingRun, PassingRunIndex } from '../../../coverage/logic/coverage/grounding'
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

/** Build an index with explicit `at` timestamps for pickMostRecent branch coverage. */
function indexOfWithAt(entries: { name: string; at: string }[]): PassingRunIndex {
  const byTestName = new Map<string, LastPassingRun>()
  for (const { name, at } of entries) {
    byTestName.set(name, { testName: name, runId: `run-${name}`, at })
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
    // Breadth: R1 + R2 have a test mapped (only R3 untested) → 2/3 mapped.
    expect(ledger.mappedPct).toBe(66.7)
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
    expect(ledger.mappedPct).toBe(0)
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

  it('lists tests with no requirement linkage as orphan tests', () => {
    const tests: CoverageTestInput[] = [
      { name: 'mapped', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'zzz orphan', pathTypes: ['happy'] },
      { name: 'aaa orphan' },
    ]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', ['happy'])],
      tests,
      index: indexOf('mapped'),
    })
    expect(ledger.orphanTestNames).toEqual(['aaa orphan', 'zzz orphan']) // sorted
    expect(ledger.totals.orphanTests).toBe(2)
  })
})

describe('computeCoverageLedger — pickMostRecent (lines 51-53)', () => {
  it('pickMostRecent TRUE branch: selects the run with the newer at timestamp', () => {
    // Two verified tests for the same requirement; t2 has a newer at → should win.
    const tests: CoverageTestInput[] = [
      { name: 't1', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 't2', requirements: ['R1'], pathTypes: ['happy'] },
    ]
    const index = indexOfWithAt([
      { name: 't1', at: '2026-01-01T00:00:00Z' },
      { name: 't2', at: '2026-06-01T00:00:00Z' }, // newer → a > b is true for this run
    ])
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy'])], tests, index })
    expect(ledger.requirements[0].lastPassingRun?.testName).toBe('t2')
  })

  it('pickMostRecent FALSE branch: keeps first when second is older', () => {
    // t1 is newer; t2 is older → when processing t2, a > b is false, best stays t1.
    const tests: CoverageTestInput[] = [
      { name: 't1', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 't2', requirements: ['R1'], pathTypes: ['happy'] },
    ]
    const index = indexOfWithAt([
      { name: 't1', at: '2026-06-01T00:00:00Z' }, // set first → becomes initial best
      { name: 't2', at: '2026-01-01T00:00:00Z' }, // older → a > b is false, best unchanged
    ])
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy'])], tests, index })
    expect(ledger.requirements[0].lastPassingRun?.testName).toBe('t1')
  })

  it('pickMostRecent ?? branches: falls back to empty string when at is undefined (lines 51-52)', () => {
    // Two runs with no `at` field → a ?? '' and b ?? '' both resolve to '' →
    // a > b is false, best stays as the first run encountered.
    const tests: CoverageTestInput[] = [
      { name: 't1', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 't2', requirements: ['R1'], pathTypes: ['happy'] },
    ]
    const index: PassingRunIndex = {
      byTestName: new Map([
        ['t1', { testName: 't1', runId: 'run-t1', env: 'local' }], // at is undefined
        ['t2', { testName: 't2', runId: 'run-t2', env: 'local' }], // at is undefined
      ]),
    }
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy'])], tests, index })
    // With both at undefined, a ?? '' === b ?? '' === '' → a > b is false → first run wins
    expect(ledger.requirements[0].lastPassingRun).toBeDefined()
  })

  it('falls back to DEFAULT_PATHS when requirement.pathTypes is empty (line 98 branch)', () => {
    // req with [] pathTypes → impliedPaths = DEFAULT_PATHS (['happy'])
    const tests: CoverageTestInput[] = [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({
      feature: 'f',
      requirements: [req('R1', [])],
      tests,
      index: indexOf('t'),
    })
    // Default path is 'happy', test covers it → verified
    expect(ledger.requirements[0].gapType).toBe('verified')
    expect(ledger.requirements[0].pathCoverage).toEqual([{ path: 'happy', verified: true }])
  })
})

describe('computeCoverageLedger — coverageStatus roll-up', () => {
  const cases: Array<[string, CoverageTestInput[], Requirement, string[], string]> = [
    ['covered (verified)', [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }], req('R1', ['happy']), ['t'], 'covered'],
    ['uncovered (untested)', [], req('R1', ['happy']), [], 'uncovered'],
    ['partial (unverified)', [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }], req('R1', ['happy']), [], 'partial'],
    ['partial (path-incomplete)', [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }], req('R1', ['happy', 'sad']), ['t'], 'partial'],
  ]
  for (const [label, tests, requirement, passing, expected] of cases) {
    it(label, () => {
      const ledger = computeCoverageLedger({ feature: 'f', requirements: [requirement], tests, index: indexOf(...passing) })
      expect(ledger.requirements[0].coverageStatus).toBe(expected)
    })
  }
})
