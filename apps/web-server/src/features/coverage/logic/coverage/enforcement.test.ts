import { describe, expect, it } from 'vitest'
import type { CoverageLedger, Requirement, RequirementTestChange } from '../../../../../../../shared/coverage/types'
import { computeCoverageLedger } from './ledger'
import { applyEnforcement, deriveRequirementEnforcement, type RequirementHistory } from './enforcement'

// The ledger's time axis (D11): four enforcement states derived from three
// timestamps per requirement — when it was last PROVEN (a run), when its TESTS
// last changed meaning (a spec-edit classification joined through @req tags),
// when its WORDING last changed (fingerprint). Additive to gapType exactly as
// provenPct is: no gap type, no percentage, no status moves because of this.
//
// Fixture calendar, one day apart so "newer than" is unambiguous:
const D1 = '2026-09-01T00:00:00.000Z'
const D2 = '2026-09-02T00:00:00.000Z'
const D3 = '2026-09-03T00:00:00.000Z'
const D4 = '2026-09-04T00:00:00.000Z'

function req(extra: Partial<Requirement> = {}): Requirement {
  return { id: 'R1', title: 'Totals', text: 'The total adds up.', pathTypes: ['happy'], fingerprint: 'fp-now', wordingChangedAt: D1, ...extra }
}

function change(at: string, verdict: RequirementTestChange['verdict'] = 'changed'): RequirementTestChange {
  return { at, tests: ['totals add up'], verdict }
}

const none: RequirementHistory = { testChanges: [] }

describe('deriveRequirementEnforcement — one fixture per state', () => {
  it('proven-unchanged: the proof is newer than both the test and the wording change', () => {
    const e = deriveRequirementEnforcement(req(), { provenAt: { runId: 'r3', at: D3 }, testChanges: [change(D2)] }, D1)
    expect(e.state).toBe('proven-unchanged')
    expect(e.provenAt).toEqual({ runId: 'r3', at: D3 })
    expect(e.testsChangedAt).toEqual(change(D2))
    expect(e.wordingChangedAt).toBe(D1)
  })

  it('tests-weakened: a weaker classification on a mapped test after the proof', () => {
    const e = deriveRequirementEnforcement(req(), { provenAt: { runId: 'r2', at: D2 }, testChanges: [change(D3, 'weaker')] }, D1)
    expect(e.state).toBe('tests-weakened')
    expect(e.testsChangedAt?.verdict).toBe('weaker')
  })

  it('proof-stale: the tests changed after the proof and no green run followed', () => {
    const e = deriveRequirementEnforcement(req(), { provenAt: { runId: 'r2', at: D2 }, testChanges: [change(D3)] }, D1)
    expect(e.state).toBe('proof-stale')
  })

  it('wording-ahead: the wording changed after both the tests and the proof', () => {
    const e = deriveRequirementEnforcement(req({ wordingChangedAt: D4 }), { provenAt: { runId: 'r3', at: D3 }, testChanges: [change(D2)] }, D1)
    expect(e.state).toBe('wording-ahead')
  })
})

describe('deriveRequirementEnforcement — absent facts', () => {
  it('never proven, never changed: the wording is ahead of any proof', () => {
    expect(deriveRequirementEnforcement(req(), none, D1).state).toBe('wording-ahead')
  })

  it('never proven but tests changed: proof is stale (a run is what is missing)', () => {
    expect(deriveRequirementEnforcement(req(), { testChanges: [change(D2)] }, D1).state).toBe('proof-stale')
  })

  it('never proven and a weaker edit: weakened wins over stale', () => {
    expect(deriveRequirementEnforcement(req(), { testChanges: [change(D2), change(D3, 'weaker')] }, D1).state).toBe('tests-weakened')
  })

  it('a weaker edit BEFORE the proof does not count — the green run answered it', () => {
    const e = deriveRequirementEnforcement(req(), { provenAt: { runId: 'r3', at: D3 }, testChanges: [change(D2, 'weaker')] }, D1)
    expect(e.state).toBe('proven-unchanged')
  })

  it('the latest test change is the one reported, whatever order the history arrives in', () => {
    const e = deriveRequirementEnforcement(req(), { provenAt: { runId: 'r4', at: D4 }, testChanges: [change(D2), change(D3), change(D1)] }, D1)
    expect(e.testsChangedAt?.at).toBe(D3)
  })

  it('a pre-D11 requirement with no wording stamp falls back to the summary generation time', () => {
    const e = deriveRequirementEnforcement(req({ wordingChangedAt: undefined }), none, D2)
    expect(e.wordingChangedAt).toBe(D2)
  })
})

