import { describe, expect, it, vi } from 'vitest'
import * as translator from '../../../../shared/readable-tests/translator'
import { extractTestsFromSource } from '../../../../shared/ast-extractor'
import { renderEnglishSource, renderTestEnglish } from './english'

describe('complete exported English', () => {
  it('keeps statements beyond the diagram limit and nested helper definitions', () => {
    const statements = Array.from({ length: 35 }, (_, index) => `expect(value).toBe(${index})`).join(';')
    const html = renderEnglishSource('review.spec.ts', `{ function helper() { return '<script>' }; ${statements} }`)
    // Grammar spans split a sentence; read it without them.
    const text = html.replace(/<[^>]+>/g, '')
    expect(text).toContain('Define function helper')
    expect(text).toContain('Return &quot;&lt;script&gt;&quot;')
    expect(text).toContain('value equals 34')
    expect(html.match(/>CHECK</g)).toHaveLength(35)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('omitted')
  })

  it('labels syntax fallbacks and distinguishes empty bodies from unavailable English', () => {
    expect(renderEnglishSource('support.ts', 'namespace Scope {}')).toContain('English incomplete')
    expect(renderEnglishSource('empty.ts', '{}')).toContain('no statements')
    expect(renderEnglishSource('empty.ts', '')).toContain('no statements')
    const translate = vi.spyOn(translator, 'translateReadableSource').mockReturnValueOnce({ steps: [] })
    try { expect(renderEnglishSource('unsupported.ts', 'future syntax')).toContain('English unavailable') }
    finally { translate.mockRestore() }
  })
})

describe('English on the Tests column\'s rows', () => {
  const FILE = '/suite/e2e/cart.spec.ts'
  const extracted = (source: string) => extractTestsFromSource(FILE, source).tests[0]

  it('numbers steps as the web does, nesting a flow\'s steps under its own number', () => {
    const html = renderTestEnglish(extracted(`import { test, expect } from '@playwright/test'
test('cart', async ({ page }) => {
  await page.goto('/cart')
  for (const id of [1, 2]) {
    await page.click(\`#item-\${id}\`)
  }
  await expect(page.getByText('Cart')).toBeVisible()
})
`), FILE)!
    const rows = [...html.matchAll(/data-story-sequence="([^"]+)" data-source-line="(\d+)">\s*<span class="story-line"><span class="story-label">([^<]+)<\/span><span class="story-keyword tone-(\w+)">([^<]+)</g)]
      .map(([, sequence, line, label, tone, keyword]) => [sequence, line, label, tone, keyword])
    expect(rows).toEqual([
      ['01', '3', '01', 'keyword', 'ACTION'],
      ['02', '4', '02', 'keyword', 'REPEAT'],
      ['02.1', '5', '1', 'keyword', 'ACTION'],
      ['03', '7', '03', 'attention', 'CHECK'],
    ])
    expect(html).toContain('class="story story-nested"')
    expect(html).not.toContain('Check that')
    expect(html).toContain('<span class="sp-verb">')
    expect(html).not.toContain('English representation is incomplete')
  })

  it('says when the English is partial, marks untranslated lines and names a helper\'s file', () => {
    const test = extracted(`import { test } from '@playwright/test'
test('cart', async () => {
  // keep the cart warm
  await warm()
})
`)
    const [note, call] = test.readable.story!.steps
    const steps = [note, { ...call, presentation: 'syntax-fallback' as const, source: { ...call.source, file: '/suite/e2e/helpers/cart.ts' } }]
    const html = renderTestEnglish({ ...test, readable: { ...test.readable, completeness: 'partial', story: { steps } } }, FILE)!
    expect(html).toContain('<p class="muted">English representation is incomplete</p>')
    expect(html).toMatch(/<span class="story-line story-note">.*NOTE/)
    expect(html).toContain('<span class="story-fallback">English incomplete · </span>')
    expect(html).toContain('<span class="story-where"> // cart.ts</span>')
    expect(html.match(/story-where/g)).toHaveLength(1)
  })

  it('says a test with no statements has none', () => {
    const empty = extracted(`import { test } from '@playwright/test'\ntest('empty', async () => {})\n`)
    expect(empty.readable.story).toBeUndefined()
    expect(renderTestEnglish(empty, FILE)).toBe('<p class="muted">This body has no statements.</p>')
    expect(renderTestEnglish({ ...empty, readable: { ...empty.readable, story: { steps: [] } } }, FILE)).toBe('<p class="muted">This body has no statements.</p>')
  })
})
