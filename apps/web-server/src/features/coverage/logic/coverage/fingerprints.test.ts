import { describe, it, expect } from 'vitest'
import {
  fingerprintRequirement,
  requirementsSetHash,
  fingerprintDocs,
  diffDocs,
  changedDocPaths,
  changedRequirementIds,
  requirementFingerprintMap,
  withFingerprints,
} from './fingerprints'
import type { PrdSummary, Requirement } from '../../../../../../../shared/coverage/types'

const r = (id: string, extra: Partial<Requirement> = {}): Requirement =>
  ({ id, title: `${id} title`, text: `${id} text`, pathTypes: ['happy'], ...extra })

describe('fingerprintRequirement', () => {
  it('is stable for the same content and changes when content changes', () => {
    expect(fingerprintRequirement(r('R1'))).toBe(fingerprintRequirement(r('R1')))
    expect(fingerprintRequirement(r('R1'))).not.toBe(fingerprintRequirement(r('R1', { text: 'changed' })))
  })

  it('ignores id (the durable spine) but tracks path types order-independently', () => {
    // Same content, different id → same fingerprint (id is excluded).
    const same = { title: 'T', text: 'body', pathTypes: ['happy'] as const }
    expect(fingerprintRequirement({ id: 'R1', ...same })).toBe(fingerprintRequirement({ id: 'R2', ...same }))
    expect(fingerprintRequirement(r('R1', { pathTypes: ['happy', 'sad'] })))
      .toBe(fingerprintRequirement(r('R1', { pathTypes: ['sad', 'happy'] })))
  })
})

describe('requirementsSetHash', () => {
  it('is order-independent and excludes deprecated requirements', () => {
    const a = requirementsSetHash([r('R1'), r('R2')])
    const b = requirementsSetHash([r('R2'), r('R1')])
    expect(a).toBe(b)
    const withDeprecated = requirementsSetHash([r('R1'), r('R2'), r('R9', { deprecated: true })])
    expect(withDeprecated).toBe(a)
  })

  it('changes when a requirement is added, removed, or edited', () => {
    const base = requirementsSetHash([r('R1')])
    expect(requirementsSetHash([r('R1'), r('R2')])).not.toBe(base) // added
    expect(requirementsSetHash([r('R1', { text: 'x' })])).not.toBe(base) // edited
    expect(requirementsSetHash([])).not.toBe(base) // removed
  })
})

describe('diffDocs', () => {
  it('classifies added / removed / changed / unchanged', () => {
    const prev = { 'a.md': 'h1', 'b.md': 'h2', 'c.md': 'h3' }
    const live = { 'a.md': 'h1', 'b.md': 'CHANGED', 'd.md': 'h4' }
    const delta = diffDocs(live, prev)
    expect(delta.unchanged).toEqual(['a.md'])
    expect(delta.changed).toEqual(['b.md'])
    expect(delta.added).toEqual(['d.md'])
    expect(delta.removed).toEqual(['c.md'])
    expect(changedDocPaths(delta)).toEqual(['b.md', 'c.md', 'd.md'])
  })

  it('treats everything as added when there are no prior fingerprints', () => {
    const delta = diffDocs({ 'a.md': 'h' }, undefined)
    expect(delta.added).toEqual(['a.md'])
  })
})

describe('changedRequirementIds (R10 delta)', () => {
  it('returns only ids new or changed vs the baseline', () => {
    const reqs = [r('R1', { text: 'edited' }), r('R2'), r('R3')]
    const baseline = requirementFingerprintMap([r('R1'), r('R2')]) // R1 unchanged-content baseline, R3 absent
    const changed = changedRequirementIds(reqs, baseline)
    expect(changed).toEqual(['R1', 'R3']) // R1 edited, R3 added; R2 unchanged
  })

  it('returns all active ids when there is no baseline', () => {
    expect(changedRequirementIds([r('R1'), r('R2')], undefined)).toEqual(['R1', 'R2'])
  })

  it('returns nothing when the set is identical', () => {
    const reqs = [r('R1'), r('R2')]
    expect(changedRequirementIds(reqs, requirementFingerprintMap(reqs))).toEqual([])
  })
})

describe('requirementFingerprintMap', () => {
  it('excludes deprecated requirements (line 86 branch)', () => {
    const active = r('R1')
    const deprecated = r('R2', { deprecated: true })
    const map = requirementFingerprintMap([active, deprecated])
    expect(Object.keys(map)).toEqual(['R1'])
    expect('R2' in map).toBe(false)
  })
})

describe('withFingerprints', () => {
  it('attaches doc + requirement fingerprints and a set hash', () => {
    const summary: PrdSummary = {
      requirements: [r('R1'), r('R2')],
      docsHash: 'x',
      sourceDocs: ['spec.md'],
      generatedAt: '2026-01-01T00:00:00Z',
    }
    const out = withFingerprints(summary, [{ relPath: 'spec.md', content: 'body' }])
    expect(out.docFingerprints).toEqual(fingerprintDocs([{ relPath: 'spec.md', content: 'body' }]))
    expect(out.requirementsHash).toBe(requirementsSetHash(summary.requirements))
    expect(out.requirements[0].fingerprint).toBe(fingerprintRequirement(r('R1')))
  })
})
