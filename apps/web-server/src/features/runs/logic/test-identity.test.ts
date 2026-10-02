import { describe, expect, it } from 'vitest'
import { testLogicalKey } from './test-identity'
import { knownTestLogicalKey as detailKey } from './run-detail'
import { knownTestLogicalKey as summaryKey } from './runtime/summary-known-tests'

describe('testLogicalKey', () => {
  it('requires a nonempty title path and preserves every authored segment', () => {
    expect(testLogicalKey({ title: 'cart' })).toBeUndefined()
    expect(testLogicalKey({ title: 'cart', titlePath: [] })).toBeUndefined()
    const entry = { title: 'cart', titlePath: ['suite', '', 'suite'] }
    expect(testLogicalKey(entry)).toBe('suite\u001f\u001fsuite\u001fcart')
    expect(entry.titlePath).toEqual(['suite', '', 'suite'])
    expect(testLogicalKey({ ...entry, title: 'other' })).not.toBe(testLogicalKey(entry))
  })

  it('keeps detail recovery and reporter keys aligned with the detail default', () => {
    const entry = { name: 'cart', title: 'cart', titlePath: ['suite'] }
    expect(detailKey(entry)).toBe(summaryKey(entry))
    expect(detailKey({ name: 'legacy', titlePath: ['suite'] })).toBe(summaryKey({ title: '', titlePath: ['suite'] }))
    expect(detailKey({ name: 'legacy' })).toBeUndefined()
  })
})
