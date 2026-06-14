import { describe, expect, it } from 'vitest'
import { formatCodeForDisplay, formatSourceSnippetForDisplay } from './code-display-format'

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

describe('formatSourceSnippetForDisplay', () => {
  it('preserves blank lines and line count so lines map 1:1', () => {
    const body = ['{', '  const a = 1', '', '  expect(a).toBe(1)', '}'].join('\n')
    expect(formatSourceSnippetForDisplay(body)).toBe(body)
  })

  it('dedents nested bodies without adding or removing lines', () => {
    const input = ['{', '      const payload = build()', '', '      await send(payload)', '    }'].join('\n')
    const output = formatSourceSnippetForDisplay(input)
    expect(output.split('\n')).toHaveLength(input.split('\n').length)
    expect(output).toBe(['{', '  const payload = build()', '', '  await send(payload)', '}'].join('\n'))
  })

  it('leaves a single-line body untouched', () => {
    expect(formatSourceSnippetForDisplay('{ const x = 1; expect(x).toBe(1) }')).toBe('{ const x = 1; expect(x).toBe(1) }')
  })
})
