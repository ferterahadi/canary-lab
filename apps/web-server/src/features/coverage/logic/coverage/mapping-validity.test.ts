import { describe, expect, it } from 'vitest'
import { mappingInputMatches } from './mapping-validity'

describe('mappingInputMatches', () => {
  const prior = { fingerprint: 'test-v1', requirements: { R1: 'req-v1', R2: 'removed' } }

  it('reuses a mapping only when the test and every current requirement match', () => {
    expect(mappingInputMatches('test-v1', { R1: 'req-v1' }, prior)).toBe(true)
    expect(mappingInputMatches('test-v2', { R1: 'req-v1' }, prior)).toBe(false)
    expect(mappingInputMatches('test-v1', { R1: 'req-v2' }, prior)).toBe(false)
    expect(mappingInputMatches('test-v1', { R3: 'new' }, prior)).toBe(false)
    expect(mappingInputMatches('test-v1', { R1: 'req-v1' }, undefined)).toBe(false)
  })

  it('does not require removed requirements or invent a change for an empty requirement set', () => {
    expect(mappingInputMatches('test-v1', {}, prior)).toBe(true)
    expect(mappingInputMatches('test-v1', { R1: 'req-v1' }, prior)).toBe(true)
  })
})
