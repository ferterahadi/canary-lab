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

it('exposes a multiline configuration field at its own source range in Visual', () => {
  const source = ["const config = {", "  name: 'sample',", "  generatedFiles: [", "    'results.json'", "  ],", "}", "module.exports = config"].join('\n')
  const review = reviewSourceFor('feature.config.cjs', source, undefined, { withTests: false })
  const root = review.outline?.steps[0]
  expect(root?.text).toBe('Define config')
  expect(root?.kind === 'flow' && root.children.map(child => [child.text, child.source.startLine, child.source.endLine]))
    .toEqual([["Set name to 'sample'", 2, 2], ['Set generatedFiles (1 item)', 3, 5]])
})

it('expands configuration fields using only the selected revision and keeps them out of the test count', () => {
  const before = 'const config = {\n  enabled: true,\n}\nmodule.exports = config'
  const after = before.replace('  enabled', "  generatedFiles: ['report'],\n  enabled")
  for (const side of ['before', 'after'] as const) {
    const source = side === 'before' ? before : after
    const data = reviewSourceFor('feature.config.cjs', source, undefined, { withTests: false, side })
    expect(data.tests).toHaveLength(0)
    const graph = data.fileFlow!.graph!
    expect(graph.origin.kind).toBe(side)
    const section = graph.sections[0]
    expect(source.slice(section.definition.startOffset, section.definition.endOffset)).toBe(source)
    expect(section.boxes.some(box => box.label.includes('generatedFiles'))).toBe(side === 'after')
  }
})
