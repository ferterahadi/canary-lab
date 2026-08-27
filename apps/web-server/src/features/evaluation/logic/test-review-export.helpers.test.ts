import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { __testReviewExportInternals, buildTestReviewPacket } from './test-review-export'
import { detail, lineOf } from './__fixtures__/test-review-fixtures'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('test review export — additional branch coverage', () => {
  it('skips imports whose module specifier is not a string literal', () => {
    const featureDir = path.join(tmpDir, 'numeric-import')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'numeric.spec.ts')
    // A malformed numeric module specifier — TS error-recovery keeps the import
    // node with a non-string-literal specifier, exercising the guard in both the
    // relative-import and external-import readers rather than throwing.
    const specSource = `import brokenDefault from 123
import { test, expect } from '@playwright/test'

test('handles a numeric import specifier', async ({ page }) => {
  await expect(page.getByText('Ready')).toBeVisible()
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('handles a numeric")}`,
      title: 'handles a numeric import specifier',
    }))

    expect(packet.tests[0].testBody).toContain("page.getByText('Ready')")
    expect(packet.tests[0].externalImports).toContain("import { test, expect } from '@playwright/test'")
    expect(packet.tests[0].externalImports.some((imp) => imp.includes('123'))).toBe(false)
  })

  it('expands shared helper flow steps into canonical child actions and checks', () => {
    const featureDir = path.join(tmpDir, 'nested-counts')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'nested.spec.ts')
    // A leading direct assertion keeps `assertions` non-empty (so the empty
    // no-static-assertion fallback isn't added), and the non-`expect`-prefixed
    // helpers resolve to helper flow nodes whose detail reflects nested counts.
    const specSource = `import { test, expect } from '@playwright/test'

test('nested counts', async ({ page }) => {
  await expect(page.locator('.anchor')).toBeVisible()
  await stepZero(page)
  await stepOne(page)
  await stepTwo(page)
})

function stepZero(page) {
  return page.goto('/noop')
}

function stepOne(page) {
  expect(page.locator('.a')).toBeVisible()
}

function stepTwo(page) {
  expect(page.locator('.a')).toBeVisible()
  expect(page.locator('.b')).toHaveText('x')
}
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('nested counts'")}`,
      title: 'nested counts',
    }))
    const nodes = __testReviewExportInternals.flowNodesForTest(packet.tests[0])
    const titles = nodes.map((node) => node.title)

    expect(titles).toContain('await:\n    call `stepZero`\n    with argument `page`')
    expect(titles.some((title) => title.includes('property `goto`'))).toBe(true)
    expect(titles).toContain('await:\n    call `stepOne`\n    with argument `page`')
    expect(titles).toContain('await:\n    call `stepTwo`\n    with argument `page`')
    expect(nodes.filter((node) => node.kind === 'assertion')).toHaveLength(4)
  })

  it('skips helper dependencies that resolve to no definition', () => {
    const featureDir = path.join(tmpDir, 'phantom-dep')
    const helperDir = path.join(featureDir, 'e2e', 'helpers')
    fs.mkdirSync(helperDir, { recursive: true })
    fs.writeFileSync(path.join(helperDir, 'sibling.ts'), `export function somethingElse(page) { return page }\n`)
    fs.writeFileSync(path.join(helperDir, 'outer.ts'), `import { phantom } from './sibling'

export function outer(page) {
  return phantom(page)
}
`)
    const spec = path.join(featureDir, 'e2e', 'phantom.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'
import { outer } from './helpers/outer'

test('phantom dependency', async ({ page }) => {
  await expect(page.locator('.x')).toBeVisible()
  outer(page)
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('phantom dependency'")}`,
      title: 'phantom dependency',
    }))
    const outerDef = packet.tests[0].helperDefinitions.find((h) => h.name === 'outer')

    expect(outerDef).toBeDefined()
    // `phantom` is imported from a real sibling that doesn't define it, so it
    // resolves to no dependency and is dropped rather than pushed or throwing.
    expect(outerDef?.dependencies).toEqual([])
  })

  it('counts assertions from a helper reached through another helper', () => {
    // `outer` holds no assertions itself; the count has to walk into its
    // dependency chain to find `inner`'s.
    const featureDir = path.join(tmpDir, 'nested-assertions')
    const helperDir = path.join(featureDir, 'e2e', 'helpers')
    fs.mkdirSync(helperDir, { recursive: true })
    fs.writeFileSync(path.join(helperDir, 'inner.ts'), `import { expect } from '@playwright/test'

export function inner(page) {
  return expect(page.locator('.done')).toHaveText('Done')
}
`)
    fs.writeFileSync(path.join(helperDir, 'outer.ts'), `import { inner } from './inner'

export function outer(page) {
  return inner(page)
}
`)
    const spec = path.join(featureDir, 'e2e', 'nested.spec.ts')
    // The direct `toBeVisible` is load-bearing: with no assertion of its own the
    // test gets a placeholder whose empty snippet substring-matches every
    // statement, so `outer(page)` would render as an assertion step instead of a
    // helper one and the nested walk would never run.
    const specSource = `import { test, expect } from '@playwright/test'
import { outer } from './helpers/outer'

test('nested helper assertions', async ({ page }) => {
  await expect(page.getByText('Ready')).toBeVisible()
  outer(page)
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('nested helper assertions'")}`,
      title: 'nested helper assertions',
    }))
    const outerDef = packet.tests[0].helperDefinitions.find((h) => h.name === 'outer')

    expect(outerDef?.assertions).toEqual([])
    expect(outerDef?.dependencies.map((dep) => dep.name)).toEqual(['inner'])
    const helperNodes = __testReviewExportInternals.flowNodesForTest(packet.tests[0])
    expect(helperNodes).toContainEqual(expect.objectContaining({
      title: 'call `outer`\nwith argument `page`',
      kind: 'helper',
      readable: true,
    }))
    expect(helperNodes).toContainEqual(expect.objectContaining({
      title: 'return:\n    call `inner`\n    with argument `page`',
      kind: 'helper',
      readable: true,
    }))
    expect(helperNodes).toContainEqual(expect.objectContaining({
      title: expect.stringContaining('property `toHaveText`'),
      kind: 'assertion',
      readable: true,
    }))

    // `detail` is optional on a FlowNode, so the audience title reads the helper
    // name when there is nothing else to describe the step with.
    expect(__testReviewExportInternals.audienceFlowTitle(
      { kind: 'helper', title: 'Helper: openVoucherModal' },
      packet.tests[0],
    )).toBe('Open voucher modal')
  })
})