describe('applyEnforcement — onto a computed ledger', () => {
  const requirements: Requirement[] = [
    req({ id: 'R1', title: 'Totals' }),
    req({ id: 'R2', title: 'Tax', pathTypes: ['happy', 'sad'] }),
    req({ id: 'R3', title: 'Untested' }),
  ]
  const ledger: CoverageLedger = computeCoverageLedger({
    feature: 'checkout',
    requirements,
    tests: [
      { name: 'totals add up', requirements: ['R1'], pathTypes: ['happy'], file: 'e2e/a.spec.ts' },
      { name: 'tax happy', requirements: ['R2'], pathTypes: ['happy'], file: 'e2e/b.spec.ts' },
    ],
  })

  it('attaches a state to every requirement and a summary to the ledger, leaving gap types alone', () => {
    const out = applyEnforcement(ledger, {
      generatedAt: D1,
      runId: 'r3',
      historyFor: (tests) => (tests.includes('totals add up')
        ? { provenAt: { runId: 'r3', at: D3 }, testChanges: [change(D2)] }
        : { testChanges: [] }),
    })
    const byId = new Map(out.requirements.map((rc) => [rc.requirement.id, rc]))
    expect(byId.get('R1')!.enforcement?.state).toBe('proven-unchanged')
    // Path-incomplete: its mapped test may have passed, but the requirement was never proven.
    expect(byId.get('R2')!.enforcement?.state).toBe('wording-ahead')
    expect(byId.get('R2')!.enforcement?.provenAt).toBeUndefined()
    expect(byId.get('R3')!.enforcement?.state).toBe('wording-ahead')
    expect(out.enforcement).toEqual({
      runId: 'r3',
      provenUnchanged: 1,
      total: 3,
      states: { 'proven-unchanged': 1, 'tests-weakened': 0, 'wording-ahead': 2, 'proof-stale': 0 },
    })
    expect(out.requirements.map((rc) => rc.gapType)).toEqual(ledger.requirements.map((rc) => rc.gapType))
    expect(out.coveragePct).toBe(ledger.coveragePct)
  })

  it('a covered requirement asks the history for a proof over exactly its mapped tests', () => {
    const asked: string[][] = []
    applyEnforcement(ledger, { generatedAt: D1, historyFor: (tests) => { asked.push(tests); return { testChanges: [] } } })
    expect(asked).toContainEqual(['totals add up'])
    expect(asked).toContainEqual(['tax happy'])
    expect(asked).toContainEqual([])
  })

  it('carries no runId in the summary when the feature has no run', () => {
    const out = applyEnforcement(ledger, { generatedAt: D1, historyFor: () => ({ testChanges: [] }) })
    expect(out.enforcement?.runId).toBeUndefined()
    expect(out.enforcement?.provenUnchanged).toBe(0)
  })
})

describe('deriveRequirementEnforcement — legacy confirmation is inert', () => {
  it.each([
    { proof: D3, wording: D1, changes: [change(D2)] },
    { proof: D2, wording: D1, changes: [change(D3, 'weaker')] },
    { proof: D2, wording: D1, changes: [change(D3)] },
    { proof: D2, wording: D3, changes: [] },
  ])('derives the same proof state with or without old acceptance metadata: %j', ({ proof, wording, changes }) => {
    const requirement = req({ wordingChangedAt: wording })
    const history = { provenAt: { runId: 'r1', at: proof }, testChanges: changes }
    const expected = deriveRequirementEnforcement(requirement, history, D1)
    for (const fingerprint of ['fp-now', 'fp-old']) {
      const legacy = { ...requirement, acceptedAt: D4, acceptedFingerprint: fingerprint }
      expect(deriveRequirementEnforcement(legacy, history, D1)).toEqual(expected)
    }
    expect(expected).not.toHaveProperty('accepted')
  })
})
