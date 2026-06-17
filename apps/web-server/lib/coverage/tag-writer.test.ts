import { describe, it, expect } from 'vitest'
import { writeCoversTag, writeCoversTags, coversTagTokens } from './tag-writer'
import { extractTestsFromSource } from '../ast-extractor'

describe('coversTagTokens', () => {
  it('renders requirement + path tokens', () => {
    expect(coversTagTokens({ requirements: ['R1', 'R2'], pathTypes: ['happy', 'sad'] })).toEqual([
      '@req-R1', '@req-R2', '@path-happy', '@path-sad',
    ])
  })
})

describe('writeCoversTag', () => {
  it('inserts a details object on a 2-arg test', () => {
    const src = `test('creates a todo', async () => { expect(1).toBe(1) })`
    const out = writeCoversTag(src, 'creates a todo', { requirements: ['R1'], pathTypes: ['happy'] })
    expect(out).toContain("{ tag: ['@req-R1', '@path-happy'] }")
    // The body must be untouched and still parse to the same test.
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toEqual(['R1'])
    expect(tests[0].pathTypes).toEqual(['happy'])
    expect(tests[0].bodySource).toContain('expect(1).toBe(1)')
  })

  it('merges into an existing tag array without duplicating', () => {
    const src = `test('t', { tag: ['@req-R1'] }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R1', 'R2'] })
    expect(out).toContain("['@req-R1', '@req-R2']")
    expect(out.match(/@req-R1/g)).toHaveLength(1) // not duplicated
  })

  it('upgrades a string tag to an array when merging', () => {
    const src = `test('t', { tag: '@smoke' }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R3'] })
    expect(out).toContain("['@smoke', '@req-R3']")
  })

  it('adds a tag property to a details object that lacks one', () => {
    const src = `test('t', { annotation: { type: 'issue' } }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R4'] })
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toEqual(['R4'])
  })

  it('is idempotent when the tag is already present', () => {
    const src = `test('t', { tag: ['@req-R1'] }, async () => {})`
    expect(writeCoversTag(src, 't', { requirements: ['R1'] })).toBe(src)
  })

  it('returns source unchanged when the test is absent', () => {
    const src = `test('other', async () => {})`
    expect(writeCoversTag(src, 'missing', { requirements: ['R1'] })).toBe(src)
  })

  it('only touches the named test, not its siblings', () => {
    const src = [
      `test('first', async () => {})`,
      `test('second', async () => {})`,
    ].join('\n')
    const out = writeCoversTag(src, 'second', { requirements: ['R2'] })
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toBeUndefined()
    expect(tests[1].requirements).toEqual(['R2'])
  })
})

describe('writeCoversTags (batch)', () => {
  it('applies several non-overlapping mappings in one pass', () => {
    const src = [
      `test('a', async () => {})`,
      `test('b', async () => {})`,
    ].join('\n')
    const out = writeCoversTags(src, [
      { testName: 'a', tag: { requirements: ['R1'] } },
      { testName: 'b', tag: { requirements: ['R2'], pathTypes: ['sad'] } },
    ])
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toEqual(['R1'])
    expect(tests[1].requirements).toEqual(['R2'])
    expect(tests[1].pathTypes).toEqual(['sad'])
  })
})
