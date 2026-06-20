import { describe, it, expect } from 'vitest'
import { deriveCoverageStateView, type DeriveStateInput } from './state'

const base: DeriveStateInput = {
  hasSummary: true,
  summaryDrifted: false,
  changedDocs: [],
  hasAnnotatedTests: true,
  coverageStale: false,
  coveragePct: 80,
  activeJob: null,
}

const view = (over: Partial<DeriveStateInput>) => deriveCoverageStateView({ ...base, ...over })

describe('deriveCoverageStateView — summary axis', () => {
  it('absent → Setup needed, coverage blocked', () => {
    const s = view({ hasSummary: false })
    expect(s.summary).toBe('absent')
    expect(s.coverage).toBe('blocked')
    expect(s.headline).toBe('Setup needed')
  })

  it('generating job wins over everything', () => {
    expect(view({ activeJob: 'summary' }).summary).toBe('generating')
    expect(view({ activeJob: 'summary' }).headline).toBe('Generating')
    expect(view({ activeJob: 'coverage' }).coverage).toBe('generating')
  })

  it('stale summary → Stale, names changed docs + both artifacts', () => {
    const s = view({ summaryDrifted: true, changedDocs: ['prd.md'] })
    expect(s.summary).toBe('stale')
    expect(s.coverage).toBe('blocked')
    expect(s.headline).toBe('Stale')
    expect(s.drift).toEqual({
      drifted: true,
      changedDocs: ['prd.md'],
      affectedArtifacts: ['PRD summary', 'coverage ledger'],
    })
  })
})

describe('deriveCoverageStateView — coverage axis (summary fresh)', () => {
  it('no annotated tests → No coverage', () => {
    const s = view({ hasAnnotatedTests: false })
    expect(s.summary).toBe('fresh')
    expect(s.coverage).toBe('absent')
    expect(s.headline).toBe('No coverage')
  })

  it('requirements set moved → coverage Stale, only coverage artifact affected', () => {
    const s = view({ coverageStale: true })
    expect(s.coverage).toBe('stale')
    expect(s.headline).toBe('Stale')
    expect(s.drift.affectedArtifacts).toEqual(['coverage ledger'])
    expect(s.drift.drifted).toBe(false)
  })

  it('fresh both axes → Covered N%', () => {
    expect(view({ coveragePct: 73.5 }).headline).toBe('Covered 73.5%')
  })
})
