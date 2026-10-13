import { describe, expect, it } from 'vitest'
import { reviewSourceFor } from './review-source'

const SPEC = [
  "import { test, expect } from '@playwright/test'",
  '',
  "test('adds two items', async ({ page }) => {",
  "  await page.goto('/cart')",
  '  expect(1 + 1).toBe(2)',
  '})',
].join('\n')

const SUPPORT = ["export const BASE = 'http://127.0.0.1:4100'", 'export const TIMEOUT = 5_000'].join('\n')

describe('reviewSourceFor', () => {
  it('reads a spec file into its whole-file English and its tests with their line ranges', () => {
    const side = reviewSourceFor('e2e/cart.spec.ts', SPEC, undefined, { withTests: true })
    expect(side.source).toBe(SPEC)
    expect(side.parseError).toBeUndefined()
    expect(side.story?.steps.length).toBeGreaterThan(0)
    expect(side.tests).toEqual([expect.objectContaining({ name: 'adds two items', line: 3, endLine: 6 })])
    expect(side.tests[0].readable).toBeDefined()
  })

  it('reads a supporting file as English without tests', () => {
    const side = reviewSourceFor('e2e/support/staging.ts', SUPPORT, undefined, { withTests: false })
    expect(side.tests).toEqual([])
    expect(side.story?.steps.length).toBeGreaterThan(0)
  })

  it('leaves a supporting file that is not JavaScript or TypeScript as source alone', () => {
    expect(reviewSourceFor('fixtures/catalog.json', '{"a": 1}', undefined, { withTests: false })).toEqual({ source: '{"a": 1}', tests: [] })
  })
})
