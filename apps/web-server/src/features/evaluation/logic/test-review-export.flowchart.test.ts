import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { __testReviewExportInternals, buildTestReviewPacket, createAssertionExport, createEvaluationExport, createEvaluationHtml } from './test-review-export'
import { detail, lineOf, testEndEvent } from './__fixtures__/test-review-fixtures'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('test review export', () => {
  it('creates external flowchart svg assets for each test case', async () => {
    const exported = await createEvaluationExport(detail({ featureDir: tmpDir }))

    expect(exported.assets).toEqual([])
    const svg = exported.html
    expect(svg).toContain('<svg class="flowchart" xmlns="http://www.w3.org/2000/svg" width="1280" height="186"')
    expect(svg).toContain('class="flow-node"')
    expect(svg).toContain('class="connector"')
    // Each chart owns its <defs> ids — a shared one breaks as soon as the case
    // holding the first definition is collapsed.
    expect(svg).toContain('filter="url(#node-shadow-0)"')
    expect(svg).toContain('id="arrow-0"')
    expect(svg).toContain('text-anchor="middle"')
    expect(svg).not.toContain('text-anchor="end" font-size="10"')
    // Every colour resolves through a custom property so the diagram follows
    // the report's light/dark switch instead of baking one palette in.
    expect(svg).toContain('font-family:var(--font-sans)')
    expect(svg).not.toMatch(/(?:fill|stroke)="#[0-9a-f]{6}"/i)
    expect(svg).toContain('stroke="var(--flow-neutral-line)"')
    expect(svg).toContain('stroke="var(--flow-pass-line)"')
    expect(svg).toContain('Source unavailable')
    expect(svg).toContain('Run result: passed')
    expect(svg).not.toContain('height="368"')
  })

  it('sanitizes punctuation-only test titles for flowchart filenames', async () => {
    const exported = await createAssertionExport(detail({ featureDir: tmpDir, title: '!!!' }))

    expect(exported.assets).toEqual([])
    expect(exported.html).toContain('Evaluation flow for')
  })

  it('covers failed flowcharts, long labels, malformed bodies, and empty section ids', async () => {
    const featureDir = path.join(tmpDir, 'flow-edge-feature')
    const e2eDir = path.join(featureDir, 'e2e')
    fs.mkdirSync(e2eDir, { recursive: true })
    const spec = path.join(e2eDir, 'flow.spec.ts')
    const longWord = 'checkout'.repeat(20)
    const specSource = `import { test, expect } from '@playwright/test'

test('!!!', async ({ page }) => {
  await page.route('**/api/**', () => {})
  openCheckout(page)
  await expectOneNested(page)
  ${longWord}(page)
})

function openCheckout(page) {
  return expect(page.getByText('Checkout')).toBeVisible()
}

function expectOneNested(page) {
  expect(page.getByText('${longWord}')).toBeVisible()
}
`
    fs.writeFileSync(spec, specSource)
    const failed = detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('!!!'")}`,
      title: '!!!',
      durationMs: undefined,
    })
    failed.manifest.status = 'failed'
    failed.summary = { complete: true, total: 1, passed: 0, failed: [{ name: 'test-case-' }] }
    const flowEvent = testEndEvent(failed)
    flowEvent.status = 'failed'
    flowEvent.passed = false
    ;(flowEvent as { durationMs?: number }).durationMs = undefined

    const exported = await createAssertionExport(failed)
    const html = exported.html
    const svg = exported.html

    expect(exported.assets).toEqual([])
    expect(html).toContain('pill-failed')
    expect(svg).toContain('stroke="var(--flow-fail-line)"')
    expect(svg).toContain('Prepare the scenario')
    expect(svg).toContain('Open checkout')
    expect(svg).toContain('1 check inside this shared step')
    expect(svg).toContain('Check the expected outcome')
    expect(svg).toContain('…')
  })

  it('renders readable action labels for the major statement families', async () => {
    const featureDir = path.join(tmpDir, 'action-label-feature')
    const e2eDir = path.join(featureDir, 'e2e')
    fs.mkdirSync(e2eDir, { recursive: true })
    const spec = path.join(e2eDir, 'actions.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'
import { expectFromLib } from 'external-assertions'

test('A. authAPI -> warning incl auto-resolved', async ({ page }) => {
  test.skip(!process.env.E2E_USER, 'missing user')
  await page.route('**/api/**', () => {})
  const start = new Date()
  const ids = makeIds()
  await mockInventory()
  await createCart(ids)
  await sendCheckoutRequest()
  await fetchSavedOrder()
  await waitForReceipt()
  await toggleVoucher()
  await withLinkedRecords()
  await clickRelevantControl()
  await fillRequiredValue()
  await page.getByRole('button', { name: 'Pay' }).click()
  await page.getByLabel('Email').fill('customer@example.com')
  await page.waitForURL(/thank-you/)
  await expect(page.getByText('Success')).toHaveText('Success')
  await expect(page.locator('.toast')).toBeVisible()
  await expect(page.locator('.rows')).toHaveCount(1)
  await expectUnknownOutcome(page)
  await expectFromLib(page)
  await unknownUtility(page)
  void start
})

function makeIds() {
  return { orderId: 'o-1' }
}

function mockInventory() {
  return true
}

function createCart(ids) {
  return ids
}

function sendCheckoutRequest() {
  return true
}

function fetchSavedOrder() {
  return true
}

function waitForReceipt() {
  return true
}

function toggleVoucher() {
  return true
}

function withLinkedRecords() {
  return true
}

function clickRelevantControl() {
  return true
}

function fillRequiredValue() {
  return true
}

function expectUnknownOutcome(page) {
  expect(page.locator('.anything')).toBeTruthy()
}

function unknownUtility(page) {
  return page
}
`
    fs.writeFileSync(spec, specSource)

    const html = await createEvaluationHtml(detail({
      featureDir,
      feature: 'action_labels',
      eventLocation: `${spec}:${lineOf(specSource, "test('A.")}`,
      title: 'A. authAPI -> warning incl auto-resolved',
    }))

    expect(html).toContain('Auth api then warning including automatically resolved')
    expect(html).toContain('Skip if required test setup is missing')
    expect(html).toContain('Prepare the scenario')
    expect(html).toContain('Record the start time')
    expect(html).toContain('Prepare unique identifiers')
    expect(html).toContain('Prepare inventory')
    expect(html).toContain('Prepare cart')
    expect(html).toContain('Send checkout request')
    expect(html).toContain('Read saved order')
    expect(html).toContain('Wait for for receipt')
    expect(html).toContain('Toggle voucher')
    expect(html).toContain('Check linked records')
    expect(html).toContain('Click the relevant control')
    expect(html).toContain('Enter the required value')
    // expectUnknownOutcome resolves to a nested toBeTruthy (surface-level), so it
    // is graded; only expectFromLib is genuinely unresolvable and not graded. The
    // built-in `expect(...)` receiver of each real assertion must NOT be counted
    // as its own ungradeable helper check.
    expect(html).toContain('Confidence: 3 exact, 1 behavioral, 1 surface-level, 1 not graded')
    expect(html).toContain('Helper resolves to 1 nested assertion')
    // The "could not be resolved statically" message fires only for the truly
    // unresolvable helper — never once per built-in expect() sub-expression.
    expect(html).toContain('Helper implementation could not be resolved statically')
    expect((html.match(/Helper implementation could not be resolved statically/g) ?? []).length).toBe(1)
    expect(html).not.toContain('<code>expect(page.getByText(&#39;Success&#39;))</code>')
  })

  it('descends into try/blocks, surfaces meaningful inner steps, drops literal-only decls', async () => {
    const featureDir = path.join(tmpDir, 'flow-descend')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'flow.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('wrapped in try', async ({ page }) => {
  try {
    const noise = 'literal only'
    await page.goto('/start')
    const created = await page.request.post('/api/x')
    expect(created.status()).toBe(201)
    await expect(page.locator('.done')).toBeVisible()
  } finally {
    await page.close()
  }
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      feature: 'flow_descend',
      eventLocation: `${spec}:${lineOf(specSource, "test('wrapped in try'")}`,
      title: 'wrapped in try',
    }))
    const nodes = __testReviewExportInternals.flowNodesForTest(packet.tests[0])
    // Before the fix the whole try{} collapsed → start + 1 node + end = 3.
    expect(nodes.length).toBeGreaterThan(4)
    expect(nodes[0].kind).toBe('start')
    expect(nodes[nodes.length - 1].kind).toBe('end')
    // Inner assertions inside the try are surfaced (≥2), not collapsed.
    expect(nodes.filter((n) => n.kind === 'assertion').length).toBeGreaterThanOrEqual(2)
    // The literal-only declaration is not a flow step.
    expect(nodes.some((n) => (n.detail ?? '').includes('literal only'))).toBe(false)
  })

  it('soft-caps a very long flow with a "+N more steps" node', async () => {
    const featureDir = path.join(tmpDir, 'flow-cap')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'big.spec.ts')
    const steps = Array.from({ length: 30 }, (_, i) => `  await page.goto('/step-${i}')`).join('\n')
    const specSource = `import { test, expect } from '@playwright/test'

test('many steps', async ({ page }) => {
${steps}
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      feature: 'flow_cap',
      eventLocation: `${spec}:${lineOf(specSource, "test('many steps'")}`,
      title: 'many steps',
    }))
    const nodes = __testReviewExportInternals.flowNodesForTest(packet.tests[0])
    expect(nodes.some((n) => /\+\d+ more steps/.test(n.title))).toBe(true)
    // start + 24 capped steps + summary + end.
    expect(nodes.length).toBe(27)
  })
})

