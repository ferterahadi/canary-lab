import { expect, it, vi } from 'vitest'

// The extractor reports a parse error only when its parser throws; the
// TypeScript parser itself recovers from broken syntax, so the fault is forced.
vi.mock('../ast-extractor', () => ({
  extractTestsFromSource: (file: string) => ({ file, tests: [], parseError: 'parser service unavailable' }),
}))

const { reviewSourceFor } = await import('./review-source')

it('says why there is no English when the source does not parse, for a spec and a supporting file', () => {
  for (const withTests of [true, false]) {
    expect(reviewSourceFor('e2e/broken.spec.ts', 'test(', undefined, { withTests })).toEqual({ source: 'test(', tests: [], parseError: 'parser service unavailable' })
  }
})
