import { describe, it, expect } from 'vitest'
import type { Requirement } from '../../../../../../../shared/coverage/types'
import { computeCoverageLedger, type CoverageTestInput } from './ledger'

// Semantic coverage is decoupled from test runs: a requirement is `covered` when
// every declared path is CLAIMED by a mapped test (no passing run required).

function req(id: string, pathTypes: Requirement['pathTypes'], extra: Partial<Requirement> = {}): Requirement {
  return { id, title: id, text: `${id} text`, pathTypes, ...extra }
}

describe('computeCoverageLedger — gap classes', () => {
  it('untested: requirement with no mapped test', () => {
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy'])], tests: [] })
    expect(ledger.requirements[0].gapType).toBe('untested')
    expect(ledger.coveragePct).toBe(0)
  })

  it('covered: a mapped test claims every declared path', () => {
    const tests: CoverageTestInput[] = [{ name: 'logs in', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy'])], tests })
    expect(ledger.requirements[0].gapType).toBe('covered')
    expect(ledger.requirements[0].annotatedTestNames).toEqual(['logs in'])
    expect(ledger.coveragePct).toBe(100)
  })

  it('path-incomplete: happy claimed but sad path missing', () => {
    const tests: CoverageTestInput[] = [{ name: 'happy login', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy', 'sad'])], tests })
    const r = ledger.requirements[0]
    expect(r.gapType).toBe('path-incomplete')
    expect(r.pathCoverage).toEqual([
      { path: 'happy', covered: true },
      { path: 'sad', covered: false },
    ])
  })

  it('path-incomplete becomes covered once a test claims the sad path', () => {
    const tests: CoverageTestInput[] = [
      { name: 'happy login', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'bad password rejected', requirements: ['R1'], pathTypes: ['sad'] },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy', 'sad'])], tests })
    expect(ledger.requirements[0].gapType).toBe('covered')
  })

  it('a path is claimed by ANY mapped test (runs are irrelevant)', () => {
    const tests: CoverageTestInput[] = [
      { name: 'happy login', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'sad login', requirements: ['R1'], pathTypes: ['sad'] },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy', 'sad'])], tests })
    expect(ledger.requirements[0].gapType).toBe('covered')
  })
})

describe('computeCoverageLedger — totals + %', () => {
  it('computes covered ÷ total with one decimal + mapped %', () => {
    const requirements = [req('R1', ['happy']), req('R2', ['happy', 'sad']), req('R3', ['happy'])]
    const tests: CoverageTestInput[] = [
      { name: 't1', requirements: ['R1'], pathTypes: ['happy'] }, // R1 covered
      { name: 't2', requirements: ['R2'], pathTypes: ['happy'] }, // R2 path-incomplete (sad missing)
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests })
    // R1 covered, R2 path-incomplete, R3 untested → covered 1/3
    expect(ledger.totals).toMatchObject({ total: 3, covered: 1, pathIncomplete: 1, untested: 1 })
    expect(ledger.coveragePct).toBe(33.3)
    // Breadth: R1 + R2 have a test mapped (only R3 untested) → 2/3 mapped.
    expect(ledger.mappedPct).toBe(66.7)
  })

  it('excludes deprecated requirements from the denominator', () => {
    const requirements = [req('R1', ['happy']), req('R2', ['happy'], { deprecated: true })]
    const tests: CoverageTestInput[] = [{ name: 't1', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests })
    expect(ledger.totals.total).toBe(1)
    expect(ledger.coveragePct).toBe(100)
  })

  it('empty requirement set yields 0% (no divide-by-zero)', () => {
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [], tests: [] })
    expect(ledger.coveragePct).toBe(0)
    expect(ledger.mappedPct).toBe(0)
  })
})

describe('computeCoverageLedger — tests + orphans', () => {
  it('defaults a test with no pathTypes to happy', () => {
    const tests: CoverageTestInput[] = [{ name: 't1', requirements: ['R1'] }]
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy'])], tests })
    expect(ledger.tests[0].pathTypes).toEqual(['happy'])
    expect(ledger.requirements[0].gapType).toBe('covered')
  })

  it('flags orphan annotations pointing at unknown requirement ids', () => {
    const tests: CoverageTestInput[] = [{ name: 't1', requirements: ['R1', 'R99'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy'])], tests })
    expect(ledger.orphanRequirementIds).toEqual(['R99'])
  })

  it('lists tests with no requirement linkage as orphan tests (sorted)', () => {
    const tests: CoverageTestInput[] = [
      { name: 'mapped', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'zzz orphan', pathTypes: ['happy'] },
      { name: 'aaa orphan' },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', ['happy'])], tests })
    expect(ledger.orphanTestNames).toEqual(['aaa orphan', 'zzz orphan'])
    expect(ledger.totals.orphanTests).toBe(2)
  })

  it('falls back to DEFAULT_PATHS when requirement.pathTypes is empty', () => {
    const tests: CoverageTestInput[] = [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }]
    const ledger = computeCoverageLedger({ feature: 'f', requirements: [req('R1', [])], tests })
    expect(ledger.requirements[0].gapType).toBe('covered')
    expect(ledger.requirements[0].pathCoverage).toEqual([{ path: 'happy', covered: true }])
  })
})

describe('computeCoverageLedger — coverageStatus roll-up', () => {
  const cases: Array<[string, CoverageTestInput[], Requirement, string]> = [
    ['covered', [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }], req('R1', ['happy']), 'covered'],
    ['uncovered (untested)', [], req('R1', ['happy']), 'uncovered'],
    ['partial (path-incomplete)', [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }], req('R1', ['happy', 'sad']), 'partial'],
  ]
  for (const [label, tests, requirement, expected] of cases) {
    it(label, () => {
      const ledger = computeCoverageLedger({ feature: 'f', requirements: [requirement], tests })
      expect(ledger.requirements[0].coverageStatus).toBe(expected)
    })
  }
})

// The variant axis (D1). Coverage becomes `requirement × path × variant`: a
// requirement that bundles N variants but is tested on one is variant-incomplete,
// NOT covered. This is the cns-proper-auth blind spot the 2-axis model missed.
describe('computeCoverageLedger — variant axis', () => {
  const CHANNELS = ['email', 'whatsapp', 'call', 'line']

  it('the cns-proper-auth case: "all 4 channels", only email tested → variant-incomplete, not covered', () => {
    const requirements = [req('R6', ['happy', 'sad'], { variants: CHANNELS })]
    const tests: CoverageTestInput[] = [
      { name: 'sender V4 owner read', requirements: ['R6'], pathTypes: ['happy'], variants: ['email'] },
      { name: 'sender V4 foreign read', requirements: ['R6'], pathTypes: ['sad'], variants: ['email'] },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests })
    const r = ledger.requirements[0]
    // 2-axis math would have said covered (both happy & sad claimed) → 100%.
    expect(r.gapType).toBe('variant-incomplete')
    expect(r.coverageStatus).toBe('partial')
    expect(ledger.coveragePct).toBe(0) // 0 of 1 requirement fully covered
    expect(ledger.totals).toMatchObject({ total: 1, covered: 0, variantIncomplete: 1 })
    // 4 channels × 2 paths = 8 cells; only the 2 email cells are claimed.
    expect(r.variantCoverage).toHaveLength(8)
    expect(r.variantCoverage!.filter((c) => c.covered)).toEqual([
      { path: 'happy', variant: 'email', covered: true },
      { path: 'sad', variant: 'email', covered: true },
    ])
  })

  it('becomes covered once every (path × variant) cell is claimed', () => {
    const requirements = [req('R6', ['happy'], { variants: ['email', 'whatsapp'] })]
    const tests: CoverageTestInput[] = [
      { name: 'email', requirements: ['R6'], pathTypes: ['happy'], variants: ['email'] },
      { name: 'whatsapp', requirements: ['R6'], pathTypes: ['happy'], variants: ['whatsapp'] },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests })
    expect(ledger.requirements[0].gapType).toBe('covered')
    expect(ledger.coveragePct).toBe(100)
  })

  it('one test may claim multiple variants (cross-product of its paths × variants)', () => {
    const requirements = [req('R6', ['happy'], { variants: ['email', 'whatsapp'] })]
    const tests: CoverageTestInput[] = [
      { name: 'both channels', requirements: ['R6'], pathTypes: ['happy'], variants: ['email', 'whatsapp'] },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests })
    expect(ledger.requirements[0].gapType).toBe('covered')
  })

  it('a variant-agnostic test (no variants) satisfies no variant cell', () => {
    const requirements = [req('R6', ['happy'], { variants: ['email', 'whatsapp'] })]
    const tests: CoverageTestInput[] = [
      { name: 'untyped', requirements: ['R6'], pathTypes: ['happy'] }, // no variants
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests })
    expect(ledger.requirements[0].gapType).toBe('variant-incomplete')
    expect(ledger.requirements[0].variantCoverage!.every((c) => !c.covered)).toBe(true)
  })

  it('claims for variants outside the requirement set are ignored (controlled vocabulary)', () => {
    const requirements = [req('R6', ['happy'], { variants: ['email'] })]
    const tests: CoverageTestInput[] = [
      { name: 'email + stray', requirements: ['R6'], pathTypes: ['happy'], variants: ['email', 'sms'] },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests })
    // Only the declared `email` cell exists; the stray `sms` claim adds no cell.
    expect(ledger.requirements[0].variantCoverage).toHaveLength(1)
    expect(ledger.requirements[0].gapType).toBe('covered')
  })

  it('a requirement with NO variants is unchanged (2-axis path model)', () => {
    const requirements = [req('R1', ['happy', 'sad'])] // no variants
    const tests: CoverageTestInput[] = [
      { name: 't', requirements: ['R1'], pathTypes: ['happy', 'sad'], variants: ['email'] },
    ]
    const ledger = computeCoverageLedger({ feature: 'f', requirements, tests })
    const r = ledger.requirements[0]
    expect(r.gapType).toBe('covered')
    expect(r.variantCoverage).toBeUndefined()
  })
})
