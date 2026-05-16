import { describe, expect, it } from 'vitest'
import { formatCodeForDisplay } from './code-display-format'

describe('formatCodeForDisplay', () => {
  it('formats compressed Playwright body snippets for display', () => {
    expect(formatCodeForDisplay("{ await stepLoginOnMain(ctx!) await stepReachPaymentPage(ctx!) await stepPaymentBranch(ctx!, 'decline') }")).toBe(`{
    await stepLoginOnMain(ctx!);
    await stepReachPaymentPage(ctx!);
    await stepPaymentBranch(ctx!, 'decline');
}`)
  })

  it('normalizes complete TypeScript snippets used in reports', () => {
    expect(formatCodeForDisplay("import { test } from '@playwright/test'\n\ntest('x', async ({ page }) => { await page.goto('/') })")).toBe(`import { test } from '@playwright/test';
test('x', async ({ page }) => { await page.goto('/'); });`)
  })
})