describe('test review export — additional branch coverage', () => {
  it('walks try/catch, if/else, loops, and multi-declarator statements into flow steps', () => {
    const featureDir = path.join(tmpDir, 'control-flow')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'flow.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('rich control flow', async ({ page }) => {
  await expect(page.locator('.anchor')).toBeVisible()
  try {
    await page.goto('/try')
  } catch (err) {
    await page.goto('/catch')
  }
  if (Date.now() > 0) {
    await page.goto('/then')
  } else {
    await page.goto('/else')
  }
  if (Date.now() > 0) {
    await page.goto('/lonely-then')
  }
  for (let i = 0; i < 2; i += 1) {
    await page.goto('/loop')
  }
  const first = makeFirst(), second = makeSecond()
  void first
  void second
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('rich control flow'")}`,
      title: 'rich control flow',
    }))
    const nodes = __testReviewExportInternals.flowNodesForTest(packet.tests[0])
    const details = nodes.map((n) => n.detail ?? '')

    // Each control-flow container surfaces its inner steps rather than collapsing.
    expect(details.some((d) => d.includes('/try'))).toBe(true)
    expect(details.some((d) => d.includes('/catch'))).toBe(true)
    expect(details.some((d) => d.includes('/then'))).toBe(true)
    expect(details.some((d) => d.includes('/else'))).toBe(true)
    expect(details.some((d) => d.includes('/lonely-then'))).toBe(true)
    expect(details.some((d) => d.includes('/loop'))).toBe(true)
    // The multi-declarator statement with calls survives as one meaningful step.
    expect(details.some((d) => d.includes('makeFirst'))).toBe(true)
  })

  it('falls back to raw line splitting when the test body is not a parseable block', () => {
    // A comment-only body produces a function declaration with no block body, so
    // the statement extractor drops to line-splitting and skips blank lines.
    const nodes = __testReviewExportInternals.flowNodesForTest({
      name: 'test-case-comment-only',
      title: 'comment only body',
      status: 'passed',
      testBody: '// first note\n\n// second note',
      helperCalls: [],
      helperDefinitions: [],
      externalImports: [],
      assertions: [],
    })
    const details = nodes.map((n) => n.detail ?? '')

    expect(details.some((d) => d.includes('first note'))).toBe(true)
    expect(details.some((d) => d.includes('second note'))).toBe(true)
    // start + 2 non-blank statements + end.
    expect(nodes.length).toBe(4)
  })
})
