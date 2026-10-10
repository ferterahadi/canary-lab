import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEvaluationHtml } from './test-review-export'
import { detail, lineOf } from './__fixtures__/test-review-fixtures'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-review-rows-')

const SPEC = `import { test, expect } from '@playwright/test'

test('fills the cart', async ({ page }) => {
  await page.goto('/cart')
  for (const id of [1, 2]) {
    await page.click(\`#item-\${id}\`)
  }
  await expect(page.getByText('Cart')).toBeVisible()
})

test('starts empty', async () => {})
`

let featureDir: string
let spec: string

beforeEach(() => {
  featureDir = tempDir()
  fs.mkdirSync(path.join(featureDir, 'e2e'))
  spec = path.join(featureDir, 'e2e', 'cart.spec.ts')
  fs.writeFileSync(spec, SPEC)
})

/** One drawer's body, by its class. */
function drawer(html: string, kind: 'english-details' | 'test-code-details'): string {
  const start = html.indexOf(`<details class="drawer ${kind}"`)
  return html.slice(start, html.indexOf('</details>', start))
}

const report = (title: string) => createEvaluationHtml(detail({ featureDir, title, eventLocation: `${spec}:${lineOf(SPEC, `test('${title}'`)}` }))

describe('the report reads a test on the Tests column\'s rows', () => {
  it('numbers its English as the web does, on the spec\'s own lines', async () => {
    const english = drawer(await report('fills the cart'), 'english-details')
    const line = lineOf(SPEC, "await page.goto('/cart')")
    expect([...english.matchAll(/data-story-sequence="([^"]+)" data-source-line="(\d+)"/g)].map(([, sequence, source]) => [sequence, Number(source)]))
      .toEqual([['01', line], ['02', line + 1], ['02.1', line + 2], ['03', line + 4]])
  })

  it('still says an empty test has no statements', async () => {
    const html = await report('starts empty')
    expect(drawer(html, 'english-details')).toContain('This body has no statements.')
    expect(drawer(html, 'test-code-details')).toContain('This body has no statements.')
  })

  it('lays its code on the same rows, numbered by the English step each starts', async () => {
    const html = await report('fills the cart')
    const code = drawer(html, 'test-code-details')
    const line = lineOf(SPEC, "await page.goto('/cart')")
    const rows = [...code.matchAll(/<span class="code-line" data-code-line="(\d+)" data-source-line="(\d+)" data-row="(\d+)"(?: data-step="([^"]+)")?><span class="line-number">([^<]*)<\/span>/g)]
      .map(([, codeLine, source, row, step, gutter]) => ({ codeLine: Number(codeLine), source: Number(source), row: Number(row), step, gutter }))
    expect(rows).toEqual([
      { codeLine: 2, source: line, row: 1, step: '01', gutter: '01' },
      { codeLine: 3, source: line + 1, row: 2, step: '02', gutter: '02' },
      { codeLine: 4, source: line + 2, row: 3, step: '1', gutter: '1' },
      { codeLine: 5, source: line + 3, row: 4, step: undefined, gutter: '' },
      { codeLine: 6, source: line + 4, row: 5, step: '03', gutter: '03' },
    ])
    // No wrapper-brace rows, and the code keeps both palettes for the theme switch.
    expect(code).not.toMatch(/<span class="line"><span[^>]*>\{<\/span><\/span>/)
    expect(code).toContain('class="shiki shiki-themes one-light one-dark-pro" style="--shiki-light:')
    expect(code).toContain('--shiki-dark:')
    // The flowchart links each node to a line of the formatted body; every one names a row here.
    const linked = [...html.matchAll(/class="flow-node[^"]*"[^>]*data-code-line="(\d+)"/g)].map(([, codeLine]) => Number(codeLine))
    expect(linked.length).toBeGreaterThan(0)
    expect(linked.every((codeLine) => rows.some((row) => row.codeLine === codeLine))).toBe(true)
  })
})

describe('the report\'s code rows without a highlighter', () => {
  afterEach(() => {
    vi.doUnmock('shiki')
    vi.resetModules()
  })

  it('keeps every row, numbered, as plain text', async () => {
    vi.resetModules()
    vi.doMock('shiki', () => ({
      codeToHtml: () => { throw new Error('highlighter unavailable') },
      codeToTokens: () => { throw new Error('highlighter unavailable') },
      stringifyTokenStyle: () => '',
    }))
    // The formatter drops blank lines between statements; one inside a string stays a row.
    fs.writeFileSync(spec, SPEC.replace("  await page.goto('/cart')\n", "  await page.goto('/cart')\n  console.log(`cart\n\nready`)\n"))
    const { createEvaluationHtml: createHtml } = await import('./test-review-export')
    const source = fs.readFileSync(spec, 'utf8')
    const code = drawer(await createHtml(detail({ featureDir, title: 'fills the cart', eventLocation: `${spec}:${lineOf(source, "test('fills the cart'")}` })), 'test-code-details')
    expect(code).toContain('<pre class="fallback-code"><code>')
    // The string's unindented line keeps the body from being dedented, as on the web.
    expect(code).toContain('<span class="line-source">    await page.goto(&#39;/cart&#39;);</span>')
    expect(code).toMatch(/data-row="3"><span class="line-number"><\/span><span class="line-source"> <\/span>/)
  })
})
