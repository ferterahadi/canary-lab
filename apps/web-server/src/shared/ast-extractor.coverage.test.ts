import { describe, expect, it } from 'vitest'
import { extractCoverageTestsFromSource, extractTestsFromSource } from './ast-extractor'

describe('syntax-only coverage evidence', () => {
  it('keeps the same declarations, tags, legacy comments and assertion snippets as the readable extractor', () => {
    const source = `import { test, expect } from '@playwright/test'
      // @requirement R2
      // @path edge
      test('creates order', { tag: ['@req-R1', '@path-happy', '@variant-email'] }, async ({ page }) => {
        await page.goto('/orders')
        expect(await page.title()).toBe('Orders')
      })
      test.skip('unavailable', async () => {})
      for (const name of ['one', 'two']) {
        test(\`order \${name}\`, async () => { expect(name).toBeTruthy() })
      }`
    const fields = ({ name, line, bodySource, requirements, pathTypes, variants, assertions }: ReturnType<typeof extractCoverageTestsFromSource>['tests'][number]) =>
      ({ name, line, bodySource, requirements, pathTypes, variants, assertions: assertions ?? [] })
    expect(extractCoverageTestsFromSource('orders.spec.ts', source).tests.map(fields))
      .toEqual(extractTestsFromSource('orders.spec.ts', source).tests.map(fields))
  })

  it('rejects a partial syntax tree rather than making a half-written spec appear measured', () => {
    expect(extractCoverageTestsFromSource('orders.spec.ts', `test('order', async () => {`))
      .toEqual({ file: 'orders.spec.ts', tests: [], parseError: expect.any(String) })
    expect(extractCoverageTestsFromSource('orders.spec.ts', undefined as unknown as string).parseError).toBeTruthy()
  })
})
