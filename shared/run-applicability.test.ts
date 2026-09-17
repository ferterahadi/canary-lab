import { describe, expect, it } from 'vitest'
import { declaredEnvironments, environmentExclusions } from './run-applicability'

describe('environment declarations', () => {
  it('accepts a single explicit list and removes duplicate environment names', () => {
    expect(declaredEnvironments([{ type: 'canary:environments', description: '["meta","meta"]' }])).toEqual(['meta'])
  })
  it.each([undefined, '', 'meta', '[]', '[""]', '[" local"]', '[42]', '{}'])('rejects ambiguous or invalid declaration %s', (description) => {
    expect(declaredEnvironments([{ type: 'canary:environments', description }])).toEqual([])
  })
  it('does not interpret skip explanations as applicability', () => {
    expect(declaredEnvironments([{ type: 'skip', description: 'Meta only' }])).toEqual([])
    expect(declaredEnvironments([{ type: 'canary:environments' }, { type: 'canary:environments' }])).toEqual([])
  })
  it('rejects fabricated exclusions, missing roster evidence, and conflicting failures', () => {
    const entry = { id: 'a', name: 'a', environment: 'local', environments: ['meta'] }
    const summary = { environment: 'local', knownTests: [{ id: 'a', name: 'a' }], skippedNames: ['a'], skippedIds: ['a'], environmentExclusions: [entry] }
    expect(environmentExclusions(summary)).toEqual([entry])
    expect(environmentExclusions({ ...summary, environmentExclusions: [entry, entry] })).toEqual([entry])
    for (const change of [
      { environment: undefined }, { environmentExclusions: 'invalid' }, { skippedIds: [] }, { skippedNames: [] }, { knownTests: [] },
      { knownTests: [{ id: 'a', name: 'a' }, { id: 'b', name: 'a' }] }, { failed: [{ name: 'a' }] }, { failed: [{ id: 'a' }] },
      { environmentExclusions: [null, 3, {}, { ...entry, environments: ['local'] }, { ...entry, environments: [null] }, { ...entry, id: '' }] },
    ]) expect(environmentExclusions({ ...summary, ...change })).toEqual([])
  })
})
