import fs from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
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
    expect(drawer(await report('starts empty'), 'english-details')).toContain('This body has no statements.')
  })
})
