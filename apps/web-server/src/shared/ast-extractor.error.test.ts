import { describe, expect, it, vi } from 'vitest'

vi.mock('./controlled-english/compiler-context', () => ({
  parseSource: () => { throw 'parser service unavailable' },
}))

const { extractCoverageTestsFromSource } = await import('./ast-extractor')

describe('extractCoverageTestsFromSource parse faults', () => {
  it('keeps a non-Error parser fault readable to coverage callers', () => {
    expect(extractCoverageTestsFromSource('a.spec.ts', "test('a', () => {})")).toEqual({
      file: 'a.spec.ts', tests: [], parseError: 'parser service unavailable',
    })
  })
})
