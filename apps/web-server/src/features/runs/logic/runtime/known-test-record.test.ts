import { expect, it } from 'vitest'
import { normalizeKnownTestRecord } from './known-test-record'
import { knownTestsFromSummary } from './rerun-targets'
import { knownTestsFromExistingSummary } from './summary-known-tests'

it.each([null, undefined, false, '', 1, {}, [], { name: 1, title: 'test' }, { name: '', title: 'test' }, { name: 'name' }, { name: 'name', title: '' }, { name: 'name', title: 1 }])('rejects records without usable names and titles (%j)', (entry) => {
  expect(normalizeKnownTestRecord(entry)).toBeUndefined()
})
it('normalizes fields without trimming, deduplicating title parts, or changing input', () => {
  const entry = { name: ' name ', title: 'title', id: 'id', titlePath: ['', 'suite', null, 5, 'suite'], listLine: ' line ', location: 'a.spec.ts:2' }
  const before = structuredClone(entry)
  expect(normalizeKnownTestRecord(entry)).toEqual({ id: 'id', fields: { name: ' name ', title: 'title', titlePath: ['suite', 'suite'], listLine: ' line ', location: 'a.spec.ts:2' } })
  expect(entry).toEqual(before)
})
it.each([undefined, null, '', 5])('omits unusable optional scalar fields (%j)', (value) => {
  expect(normalizeKnownTestRecord({ name: 'n', title: 't', id: value, titlePath: value, listLine: value, location: value })).toEqual({ fields: { name: 'n', title: 't' } })
})
it('preserves the adapters’ distinct empty-title-path and identity policies', () => {
  const knownTests = [
    { name: 'same', title: 'first', id: 'first-id', titlePath: [], location: 'a.ts:1' },
    { name: 'same', title: 'second', id: 'second-id', titlePath: [], location: 'b.ts:1' },
    { name: 'legacy', title: 'old', titlePath: [false, ''] },
  ]
  expect(knownTestsFromSummary({ knownTests })).toEqual([
    { name: 'same', title: 'first', titlePath: [], location: 'a.ts:1' },
    { name: 'legacy', title: 'old', titlePath: [] },
  ])
  expect(knownTestsFromExistingSummary({ knownTests })).toEqual([
    { id: 'first-id', name: 'same', title: 'first', location: 'a.ts:1' },
    { id: 'second-id', name: 'same', title: 'second', location: 'b.ts:1' },
    { id: 'legacy-legacy', name: 'legacy', title: 'old' },
  ])
})
it('retains logical-test merging after source locations move', () => {
  const knownTests = [
    { id: 'old', name: 'same', title: 'test', titlePath: ['a.ts', 'suite'], location: 'a.ts:2' },
    { id: 'new', name: 'same', title: 'test', titlePath: ['a.ts', 'suite'], location: 'a.ts:8' },
  ]
  expect(knownTestsFromSummary({ knownTests })[0].location).toBe('a.ts:2')
  expect(knownTestsFromExistingSummary({ knownTests })).toEqual([knownTests[1]])
})
