import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { __testReviewExportInternals, buildEvaluationLlmPrompt, buildTestReviewPacket, createAssertionExport, createAssertionHtml, createEvaluationExport, createEvaluationHtml, evaluationCodexArgs, statusBucket, testStatusCounts, NOT_RUN_STATUS } from './test-review-export'
import type { RunDetail, PlaywrightPlaybackEvent } from '../../runs/logic/run-store'
import type { CoverageLedger } from '../../../../../../shared/coverage/types'

function coverageLedgerFor(testTitle: string): CoverageLedger {
  return {
    feature: 'checkout',
    requirements: [
      { requirement: { id: 'R1', title: 'Checkout', text: 'x', pathTypes: ['happy'] }, annotatedTestNames: [testTitle], pathCoverage: [{ path: 'happy', covered: true }], gapType: 'covered', coverageStatus: 'covered' },
    ],
    tests: [{ name: testTitle, requirements: ['R1'], pathTypes: ['happy'], strength: 'solid' }],
    totals: { total: 1, covered: 1, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
    coveragePct: 100,
    mappedPct: 100,
    orphanRequirementIds: [],
    orphanTestNames: [],
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('test review export', () => {
  it('leads with coverage strength + a Semantic Coverage section when a ledger is provided (A)', async () => {
    const html = await createEvaluationHtml(detail({ featureDir: tmpDir, title: 'passes checkout' }), {
      coverage: coverageLedgerFor('passes checkout'),
    })
    expect(html).toContain('Semantic coverage')
    expect(html).toContain('Coverage strength')
    expect(html).toContain('Solid')
    expect(html).toContain('@req-R1')
    // Specificity is demoted, not removed, and relabeled so it doesn't compete.
    expect(html).toContain('Assertion specificity')
  })

  it('falls back to Playwright assertion-specificity when no coverage ledger is provided', async () => {
    const html = await createEvaluationHtml(detail({ featureDir: tmpDir }))
    expect(html).toContain('Check specificity')
    expect(html).not.toContain('Coverage strength')
    expect(html).not.toContain('Semantic coverage')
  })

  it('builds Codex rewrite args with supported read-only flags', () => {
    expect(evaluationCodexArgs('rewrite prompt')).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      'rewrite prompt',
    ])
    expect(evaluationCodexArgs('rewrite prompt')).not.toContain('--full-auto')
    expect(evaluationCodexArgs('rewrite prompt')).not.toContain('--model')
    expect(evaluationCodexArgs('rewrite prompt')).not.toContain('--json')
    expect(evaluationCodexArgs('rewrite prompt', '/tmp/evaluation-output.txt', '/tmp/evaluation-schema.json')).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      '/tmp/evaluation-output.txt',
      '--output-schema',
      '/tmp/evaluation-schema.json',
      'rewrite prompt',
    ])
  })

  it('maps loop-generated tests back to the shared body and imported assertion helpers', () => {
    const featureDir = path.join(tmpDir, 'feature')
    const helperDir = path.join(featureDir, 'e2e', 'helpers')
    fs.mkdirSync(helperDir, { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'voucher.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'
import { expectOrderConfirmed, expectModalVisible, openVoucherModal } from './helpers/assertions'

const cases = ['expired'] as const
for (const code of cases) {
  test(\`rejects \${code} voucher\`, async ({ page }) => {
    await applyVoucher(page, code)
    await openVoucherModal(page)
    await expect(page.getByText('This voucher has expired')).toBeVisible()
    await expectOrderConfirmed(page)
    await expectModalVisible(page)
  })
}
`
    fs.writeFileSync(spec, specSource)
    fs.writeFileSync(path.join(helperDir, 'assertions.ts'), `import { expect } from '@playwright/test'

export async function expectOrderConfirmed(page) {
  await expect(page).toHaveURL(/thankyou/)
  await expect(page.getByText('Order confirmed')).toBeVisible()
}

export async function expectModalVisible(page) {
  await expect(page.locator('.modal')).toBeVisible()
}

export async function openVoucherModal(page) {
  await clickToolbarButton(page)
}

function clickToolbarButton(page) {
  return page.getByRole('button', { name: 'Vouchers' }).click()
}
`)

    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, 'test(`rejects')}`,
      title: 'rejects expired voucher',
    }))

    expect(packet.tests).toHaveLength(1)
    expect(packet.tests[0].title).toBe('rejects expired voucher')
    expect(packet.tests[0].testBody).toContain('await applyVoucher(page, code)')
    expect(packet.tests[0].helperCalls).toContain('applyVoucher(page, code)')
    expect(packet.tests[0].helperDefinitions).toContainEqual(expect.objectContaining({
      name: 'openVoucherModal',
      snippet: expect.stringContaining('clickToolbarButton(page)'),
    }))
    expect(packet.tests[0].helperDefinitions.find((helper) => helper.name === 'openVoucherModal')?.dependencies).toContainEqual(
      expect.objectContaining({ name: 'clickToolbarButton' }),
    )
    expect(packet.tests[0].assertions.some((assertion) => assertion.quality === 'strict')).toBe(true)
    expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({
      kind: 'helper',
      helperName: 'expectOrderConfirmed',
      quality: 'strict',
    }))
    expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({
      kind: 'helper',
      helperName: 'expectModalVisible',
      quality: 'moderate',
    }))
  })

  it('creates deterministic evaluation report html', async () => {
    const body = await createEvaluationHtml(detail({ featureDir: tmpDir }))

    expect(body).toContain('<p class="eyebrow">Evaluation report</p>')
    expect(body).toContain('<h1>Checkout</h1>')
    expect(body).toContain('Test cases')
    expect(body).not.toContain('Evaluation Summary')
    expect(body).not.toContain('Product Evaluation')
    expect(body).not.toContain('Engineering Evidence')
    expect(body).toContain('<section class="verdict" aria-label="Run verdict">')
    expect(body).toContain('<nav class="nav" aria-label="Test cases">')
    expect(body).toContain('id="1-passes-checkout" data-status="passed"')
    expect(body).toContain('<a href="#1-passes-checkout" data-section-id="1-passes-checkout">')
    expect(body).toContain('<span class="nav-label">Passes checkout</span>')
    expect(body).toContain('IntersectionObserver')
    expect(body).toContain("link.setAttribute('aria-current', 'true')")
    expect(body).toContain('flow-node')
    expect(body).toContain('data-code-line')
    expect(body).toContain('<summary>Test code</summary>')
    expect(body).not.toContain('scrollIntoView')
    expect(body).not.toContain('</span>\n<span class="code-line"')
    expect(body).toContain('<h3>How the test runs</h3>')
    expect(body).toContain('Evaluation flow for Passes checkout')
    expect(body).toContain('<!doctype html>')
    expect(body).not.toContain('test-review.json')
  })

  it('builds a constrained LLM prompt from technical evidence', () => {
    const templatePath = path.join(tmpDir, 'evaluation-rewrite.md')
    fs.writeFileSync(templatePath, 'Prompt from file\nEvidence:\n{{evidence}}\nText slots:\n{{textSlots}}\n{{sourceHtmlSection}}')
    const packet = buildTestReviewPacket(detail({ featureDir: tmpDir, title: 'call missed -> SMS fallback' }))
    const prompt = buildEvaluationLlmPrompt({
      packet,
      templatePath,
      sourceHtml: '<html>technical report</html>',
      flowcharts: [{ testName: packet.tests[0].name, steps: ['Start', 'Action: postSendCall', 'Result: passed'] }],
    })

    expect(prompt).toContain('Prompt from file')
    expect(prompt).toContain('"feature": "checkout"')
    expect(prompt).toContain('"title": "call missed -> SMS fallback"')
    expect(prompt).toContain('"checkStrength": "1 not graded"')
    expect(prompt).toContain('"flowSteps"')
    expect(prompt).toContain('Text slots')
    expect(prompt).toContain('"id": "cases.0.title"')
    expect(prompt).toContain('Current generated HTML to rewrite from.')
    expect(prompt).toContain('<html>technical report</html>')
  })

  it('loads the packaged evaluation rewrite prompt by default', () => {
    const packet = buildTestReviewPacket(detail({ featureDir: tmpDir, title: 'call missed -> SMS fallback' }))
    const prompt = buildEvaluationLlmPrompt({
      packet,
      sourceHtml: '<html>technical report</html>',
      flowcharts: [{ testName: packet.tests[0].name, steps: ['Start', 'Action: postSendCall', 'Result: passed'] }],
    })

    expect(prompt).toContain('Rewrite the human-facing text slots')
    expect(prompt).toContain('Return strict JSON')
    expect(prompt).toContain('"id": "cases.0.title"')
  })

  it('uses validated generated narrative when provided', async () => {
    const body = await createEvaluationHtml(detail({ featureDir: tmpDir }), {
      narrative: {
        featureTitle: 'Generated feature title',
        summary: 'Generated plain-language summary.',
        cases: [{
          title: 'Generated product title',
          whatWasChecked: 'Generated scenario explanation.',
          whyItMatters: 'Generated stakeholder impact.',
          confidence: 'Generated confidence note.',
          flowSteps: [{ title: 'Generated flow step', detail: 'Generated flow detail' }],
        }],
      },
    })

    expect(body).toContain('Generated feature title')
    expect(body).toContain('Generated plain-language summary.')
    expect(body).toContain('Generated product title')
    expect(body).toContain('Generated flow step')
  })

  it('title-cases feature slugs in the report chrome', async () => {
    const body = await createEvaluationHtml(detail({ featureDir: tmpDir, feature: 'shop_redeeming_eats_voucher' }))

    expect(body).toContain('<h1>Shop Redeeming Eats Voucher</h1>')
    expect(body).toContain('<title>Evaluation Report: Shop Redeeming Eats Voucher</title>')
  })

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

  it('renders per-test video links after assertions', async () => {
    const featureDir = path.join(tmpDir, 'video-feature')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'checkout.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('records checkout video', async ({ page }) => {
  await expect(page.getByText('Checkout')).toBeVisible()
})
`
    fs.writeFileSync(spec, specSource)

    const body = await createEvaluationHtml(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('records")}`,
      title: 'records checkout video',
    }), {
      videoLinksByTestName: {
        'test-case-records-checkout-video': ['run-1.webm'],
      },
    })

    expect(body).toContain('<h3>Video</h3>')
    expect(body).toContain('<video controls preload="metadata" src="run-1.webm"></video>')
    expect(body.indexOf('<h3>How the test runs</h3>')).toBeLessThan(body.indexOf('<summary>Test code</summary>'))
    expect(body.indexOf('<summary>Test code</summary>')).toBeLessThan(body.indexOf('<summary>Checks</summary>'))
    expect(body.indexOf('<summary>Checks</summary>')).toBeLessThan(body.indexOf('<h3>Video</h3>'))
  })

  it('keeps duplicate test titles addressable in the assertion review table of contents', async () => {
    const featureDir = path.join(tmpDir, 'duplicate-title-feature')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'duplicate.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('same title', async ({ page }) => {
  await expect(page.getByText('One')).toBeVisible()
})

test('same title', async ({ page }) => {
  await expect(page.getByText('Two')).toBeVisible()
})
`
    fs.writeFileSync(spec, specSource)
    const first = lineOf(specSource, "test('same title'")
    const second = specSource.slice(0, specSource.lastIndexOf("test('same title'")).split('\n').length

    const body = await createAssertionHtml({
      ...detail({ featureDir, eventLocation: `${spec}:${first}`, title: 'same title' }),
      playbackEvents: [
        testEndEvent(detail({ featureDir, eventLocation: `${spec}:${first}`, title: 'same title' })),
        testEndEvent(detail({ featureDir, eventLocation: `${spec}:${second}`, title: 'same title' })),
      ],
    })

    expect(body).toContain('id="1-same-title" data-status=')
    expect(body).toContain('id="2-same-title" data-status=')
    expect(body).toContain('<a href="#1-same-title" data-section-id="1-same-title">')
    expect(body).toContain('<a href="#2-same-title" data-section-id="2-same-title">')
  })

  it('escapes dynamic html while preserving highlighted code blocks', async () => {
    const featureDir = path.join(tmpDir, 'escape-feature')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'escape.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'
test('<script>alert("checkout")</script>', async ({ page }) => {
  await expect(page.getByText('<Checkout>')).toBeVisible()
})
`
    fs.writeFileSync(spec, specSource)
    const body = await createAssertionHtml(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('<script>")}`,
      title: '<script>alert("checkout")</script>',
    }), {
      videoLinksByTestName: {
        'test-case-script-alert-checkout-script': ['run" onclick="x.webm'],
      },
    })

    expect(body).toContain('&lt;script&gt;alert(&quot;checkout&quot;)&lt;/script&gt;')
    expect(body).not.toContain('<script>alert("checkout")</script>')
    expect(body).toContain('src="run&quot; onclick=&quot;x.webm"')
    expect(body).toContain('class="shiki')

    const exported = await createAssertionExport(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('<script>")}`,
      title: '<script>alert("checkout")</script>',
    }))
    const svg = exported.html
    expect(svg).toContain('&lt;script&gt;alert(&quot;checkout&quot;)&lt;/script&gt;')
    expect(svg).toContain('&lt;Checkout&gt;')
    expect(svg).not.toContain('<Checkout>')
    expect(svg).toContain('<polygon')
  })

  it('falls back to computed totals and unknown assertions when no summary or source match is available', () => {
    const failed = detail({ featureDir: path.join(tmpDir, 'missing-feature'), title: 'missing source' })
    failed.summary = undefined
    const failedEvent = testEndEvent(failed)
    failedEvent.status = 'failed'
    failedEvent.passed = false
    // Real Playwright reporter output can omit durationMs (e.g. a crashed worker);
    // the production code guards with `typeof durationMs === 'number'` (see
    // test-review-export.ts) even though the type declares it required, so this
    // narrow cast reproduces that real-world shape rather than the type's promise.
    ;(failedEvent as { durationMs?: number }).durationMs = undefined
    failedEvent.test.location = 'unparseable-location'
    failed.manifest.endedAt = undefined

    const packet = buildTestReviewPacket(failed)

    expect(packet).toEqual(expect.objectContaining({
      total: 1,
      passed: 0,
      failed: 1,
    }))
    expect(packet.endedAt).toBeUndefined()
    // The location doesn't resolve to a spec, so there is no "matched test body"
    // to have found nothing in — the rationale says what actually happened.
    expect(packet.tests[0].assertions).toEqual([
      expect.objectContaining({
        label: 'unknown',
        rationale: 'No source match was available for this test.',
      }),
    ])
  })

  it('adds summary-only passed tests that are not present in playback', () => {
    const packet = buildTestReviewPacket(detail({
      featureDir: tmpDir,
      passedNames: ['test-case-passes-checkout', 'test-case-summary-only'],
    }))

    expect(packet.tests.map((test) => test.title)).toEqual(['passes checkout', 'test-case-summary-only'])
    expect(packet.tests[1]).toEqual(expect.objectContaining({
      status: 'passed',
      assertions: [
        expect.objectContaining({
          rationale: 'No playback event or source match was available for this passed test.',
        }),
      ],
    }))
  })

  it('renders test bodies, nested helper assertions, imports, and deduped helpers', async () => {
    const featureDir = path.join(tmpDir, 'render-feature')
    const helperDir = path.join(featureDir, 'e2e', 'helpers')
    fs.mkdirSync(helperDir, { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'checkout.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'
import localDefault, { expectCheckoutReady as expectReadyAlias } from './helpers/assertions'

test('renders checkout review', async ({ page }) => {
  await page.waitForURL(/checkout/)
  await expect(page.getByText('Continue')).toBeVisible()
  expect(page.locator('.line-item').count()).toBeGreaterThan(0)
  expect(page.locator('.toast')).toBeAttached()
  expect(visibleState).toBeTruthy()
  expect(page.locator('.maybe')).toBeTruthy()
  await expectReadyAlias(page)
  await expectReadyAlias(page)
  await localDefault(page)
})
`
    fs.writeFileSync(spec, specSource)
    fs.writeFileSync(path.join(helperDir, 'assertions.ts'), `import { expect } from '@playwright/test'

export default async function localDefault(page) {
  await expect(page.getByText('Voucher redeemed')).toHaveText('Voucher redeemed')
}

export const expectCheckoutReady = async (page) => {
  await expect(page.getByRole('button', { name: 'Pay now' })).toBeEnabled()
  await expect(page.locator('.total')).toHaveCount(1)
  sharedCheck(page)
}

const sharedCheck = (page) => {
  expect(page.locator('.order')).toBeTruthy()
}
`)

    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('renders checkout review'")}`,
      title: 'renders checkout review',
      durationMs: 250,
    }))
    const html = await createAssertionHtml(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('renders checkout review'")}`,
      title: 'renders checkout review',
      durationMs: 250,
    }))

    expect(packet.tests[0].externalImports).toContain("import { test, expect } from '@playwright/test'")
    expect(packet.tests[0].helperCalls).toEqual(expect.arrayContaining(['expectReadyAlias(page)', 'localDefault(page)']))
    expect(packet.tests[0].helperDefinitions.map((helper) => helper.name)).toEqual(['expectCheckoutReady', 'localDefault'])
    expect(packet.tests[0].helperDefinitions[0].dependencies).toContainEqual(expect.objectContaining({ name: 'sharedCheck' }))
    expect(packet.tests[0].assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'waitForURL', quality: 'strict' }),
      expect.objectContaining({ label: 'toBeVisible', quality: 'moderate' }),
      expect.objectContaining({ label: 'toBeGreaterThan', quality: 'shallow' }),
      expect.objectContaining({ label: 'toBeTruthy', quality: 'shallow' }),
      expect.objectContaining({ helperName: 'expectReadyAlias', quality: 'strict' }),
    ]))
    expect(html).toContain('<summary>Test code</summary>')
    expect(html).toContain('<h3>How the test runs</h3>')
    expect(html).toContain('Evaluation flow for Renders checkout review')
    expect(html).not.toContain('<h3>Helper Calls</h3>')
    expect(html).toContain('Helper functions used')
    expect(html).toContain('<section class="implementations" id="local-codebase-implementations">')
    expect(html).toContain('helper: <code>expectReadyAlias</code>')
    expect(html).toContain('nested exact:')
    expect(html).not.toContain('<h3>External Imports</h3>')
    expect(html).not.toContain('<h3>expectCheckoutReady</h3>')
    expect(html).toContain('@playwright/test')
    expect(html).toContain('expectCheckoutReady')
    expect(html).toContain('localDefault')
    expect(html).toContain('<span class="case-duration">250ms</span>')
  })

  it('parses the 3-arg test(title, { tag }, body) form the coverage annotator writes', async () => {
    const featureDir = path.join(tmpDir, 'tagged-feature')
    const e2eDir = path.join(featureDir, 'e2e')
    fs.mkdirSync(e2eDir, { recursive: true })
    const spec = path.join(e2eDir, 'tagged.spec.ts')
    // The coverage tag-writer inserts a { tag: [...] } details object after the
    // title, which shifts the callback to the third argument. The export must
    // still locate the body — otherwise every annotated test reads as
    // "Source unavailable".
    const specSource = `import { test, expect } from '@playwright/test'

test.describe('PAT suite', () => {
  test('issues a token', { tag: ['@req-R1', '@path-happy'] }, async ({ request }) => {
    const res = await request.post('/pats')
    expect(res.status()).toBe(201)
  })
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('issues a token'")}`,
      title: 'issues a token',
    }))

    expect(packet.tests[0].testBody).toContain('request.post')
    expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({ label: 'toBe', quality: 'strict' }))
    expect(packet.tests[0].assertions).not.toContainEqual(
      expect.objectContaining({ rationale: expect.stringContaining('No static assertion') }),
    )
  })

  it('handles local helpers, template titles, skipped callback bodies, unresolved imports, and read failures', () => {
    const featureDir = path.join(tmpDir, 'edge-feature')
    const e2eDir = path.join(featureDir, 'e2e')
    fs.mkdirSync(e2eDir, { recursive: true })
    const spec = path.join(e2eDir, 'edge.spec.ts')
    const blocked = path.join(e2eDir, 'blocked.test.ts')
    const helperDir = path.join(e2eDir, 'helpers')
    fs.mkdirSync(helperDir, { recursive: true })
    const brokenHelper = path.join(helperDir, 'broken.ts')
    const specSource = `import { test } from '@playwright/test'
import { missingHelper } from '../../orchestration/logic/missing'
import { expectBroken } from './helpers/broken'

const caseName = 'template'
test(\`handles \${caseName} title\`, ({ page }) => expectLocal(page))
test('unreadable helper', ({ page }) => expectBroken(page))
test('has no callback body')
test.skip('not a real test body', async () => {})

function expectLocal(page) {
  return expectNested(page)
}

function expectNested(page) {
  return page.locator('.ready').click()
}
`
    fs.writeFileSync(spec, specSource)
    fs.writeFileSync(blocked, `import { test } from '@playwright/test'
test('blocked read', async ({ page }) => {
  await page.locator('.blocked').click()
})
`)
    fs.writeFileSync(brokenHelper, `export function expectBroken(page) {
  return page.locator('.broken').click()
}
`)
    const readFileSync = fs.readFileSync
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: Parameters<typeof fs.readFileSync> extends [fs.PathOrFileDescriptor, ...infer Rest] ? Rest : never[]) => {
      if (file === blocked || file === brokenHelper) throw new Error('blocked read')
      return readFileSync.call(fs, file, ...args as [BufferEncoding])
    }) as typeof fs.readFileSync)

    try {
      const packet = buildTestReviewPacket(detail({
        featureDir,
        eventLocation: `${spec}:${lineOf(specSource, 'test(`handles')}`,
        title: 'handles template title',
      }))

      expect(packet.tests[0].testBody).toBe('expectLocal(page);')
      expect(packet.tests[0].helperDefinitions).toContainEqual(expect.objectContaining({
        name: 'expectLocal',
        dependencies: [expect.objectContaining({ name: 'expectNested' })],
      }))
      expect(packet.tests[0].assertions).toEqual([
        expect.objectContaining({
          kind: 'helper',
          helperName: 'expectLocal',
          quality: 'unknown',
        }),
      ])
    } finally {
      readSpy.mockRestore()
    }
  })

  it('covers side-effect imports, namespace imports, skipped suite calls, function callbacks, and shared helper rendering', async () => {
    const featureDir = path.join(tmpDir, 'branch-feature')
    const helperDir = path.join(featureDir, 'e2e', 'helpers')
    fs.mkdirSync(helperDir, { recursive: true })
    fs.writeFileSync(path.join(helperDir, 'setup.ts'), `export const ready = true`)
    fs.writeFileSync(path.join(helperDir, 'namespace.ts'), `export function noop() { return true }`)
    fs.writeFileSync(path.join(helperDir, 'dep.ts'), `export function missingDep(page) {
  return page.locator('.missing').click()
}
`)
    fs.writeFileSync(path.join(helperDir, 'assertions.ts'), `import { expect } from '@playwright/test'
import { missingDep } from '../../orchestration/logic/dep'

export function expectNoBody

export const ignored = true, expectInline = (page) => {
  expect(page.getByText('success')).toBeTruthy()
}

export const other = true, expectVarDecl = (page) => page.locator('.var-decl').click()
export const otherFlag = true, expectFlag = true
export const { destructured } = { destructured: true }

export function expectShared(page) {
  ;(page.locator('.anonymous'))()
  missingDep(page)
  return expectInline(page)
}
`)
    const spec = path.join(featureDir, 'e2e', 'branch.spec.ts')
    const specSource = `import { test } from '@playwright/test'
import './helpers/setup'
import * as namespaceHelpers from './helpers/namespace'
import { expectFlag, expectInline, expectNoBody, expectShared, expectVarDecl } from './helpers/assertions'

test.describe('branch suite', () => {})
test.step('branch step', async () => {})
test()
test(123, async () => {})
test('non-function body', 123)
test(\`static template title\`, function ({ page }) {
  ;(await page.locator('.async-target')).click()
  ;(expectInline)(page)
  expectInline(page)
  expectNoBody(page)
  expectShared(page)
  expectVarDecl(page)
  expectFlag(page)
  namespaceHelpers.noop()
})
test('second shared helper', async ({ page }) => {
  expectShared(page)
})
`
    fs.writeFileSync(spec, specSource)
    const readFileSync = fs.readFileSync
    const dep = path.join(helperDir, 'dep.ts')
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: Parameters<typeof fs.readFileSync> extends [fs.PathOrFileDescriptor, ...infer Rest] ? Rest : never[]) => {
      if (file === dep) throw new Error('dependency read failed')
      return readFileSync.call(fs, file, ...args as [BufferEncoding])
    }) as typeof fs.readFileSync)

    try {
      const firstLine = lineOf(specSource, 'test(`static template title`')
      const secondLine = lineOf(specSource, "test('second shared helper'")
      const packet = buildTestReviewPacket(detail({
        featureDir,
        eventLocation: `${spec}:${firstLine}`,
        title: 'static template title',
        passedNames: ['test-case-static-template-title', 'test-case-second-shared-helper'],
      }))
      packet.tests.push(...buildTestReviewPacket(detail({
        featureDir,
        eventLocation: `${spec}:${secondLine}`,
        title: 'second shared helper',
      })).tests)
      const html = await createAssertionHtml({
        ...detail({
          featureDir,
          eventLocation: `${spec}:${firstLine}`,
          title: 'static template title',
          passedNames: ['test-case-static-template-title'],
        }),
        playbackEvents: [
          testEndEvent(detail({ featureDir, eventLocation: `${spec}:${firstLine}`, title: 'static template title' })),
          testEndEvent(detail({ featureDir, eventLocation: `${spec}:${secondLine}`, title: 'second shared helper' })),
        ],
      })

      expect(packet.tests[0].helperCalls).toEqual(expect.arrayContaining([
        'expectNoBody(page)',
        'expectShared(page)',
        'expectVarDecl(page)',
        'expectFlag(page)',
        'namespaceHelpers.noop()',
      ]))
      expect(packet.tests[0].helperDefinitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'expectNoBody', assertions: [] }),
        expect.objectContaining({ name: 'expectShared', dependencies: [expect.objectContaining({ name: 'expectInline' })] }),
      ]))
      expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({
        helperName: 'expectNoBody',
        quality: 'unknown',
      }))
      expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({
        helperName: 'expectInline',
        quality: 'shallow',
      }))
      expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({
        helperName: 'expectVarDecl',
        quality: 'unknown',
      }))
      expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({
        helperName: 'expectFlag',
        quality: 'unknown',
      }))
      expect(html).toContain('expectShared')
    } finally {
      readSpy.mockRestore()
    }
  })

  it('renders local helpers without an external import section', async () => {
    const featureDir = path.join(tmpDir, 'local-only-feature')
    const e2eDir = path.join(featureDir, 'e2e')
    fs.mkdirSync(e2eDir, { recursive: true })
    const spec = path.join(e2eDir, 'local.spec.ts')
    const specSource = `test('local helper only', ({ page }) => {
  expectLocalOnly(page)
})

function expectLocalOnly(page) {
  return page.locator('.ready').click()
}
`
    fs.writeFileSync(spec, specSource)

    const html = await createAssertionHtml(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('local helper only'")}`,
      title: 'local helper only',
    }))

    expect(html).toContain('Helper functions used')
    expect(html).toContain('expectLocalOnly')
    expect(html).not.toContain('<h3>External Imports</h3>')
  })

  it('uses broad deterministic wording without feature-specific localization maps', async () => {
    const featureDir = path.join(tmpDir, 'message_chain')
    const e2eDir = path.join(featureDir, 'e2e')
    fs.mkdirSync(e2eDir, { recursive: true })
    const spec = path.join(e2eDir, 'message.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('A. WA metadata.url -> SMS', async () => {
  test.skip(!OVERRIDE_FLAG_EXPECTED, 'requires canary override mode')
  const ids = makeIds('fallback-A')
  const res = await postSendMessage(ids, { metadataUrl: 'https://example.test' })
  expect(res.status).toBeLessThan(300)
})
`
    fs.writeFileSync(spec, specSource)

    const html = await createEvaluationHtml(detail({
      featureDir,
      feature: 'message_chain',
      eventLocation: `${spec}:${lineOf(specSource, "test('A. WA")}`,
      title: 'A. WA metadata.url -> SMS',
    }))

    expect(html).toContain('<h1>Message Chain</h1>')
    // Dotted identifiers are still humanised; bare acronyms are left alone
    // (lowercasing every capitalised run turned "OTPs" into "ot ps").
    expect(html).toContain('WA metadata url then SMS')
    expect(html).toContain('Skip if required test setup is missing')
    expect(html).toContain('Prepare unique identifiers')
    expect(html).toContain('Send message')
    expect(html).not.toContain('WhatsApp')
    expect(html).not.toContain('message link')
    expect(html).not.toContain('Make ids')
    expect(html).not.toContain('const ids =')
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

  it('covers internal rewrite parsing and audience wording branches', () => {
    const packet = buildTestReviewPacket(detail({ featureDir: tmpDir }))

    expect(__testReviewExportInternals.parseEvaluationRewrite('before ```json\n{"summary":"s","cases":[]}\n``` after')).toEqual({
      summary: 's',
      cases: [],
    })
    expect(__testReviewExportInternals.parseEvaluationRewrite('no object')).toBeUndefined()
    expect(__testReviewExportInternals.parseEvaluationRewrite('{not json}')).toBeUndefined()

    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('```json\n{"slots":[{"id":"summary","text":" New "},{"id":1,"text":"bad"},{"id":"x","text":2}]}\n```')).toEqual([
      { id: 'summary', text: ' New ' },
    ])
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('{"slots":[null,0,false,{"id":"summary","text":"ok"}]}')).toEqual([
      { id: 'summary', text: 'ok' },
    ])
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('{"slots":[]}')).toBeUndefined()
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('{"slots":{}}')).toBeUndefined()
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('not json')).toBeUndefined()
    expect(__testReviewExportInternals.previewAgentOutput('')).toBe('<empty output>')
    expect(__testReviewExportInternals.previewAgentOutput('x'.repeat(510))).toBe(`${'x'.repeat(500)}...`)
    expect(__testReviewExportInternals.renderPromptTemplate('{{known}} {{missing}}', { known: 'yes' })).toBe('yes {{missing}}')
    expect(__testReviewExportInternals.evaluationAgentModel('claude')).toBeNull()
    expect(__testReviewExportInternals.evaluationAgentModel('codex')).toBeNull()

    expect(__testReviewExportInternals.normalizeEvaluationRewrite(undefined, packet)).toBeNull()
    expect(__testReviewExportInternals.normalizeEvaluationRewrite({ summary: 'x', cases: [] }, packet)).toBeNull()
    expect(__testReviewExportInternals.normalizeEvaluationRewrite({
      featureTitle: 1,
      summary: 'x',
      cases: [{
        title: 't',
        whatWasChecked: 'w',
        whyItMatters: 'm',
        confidence: 'c',
        flowSteps: [{ title: 'step', detail: 1 }, null, { title: 2 }],
      }],
    } as never, packet)).toEqual({
      summary: 'x',
      cases: [{
        title: 't',
        whatWasChecked: 'w',
        whyItMatters: 'm',
        confidence: 'c',
        flowSteps: [{ title: 'step' }],
      }],
    })
    expect(__testReviewExportInternals.normalizeEvaluationRewrite({
      summary: 'x',
      cases: [{ title: 't', whatWasChecked: 'w', whyItMatters: 'm' }],
    } as never, packet)).toBeNull()
    expect(__testReviewExportInternals.evaluationTextSlots({
      summary: 'Summary',
      cases: [{
        title: 'Title',
        whatWasChecked: 'Checked',
        whyItMatters: 'Matters',
        confidence: 'Confidence',
        flowSteps: [{ title: 'Step without detail' }, { title: 'Step with detail', detail: 'Detail' }],
      }],
    })).toContainEqual({ id: 'cases.0.flowSteps.1.detail', text: 'Detail' })
    expect(__testReviewExportInternals.evaluationTextSlots({
      summary: 'Summary only',
      cases: [{ title: 'Title', whatWasChecked: 'Checked', whyItMatters: 'Matters', confidence: 'Confidence' }],
    })).toEqual([
      { id: 'summary', text: 'Summary only' },
      { id: 'cases.0.title', text: 'Title' },
      { id: 'cases.0.whatWasChecked', text: 'Checked' },
      { id: 'cases.0.whyItMatters', text: 'Matters' },
      { id: 'cases.0.confidence', text: 'Confidence' },
    ])
    expect(__testReviewExportInternals.applyEvaluationTextSlotRewrite({
      featureTitle: 'Base feature',
      summary: 'Base summary',
      cases: [{
        title: 'Base title',
        whatWasChecked: 'Base checked',
        whyItMatters: 'Base matters',
        confidence: 'Base confidence',
        flowSteps: [{ title: 'Base step' }, { title: 'Base detailed', detail: 'Base detail' }],
      }],
    }, [
      { id: 'featureTitle', text: 'New feature' },
      { id: 'cases.0.whatWasChecked', text: 'New checked' },
      { id: 'cases.0.flowSteps.0.detail', text: 'New detail' },
      { id: 'cases.0.flowSteps.1.title', text: 'New detailed title' },
    ])).toMatchObject({
      featureTitle: 'New feature',
      summary: 'Base summary',
      cases: [{
        title: 'Base title',
        whatWasChecked: 'New checked',
        whyItMatters: 'Base matters',
        confidence: 'Base confidence',
        flowSteps: [
          { title: 'Base step', detail: 'New detail' },
          { title: 'New detailed title', detail: 'Base detail' },
        ],
      }],
    })
    expect(__testReviewExportInternals.applyEvaluationTextSlotRewrite({
      summary: 'Base summary',
      cases: [{
        title: 'Base title',
        whatWasChecked: 'Base checked',
        whyItMatters: 'Base matters',
        confidence: 'Base confidence',
      }],
    }, [
      { id: 'featureTitle', text: '   ' },
      { id: 'summary', text: 'New summary' },
      { id: 'cases.0.title', text: 'New title' },
      { id: 'cases.0.whyItMatters', text: 'New matters' },
      { id: 'cases.0.confidence', text: 'New confidence' },
    ])).toEqual({
      summary: 'New summary',
      cases: [{
        title: 'New title',
        whatWasChecked: 'Base checked',
        whyItMatters: 'New matters',
        confidence: 'New confidence',
      }],
    })

    const failed = detail({ featureDir: tmpDir, title: 'fails checkout' })
    failed.manifest.status = 'failed'
    failed.summary = { complete: true, total: 1, passed: 0, failed: [{ name: 'test-case-fails-checkout', error: { message: 'boom' } }] }
    const failedEventForPrompt = testEndEvent(failed)
    failedEventForPrompt.status = 'failed'
    failedEventForPrompt.passed = false
    const failedPacket = buildTestReviewPacket(failed)
    const promptTemplate = path.join(tmpDir, 'prompt.md')
    fs.writeFileSync(promptTemplate, '{{evidence}}\n{{textSlots}}\n{{sourceHtmlSection}}\n{{unknown}}')
    const failedPrompt = buildEvaluationLlmPrompt({
      packet: failedPacket,
      templatePath: promptTemplate,
      flowcharts: [{ testName: 'different-test', steps: ['unused'] }],
    })
    expect(failedPrompt).toContain('"failureMessages"')
    expect(failedPrompt).toContain('[]')
    expect(failedPrompt).toContain('{{unknown}}')

    expect(__testReviewExportInternals.audienceTitle('B. authAPI warn incl auto-resolved -> done')).toBe('Auth api warning including automatically resolved then done')
    // Only code-shaped words get split apart. Acronyms, prose abbreviations and
    // ordinary words stay verbatim — splitting them produced titles like
    // "stops issuing ot ps" and "e g. English".
    expect(__testReviewExportInternals.audienceTitle('stops issuing OTPs, e.g. after a burst')).toBe('Stops issuing OTPs, e.g. after a burst')
    expect(__testReviewExportInternals.audienceTitle('reads res.body and user_id')).toBe('Reads res body and user identifier')
    expect(__testReviewExportInternals.audienceFlowDetail('2 nested assertions')).toBe('2 checks inside this shared step')
    expect(__testReviewExportInternals.audienceFlowDetail('1 nested assertion')).toBe('1 check inside this shared step')
    expect(__testReviewExportInternals.audienceFlowDetail('strict unknown nested assertion')).toBe('exact not graded included checks')
    expect(__testReviewExportInternals.audienceFlowDetail('const ids = makeIds()')).toBe('Uses the recorded test step.')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'start', title: 'Checkout starts' } as never, packet.tests[0])).toBe('Start the scenario')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'end', title: 'Result: failed' } as never, packet.tests[0])).toBe('Run result: failed')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'assertion', title: 'strict assertion' } as never, packet.tests[0])).toBe('Check the expected outcome')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'helper', title: 'Helper: makeIds', detail: 'const ids = makeIds()' } as never, packet.tests[0])).toBe('Prepare unique identifiers')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'setup', title: 'Setup' } as never, packet.tests[0])).toBe('Prepare the scenario')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'action', title: 'Action', detail: 'await page.click()' } as never, packet.tests[0])).toBe('Click the relevant control')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'action', title: 'Action' } as never, packet.tests[0])).toBe('Run the next step')

    expect(__testReviewExportInternals.readableAction('await expect(page.locator(".ready")).toBeVisible()', packet.tests[0])).toBe('Check the expected outcome')
    expect(__testReviewExportInternals.readableAction('await page.click()', packet.tests[0])).toBe('Click the relevant control')
    expect(__testReviewExportInternals.readableAction('await page.fill()', packet.tests[0])).toBe('Enter the required value')
    expect(__testReviewExportInternals.readableAction('await page.waitForURL(/done/)', packet.tests[0])).toBe('Wait for for url')
    expect(__testReviewExportInternals.readableAction('route request', packet.tests[0])).toBe('Prepare test data or mocks')
    expect(__testReviewExportInternals.readableAction('void anything', packet.tests[0])).toBe('Passes checkout')

    expect(__testReviewExportInternals.readableActionName('newClock', 'const start = new Date()')).toBe('Record the start time')
    expect(__testReviewExportInternals.actionFromIdentifier('expectOrder')).toBe('check order')
    expect(__testReviewExportInternals.actionFromIdentifier('assert')).toBe('check the expected outcome')
    expect(__testReviewExportInternals.actionFromIdentifier('mock')).toBe('prepare test data')
    expect(__testReviewExportInternals.actionFromIdentifier('create', 'const ids = makeIds()')).toBe('prepare unique identifiers')
    expect(__testReviewExportInternals.actionFromIdentifier('createUserId')).toBe('prepare unique identifiers')
    expect(__testReviewExportInternals.actionFromIdentifier('send')).toBe('send the request')
    expect(__testReviewExportInternals.actionFromIdentifier('postSendCall')).toBe('send call')
    expect(__testReviewExportInternals.actionFromIdentifier('read')).toBe('read the saved record')
    expect(__testReviewExportInternals.actionFromIdentifier('findOrder')).toBe('read order')
    expect(__testReviewExportInternals.actionFromIdentifier('poll')).toBe('wait for the expected result')
    expect(__testReviewExportInternals.actionFromIdentifier('waitReceipt')).toBe('wait for receipt')
    expect(__testReviewExportInternals.actionFromIdentifier('restore')).toBe('restore test data')
    expect(__testReviewExportInternals.actionFromIdentifier('enableFlag')).toBe('enable flag')
    expect(__testReviewExportInternals.actionFromIdentifier('with')).toBe('check the related records')
    expect(__testReviewExportInternals.actionFromIdentifier('hasClickTarget')).toBe('click the relevant control')
    expect(__testReviewExportInternals.actionFromIdentifier('')).toBe('')

    expect(__testReviewExportInternals.readableCreatedObject([], 'orderIds')).toBe('unique identifiers')
    expect(__testReviewExportInternals.readableCreatedObject([], undefined)).toBe('test data')
    expect(__testReviewExportInternals.readableHelperName('')).toBe('')

    expect(__testReviewExportInternals.classifyAssertion('expect(x).toBeHidden()', 'toBeHidden')).toBe('moderate')
    expect(__testReviewExportInternals.classifyAssertion('expect(count).toBeTruthy()')).toBe('shallow')
    expect(__testReviewExportInternals.classifyAssertion('expect(foo).toBeTruthy()')).toBe('unknown')

    expect(__testReviewExportInternals.confidenceForAssertions([{ kind: 'direct', label: 'x', quality: 'moderate', rationale: '', snippet: '' }])).toContain('behavioral')
    expect(__testReviewExportInternals.confidenceForAssertions([{ kind: 'direct', label: 'x', quality: 'unknown', rationale: '', snippet: '' }])).toContain('Review the engineering evidence')
    expect(__testReviewExportInternals.qualityLabel('moderate')).toBe('behavioral')
    expect(__testReviewExportInternals.qualitySummary([])).toBe('')
    expect(__testReviewExportInternals.qualitySummaryForAudience([{ kind: 'direct', label: 'x', quality: 'shallow', rationale: '', snippet: '' }])).toBe('1 surface-level')
    expect(__testReviewExportInternals.rationaleForAudience('Static analysis could not confidently classify this assertion.')).toContain("couldn't auto-rate")
    expect(__testReviewExportInternals.rationaleForAudience('other')).toBe('other')

    expect(__testReviewExportInternals.resultColor('failed')).toMatchObject({ stroke: 'var(--flow-fail-line)' })
    expect(__testReviewExportInternals.resultColor('aborted')).toMatchObject({ stroke: 'var(--flow-neutral-line)' })
    expect(__testReviewExportInternals.statusClass('')).toBe('unknown')
    expect(__testReviewExportInternals.formatMs(999)).toBe('999ms')
    expect(__testReviewExportInternals.wrapSvgText('', 10)).toEqual([''])
    expect(__testReviewExportInternals.wrapSvgText('averyverylongword', 5)).toEqual(['avery', 'veryl', 'ongwo', 'rd'])
    expect(__testReviewExportInternals.applyFlowStepRewrite([
      { kind: 'start', title: 'Original start' },
      { kind: 'action', title: 'Original action', detail: 'Original detail' },
    ] as never, [])).toEqual([
      { kind: 'start', title: 'Original start' },
      { kind: 'action', title: 'Original action', detail: 'Original detail' },
    ])
    expect(__testReviewExportInternals.applyFlowStepRewrite([
      { kind: 'start', title: 'Original start' },
      { kind: 'action', title: 'Original action', detail: 'Original detail' },
    ] as never, [{ title: 'New start' }, { title: '', detail: 'Ignored detail' }])).toEqual([
      { kind: 'start', title: 'New start' },
      { kind: 'action', title: 'Original action', detail: 'Original detail' },
    ])
    expect(__testReviewExportInternals.flowNodesForTest({
      ...packet.tests[0],
      testBody: '',
      assertions: [],
    })).toContainEqual(expect.objectContaining({ title: 'Source unavailable', detail: 'No static source match' }))
    expect(__testReviewExportInternals.renderAssertionHtml({
      kind: 'direct',
      label: 'unknown',
      quality: 'unknown',
      rationale: 'Static analysis could not confidently classify this assertion.',
      snippet: 'expect(value).toBeTruthy()',
    })).not.toContain('helper-ref')
    expect(__testReviewExportInternals.renderAssertionHtml({
      kind: 'helper',
      label: 'expectHelper',
      quality: 'strict',
      rationale: 'Uses toHaveText matcher.',
      snippet: 'expectHelper(page)',
      helperSnippet: 'function expectHelper() {}',
      helperName: 'expectHelper',
      nested: [],
    })).toContain('helper-ref')
    expect(__testReviewExportInternals.addCodeLineMarkers('<pre>plain</pre>')).toBe('<pre>plain</pre>')
    expect(__testReviewExportInternals.addCodeLineMarkers('<pre><code>a\n\nb</code></pre>')).toContain('<span class="line-source"> </span>')
    const functionSrc = ts.createSourceFile('helpers.ts', 'const helper = () => true\nconst value = 1', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const [helperStmt, valueStmt] = functionSrc.statements
    expect(__testReviewExportInternals.functionLikeBody(helperStmt)).toBeDefined()
    expect(__testReviewExportInternals.functionLikeBody(valueStmt)).toBeUndefined()
  })
})

describe('test review export — additional branch coverage', () => {
  it('grades an unrecognized matcher as unknown with the last-resort rationale', () => {
    const featureDir = path.join(tmpDir, 'unknown-matcher')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'unknown.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('unrecognized matcher', async ({ page }) => {
  await expect(page.locator('.thing')).toBeWibble()
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('unrecognized")}`,
      title: 'unrecognized matcher',
    }))

    expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({
      kind: 'direct',
      label: 'toBeWibble',
      quality: 'unknown',
      rationale: 'Static analysis could not confidently classify this assertion.',
    }))
  })

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

  it('renders coverage strength with the shallow default and unmapped requirements', async () => {
    const featureDir = path.join(tmpDir, 'cov-defaults')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'cov.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('covered scenario', async ({ page }) => {
  await expect(page.getByText('Done')).toBeVisible()
})
`
    fs.writeFileSync(spec, specSource)
    // A test-coverage entry with no strength and no mapped requirements exercises
    // the `strength ?? 'shallow'` default and the empty-requirements branch.
    const ledger: CoverageLedger = {
      feature: 'checkout',
      requirements: [],
      tests: [{ name: 'covered scenario', requirements: [], pathTypes: [] }],
      totals: { total: 0, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
      coveragePct: 0,
      mappedPct: 0,
      orphanRequirementIds: [],
      orphanTestNames: [],
    }
    const html = await createEvaluationHtml(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('covered scenario'")}`,
      title: 'covered scenario',
    }), { coverage: ledger })

    expect(html).toContain('Coverage strength')
    expect(html).toContain('Shallow')
    expect(html).toContain('unmapped')
  })

  it('falls back to the title-cased feature name when the narrative omits a feature title', async () => {
    const html = await createEvaluationHtml(detail({ featureDir: tmpDir, feature: 'checkout_flow' }), {
      narrative: {
        summary: 'Summary without a feature title.',
        cases: [{
          title: 'Case one',
          whatWasChecked: 'Checked.',
          whyItMatters: 'Matters.',
          confidence: 'Confidence.',
        }],
      },
    })

    expect(html).toContain('<h1>Checkout Flow</h1>')
    expect(html).toContain('Summary without a feature title.')
  })

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

  it('labels shared helper flow steps by their nested assertion count', () => {
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
    const details = nodes.map((n) => n.detail ?? '')

    expect(details).toContain('1 nested assertion')
    expect(details).toContain('2 nested assertions')
    // A zero-assertion helper falls back to the inlined call statement.
    expect(details.some((d) => d.includes('stepZero(page)'))).toBe(true)
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

  it('ignores non-test-end playback events when building the packet', async () => {
    const base = detail({ featureDir: tmpDir })
    const endEvent = testEndEvent(base)
    const withBegin: RunDetail = {
      ...base,
      playbackEvents: [
        { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test: { name: endEvent.test.name, title: endEvent.test.title, location: endEvent.test.location } },
        endEvent,
      ],
    }
    const html = await createEvaluationHtml(withBegin)

    expect(html).toContain('<span class="case-index">01</span>')
    // The test-begin event must not create a second test case.
    expect(html).not.toContain('<span class="case-index">02</span>')
  })

  it('covers remaining internal helper branches', () => {
    const packet = buildTestReviewPacket(detail({ featureDir: tmpDir }))
    const internals = __testReviewExportInternals

    // parseEvaluationTextSlotRewrite: braces present but invalid JSON → catch → undefined.
    expect(internals.parseEvaluationTextSlotRewrite('{ not valid json }')).toBeUndefined()

    // readableAction reaches the keyword fallbacks only when no call identifier
    // is present in the statement text.
    expect(internals.readableAction('please click the primary button', packet.tests[0])).toBe('Click the relevant control')
    expect(internals.readableAction('fill the email field', packet.tests[0])).toBe('Enter the required value')
    expect(internals.readableAction('waitForURL after submit', packet.tests[0])).toBe('Wait for the expected page')

    // readableActionName: empty identifier → generic step wording.
    expect(internals.readableActionName('', 'plain statement')).toBe('Run the next step')

    // displayWord singular/plural id normalization via a non-create verb.
    expect(internals.actionFromIdentifier('toggleIds')).toBe('toggle identifiers')
    expect(internals.actionFromIdentifier('toggleId')).toBe('toggle identifier')

    // renderAssertionHtml: helperSnippet present but helperName absent → empty code.
    expect(internals.renderAssertionHtml({
      kind: 'helper',
      label: 'anon',
      quality: 'strict',
      rationale: 'Uses toHaveText matcher.',
      snippet: 'anon(page)',
      helperSnippet: 'function anon() {}',
    })).toContain('helper: <code></code>')

    // functionLikeBody: VariableDeclaration (function + non-function) and a node
    // that is none of the handled kinds.
    const src = ts.createSourceFile('h.ts', 'const arrow = () => 1\nconst num = 5\nplainCall()', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const [arrowStmt, numStmt, exprStmt] = src.statements
    const arrowDecl = (arrowStmt as ts.VariableStatement).declarationList.declarations[0]
    const numDecl = (numStmt as ts.VariableStatement).declarationList.declarations[0]
    expect(internals.functionLikeBody(arrowDecl)).toBeDefined()
    expect(internals.functionLikeBody(numDecl)).toBeUndefined()
    expect(internals.functionLikeBody(exprStmt)).toBeUndefined()
  })

  it('ignores a JSON candidate that is an object without a `cases` array', () => {
    // The rewrite envelope is anchored on `cases`, so an agent answer whose only
    // parseable object is some other shape must not be mistaken for a rewrite.
    expect(__testReviewExportInternals.parseEvaluationRewrite('{"summary":"looks fine","tests":3}'))
      .toBeUndefined()
  })

  it('ignores a JSON candidate that is not an object at all', () => {
    // extractJsonCandidates parses whatever a fenced block contains, including a
    // bare scalar or null — neither of which can carry a `slots` array.
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('```json\n42\n```')).toBeUndefined()
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('```json\nnull\n```')).toBeUndefined()
  })

  it('grades a bare boolean toBe as moderate rather than strict', () => {
    // `tobe` sits in the exact-matcher table, but `toBe(true)` pins almost
    // nothing — so the demotion has to happen before that table is consulted.
    expect(__testReviewExportInternals.classifyAssertion('await expect(ok).toBe(true)', 'toBe')).toBe('moderate')
    expect(__testReviewExportInternals.classifyAssertion('await expect(v).toBe(null)', 'toBe')).toBe('moderate')
    // The complement: a concrete expected value keeps the strict grade.
    expect(__testReviewExportInternals.classifyAssertion('await expect(total).toBe(42)', 'toBe')).toBe('strict')
  })

  it('suffixes repeated section ids and falls back for a value that sanitises to nothing', () => {
    // Both arms belong to the helper's contract (anchor ids must be unique and
    // non-empty); the production caller index-prefixes every value, so neither
    // is reachable through it.
    expect(__testReviewExportInternals.uniqueSectionIds(['Checkout flow', 'Checkout flow', 'checkout   flow']))
      .toEqual(['checkout-flow', 'checkout-flow-2', 'checkout-flow-3'])
    expect(__testReviewExportInternals.safeFilename('!!!')).toBe('section')
    expect(__testReviewExportInternals.safeFilename('Checkout Flow')).toBe('checkout-flow')
  })

  it('reconstructs cases from the summary when a run detail has no playback events', () => {
    // `playbackEvents` is optional on RunDetail. Rather than reporting zero
    // tests, the packet falls back to summary.passedNames and says plainly that
    // no playback evidence was available — the count stays honest either way.
    const base = detail({ featureDir: tmpDir })
    const packet = buildTestReviewPacket({ ...base, playbackEvents: undefined })

    expect(packet.runId).toBe('run-1')
    expect(packet.tests).toHaveLength(1)
    expect(packet.tests[0].name).toBe('test-case-passes-checkout')
    expect(packet.tests[0].assertions).toEqual([expect.objectContaining({
      quality: 'unknown',
      rationale: 'No playback event or source match was available for this passed test.',
    })])
  })

  it('omits the Ended row when the run has no end timestamp', async () => {
    // A run still in flight has no manifest.endedAt, so the header drops the row
    // instead of rendering an empty definition.
    const base = detail({ featureDir: tmpDir })
    const running: RunDetail = { ...base, manifest: { ...base.manifest, endedAt: undefined } }
    const html = await createEvaluationHtml(running)

    expect(html).not.toContain('<dt>Ended</dt>')
    // The sibling rows that don't depend on endedAt are still there.
    expect(html).toContain('<dt>Started</dt>')
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
    const helperNode = __testReviewExportInternals.flowNodesForTest(packet.tests[0])
      .find((node) => node.title === 'Helper: outer')
    expect(helperNode?.detail).toBe('1 nested assertion')

    // `detail` is optional on a FlowNode, so the audience title reads the helper
    // name when there is nothing else to describe the step with.
    expect(__testReviewExportInternals.audienceFlowTitle(
      { kind: 'helper', title: 'Helper: openVoucherModal' },
      packet.tests[0],
    )).toBe('Open voucher modal')
  })
})

// The report's central promise: it lists every test the feature DECLARED, and
// says plainly which of them the run never reached. A run that stops at the
// failure limit must not shrink the suite it reports on.
describe('declared-test roster', () => {
  let spec: string

  function rosterDetail(overrides: Partial<RunDetail> = {}): RunDetail {
    return {
      runId: 'run-roster',
      manifest: {
        runId: 'run-roster',
        feature: 'checkout',
        featureDir: tmpDir,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:09.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
      },
      summary: {
        complete: true,
        total: 12,
        passed: 3,
        passedNames: ['test-case-ran-and-passed', 'test-case-passed-by-name'],
        passedIds: ['id-pass', 'id-pass-2'],
        skippedIds: ['id-skip'],
        skippedNames: ['test-case-skipped-by-name'],
        failed: [
          { id: 'id-fail', name: 'test-case-ran-and-failed', error: { message: 'boom', snippet: '> 12 | expect(x)' } },
          { id: 'id-fail-2', name: 'test-case-failed-no-playback' },
          { name: 'test-case-failed-by-name', error: { message: 'named failure  ' } },
        ],
        knownTests: [
          { id: 'id-pass', name: 'test-case-ran-and-passed', title: '@req-R1 @path-happy ran and passed', location: `${spec}:3` },
          { id: 'id-fail', name: 'test-case-ran-and-failed', title: 'ran and failed', location: `${spec}:7` },
          { id: 'id-stop', name: 'test-case-interrupted', title: 'interrupted mid-flight', location: `${spec}:11` },
          { id: 'id-fail-2', name: 'test-case-failed-no-playback', title: 'failed without playback', location: `${spec}:15` },
          { name: 'test-case-failed-by-name', title: 'failed by name' },
          { id: 'id-skip', name: 'test-case-skipped-by-id', title: 'skipped by id' },
          { name: 'test-case-skipped-by-name', title: 'skipped by name' },
          { id: 'id-pass-2', name: 'test-case-passed-by-id', title: 'passed by id' },
          { name: 'test-case-passed-by-name', title: 'passed by name' },
          // No title: the roster falls back to the test's name.
          { id: 'id-never', name: 'test-case-never-reached' },
          // A malformed location must not break the per-spec grouping.
          { id: 'id-never-2', name: 'test-case-also-never-reached', title: 'also never reached', location: '/:12' },
          // A title made only of coverage annotations still has to render as
          // something — the tags are stripped for display.
          { id: 'id-never-3', name: 'test-case-tags-only', title: '@req-R9' },
        ],
      },
      playbackEvents: [
        {
          type: 'test-end',
          time: '2026-01-01T00:00:05.000Z',
          test: { id: 'id-pass', name: 'test-case-ran-and-passed', title: '@req-R1 @path-happy ran and passed', location: `${spec}:3` },
          status: 'passed',
          passed: true,
          durationMs: 120,
          retry: 0,
        },
        {
          type: 'test-end',
          time: '2026-01-01T00:00:06.000Z',
          test: { id: 'id-fail', name: 'test-case-ran-and-failed', title: 'ran and failed', location: `${spec}:7` },
          status: 'failed',
          passed: false,
          durationMs: 90,
          retry: 0,
          error: { message: 'boom from playback', snippet: '> 8 | expect(y)' },
        },
        {
          type: 'test-end',
          time: '2026-01-01T00:00:07.000Z',
          test: { id: 'id-stop', name: 'test-case-interrupted', title: 'interrupted mid-flight', location: `${spec}:11` },
          status: 'interrupted',
          passed: false,
          durationMs: 40,
          retry: 0,
        },
      ],
      ...overrides,
    } as RunDetail
  }

  beforeEach(() => {
    const e2e = path.join(tmpDir, 'e2e')
    fs.mkdirSync(e2e, { recursive: true })
    spec = path.join(e2e, 'checkout.spec.ts')
    fs.writeFileSync(spec, `import { test, expect } from '@playwright/test'\n\ntest('ran and passed', async () => {\n  expect(1).toBe(1)\n})\n`)
  })

  it('lists every declared test and marks the ones the run never reached', () => {
    const packet = buildTestReviewPacket(rosterDetail())

    expect(packet.tests).toHaveLength(12)
    expect(packet.tests.map((test) => [test.title, test.status])).toEqual([
      ['@req-R1 @path-happy ran and passed', 'passed'],
      ['ran and failed', 'failed'],
      ['interrupted mid-flight', 'interrupted'],
      ['failed without playback', 'failed'],
      ['failed by name', 'failed'],
      ['skipped by id', 'skipped'],
      ['skipped by name', 'skipped'],
      ['passed by id', 'passed'],
      ['passed by name', 'passed'],
      ['test-case-never-reached', NOT_RUN_STATUS],
      ['also never reached', NOT_RUN_STATUS],
      ['@req-R9', NOT_RUN_STATUS],
    ])
    // A never-run test carries no evidence — not an empty pass.
    expect(packet.tests[9].assertions[0].rationale).toBe('This test was never executed, so the run produced no evidence for it.')
    // Counts stay read from the summary, never re-derived as total - failed.
    expect(packet.passed).toBe(3)
    expect(packet.total).toBe(12)
  })

  it('splits the run into buckets that add up to the declared total', () => {
    const packet = buildTestReviewPacket(rosterDetail())

    expect(testStatusCounts(packet.tests)).toEqual({ passed: 3, failed: 3, interrupted: 1, skipped: 2, notRun: 3 })
    const counts = testStatusCounts(packet.tests)
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(packet.tests.length)
  })

  it('prefers the playback verdict over the summary lists', () => {
    const detailWithConflict = rosterDetail()
    // The same test appears as passed in the summary while playback recorded a
    // failure — the per-test verdict wins, and nothing rounds up to a pass.
    detailWithConflict.summary!.passedNames = [...detailWithConflict.summary!.passedNames!, 'test-case-ran-and-failed']
    const packet = buildTestReviewPacket(detailWithConflict)

    expect(packet.tests.find((test) => test.name === 'test-case-ran-and-failed')?.status).toBe('failed')
  })

  it('resolves a summary-only conflict downward rather than up', () => {
    const conflicted = rosterDetail({ playbackEvents: [] })
    conflicted.summary!.passedNames = ['test-case-failed-by-name']
    const packet = buildTestReviewPacket(conflicted)

    expect(packet.tests.find((test) => test.name === 'test-case-failed-by-name')?.status).toBe('failed')
  })

  it('keeps reported tests the roster somehow missed', () => {
    const withExtra = rosterDetail()
    withExtra.summary!.knownTests = withExtra.summary!.knownTests!.slice(0, 1)
    withExtra.summary!.passedNames = ['test-case-summary-only']
    const packet = buildTestReviewPacket(withExtra)

    expect(packet.tests.map((test) => test.name)).toEqual([
      'test-case-ran-and-passed',
      'test-case-ran-and-failed',
      'test-case-interrupted',
      'test-case-summary-only',
    ])
  })

  it('falls back to the executed set for runs recorded before knownTests existed', () => {
    const legacy = rosterDetail()
    delete legacy.summary!.knownTests
    const packet = buildTestReviewPacket(legacy)

    expect(packet.tests.map((test) => test.name)).toEqual([
      'test-case-ran-and-passed',
      'test-case-ran-and-failed',
      'test-case-interrupted',
      'test-case-passed-by-name',
    ])
  })

  it('renders the never-ran block, the failure reason and the result map', async () => {
    const html = await createEvaluationHtml(rosterDetail())

    // The headline a reader needs before reading a single pass ratio.
    expect(html).toContain('<span class="notice-badge">Incomplete run</span>')
    expect(html).toContain('<strong>3 of 12 declared tests never ran.</strong>')
    expect(html).toContain('3 of the 12 declared scenarios never ran, so they are neither passing nor failing evidence.')
    expect(html).toContain('This test was declared but never executed in this run.')
    expect(html).toContain('data-status="notRun"')
    expect(html).toContain('<span class="legend-value">1</span>')
    expect(html).toContain('<span class="legend-label">Interrupted</span>')

    // Failures carry their reason; the code frame only appears when there is one.
    expect(html).toContain('<h3>Why it failed</h3>')
    expect(html).toContain('boom')
    expect(html).toContain('&gt; 12 | expect(x)')
    expect(html).toContain('<pre class="failure-message">named failure</pre>')

    // Navigation: grouped by spec file, with a per-test result map.
    expect(html).toContain('<span class="spec-name">checkout.spec.ts</span>')
    expect(html).toContain('<span class="spec-name">Other tests</span>')
    expect(html).toContain('<span class="spec-name">/</span>')
    expect(html).toContain('data-matrix-cell')
    expect(html).toContain('never ran')

    // Annotation tags are lifted out of the headline and shown as tags.
    expect(html).toContain('<span class="tag">@req-R1</span>')
    expect(html).toContain('<span class="tag">@path-happy</span>')
    expect(html).toContain('<span class="case-title">Ran and passed</span>')
    expect(html).toContain('<span class="case-title">@req-R9</span>')
  })

  it('offers light, system and dark themes without a network round-trip', async () => {
    const html = await createEvaluationHtml(rosterDetail())

    expect(html).toContain('data-theme-set="light"')
    expect(html).toContain('data-theme-set="auto"')
    expect(html).toContain('data-theme-set="dark"')
    // The stored choice is applied before first paint, so dark-mode readers
    // never get a white flash.
    expect(html).toContain("localStorage.getItem('canary-evaluation-theme')")
    expect(html.indexOf('canary-evaluation-theme')).toBeLessThan(html.indexOf('<body>'))
    // Both palettes ship; neither is fetched.
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).toContain(':root[data-theme="dark"]')
    expect(html).not.toMatch(/<link[^>]+href="https?:/)
    expect(html).not.toMatch(/@import\s+url\(/)
  })

  it('re-attaches a rewrite written before never-run tests were listed', async () => {
    const stored = {
      featureTitle: 'Checkout Safeguards',
      // Written when the report only showed executed tests: the three playback
      // entries in playback order, then the summary-only passes the old builder
      // appended. Rebuilding that order is what lets each case find its test.
      summary: 'Of the five scenarios shown here, one passed.',
      cases: [
        { title: 'A shopper checks out', whatWasChecked: 'Checked A.', whyItMatters: 'Matters A.', confidence: 'High.' },
        { title: 'A declined card is refused', whatWasChecked: 'Checked B.', whyItMatters: 'Matters B.', confidence: 'Low.' },
        { title: 'A slow gateway stops the run', whatWasChecked: 'Checked C.', whyItMatters: 'Matters C.', confidence: 'Low.' },
        { title: 'A summary-only pass', whatWasChecked: 'Checked D.', whyItMatters: 'Matters D.', confidence: 'Low.' },
        { title: 'A pass known only by name', whatWasChecked: 'Checked E.', whyItMatters: 'Matters E.', confidence: 'Low.' },
      ],
    }
    const html = await createEvaluationHtml(rosterDetail(), { rewrite: stored })

    // Authored wording survives, still attached to the test it was written about.
    expect(html).toContain('<h1>Checkout Safeguards</h1>')
    expect(html).toContain('<span class="case-title">A shopper checks out</span>')
    expect(html).toContain('<span class="case-title">A declined card is refused</span>')
    expect(html).toContain('Checked C.')
    expect(html).toContain('<span class="case-title">A pass known only by name</span>')
    // The stale run-level claim does not: it described a 5-scenario report.
    expect(html).not.toContain('Of the five scenarios shown here')
    expect(html).toContain('Checkout Safeguards was evaluated with 12 scenarios.')
  })

  it('rebuilds the legacy order without double-counting a pass it already listed', async () => {
    const detailWithSlugMatch = rosterDetail()
    // The old builder skipped a `passedNames` entry whose slug already matched a
    // playback title, so the rebuilt order has to skip it too — one case off and
    // every authored case attaches to the wrong test.
    detailWithSlugMatch.summary!.passedNames = ['test-case-ran-and-failed', 'test-case-passed-by-name']
    const html = await createEvaluationHtml(detailWithSlugMatch, {
      rewrite: {
        summary: 'Stale.',
        cases: [
          { title: 'Legacy one', whatWasChecked: 'a', whyItMatters: 'b', confidence: 'c' },
          { title: 'Legacy two', whatWasChecked: 'd', whyItMatters: 'e', confidence: 'f' },
          { title: 'Legacy three', whatWasChecked: 'g', whyItMatters: 'h', confidence: 'i' },
          { title: 'Legacy four', whatWasChecked: 'j', whyItMatters: 'k', confidence: 'l' },
        ],
      },
    })

    expect(html).toContain('<span class="case-title">Legacy one</span>')
    expect(html).toContain('<span class="case-title">Legacy four</span>')
  })

  it('leaves a rewrite alone when it matches neither the roster nor the executed set', async () => {
    const html = await createEvaluationHtml(rosterDetail(), {
      rewrite: { summary: 'Mismatched.', cases: [{ title: 'Only one', whatWasChecked: 'x', whyItMatters: 'y', confidence: 'z' }] },
    })

    // Unmappable → deterministic wording rather than a guessed alignment.
    expect(html).not.toContain('Only one')
    expect(html).toContain('Checkout was evaluated with 12 scenarios.')
  })

  it('widens a rewrite that carries no feature title', async () => {
    const html = await createEvaluationHtml(rosterDetail(), {
      rewrite: {
        summary: 'Stale summary.',
        cases: [
          { title: 'First', whatWasChecked: 'a', whyItMatters: 'b', confidence: 'c' },
          { title: 'Second', whatWasChecked: 'd', whyItMatters: 'e', confidence: 'f' },
          { title: 'Third', whatWasChecked: 'g', whyItMatters: 'h', confidence: 'i' },
          { title: 'Fourth', whatWasChecked: 'j', whyItMatters: 'k', confidence: 'l' },
          { title: 'Fifth', whatWasChecked: 'm', whyItMatters: 'n', confidence: 'o' },
        ],
      },
    })

    expect(html).toContain('<h1>Checkout</h1>')
    expect(html).toContain('<span class="case-title">First</span>')
    expect(html).toContain('Checkout was evaluated with 12 scenarios.')
  })

  it('ignores a rewrite that is not shaped like one', async () => {
    const html = await createEvaluationHtml(rosterDetail(), {
      rewrite: { summary: 'No cases array.' } as never,
    })

    expect(html).toContain('Checkout was evaluated with 12 scenarios.')
  })
})

describe('status buckets', () => {
  it('places every recorded status in exactly one bucket', () => {
    expect(statusBucket('passed')).toBe('passed')
    expect(statusBucket('skipped')).toBe('skipped')
    expect(statusBucket(NOT_RUN_STATUS)).toBe('notRun')
    expect(statusBucket('interrupted')).toBe('interrupted')
    // Anything else Playwright can report (failed, timedOut, …) counts as a
    // failure — never as a pass.
    expect(statusBucket('timedOut')).toBe('failed')
    expect(statusBucket('failed')).toBe('failed')
  })
})

describe('evaluation rewrite agent + highlight fallback (isolated module mocks)', () => {
  let spawnCalls: Array<{ command: string; args: string[]; child: FakeChild }>
  let availableAgents: string[]
  let idleHandlers: { onIdle?: (ms: number) => void; onTick?: (ms: number) => void }

  beforeEach(() => {
    vi.resetModules()
    spawnCalls = []
    availableAgents = []
    idleHandlers = {}
  })

  afterEach(() => {
    vi.doUnmock('shiki')
    vi.doUnmock('child_process')
    vi.doUnmock('../../runs/logic/runtime/auto-heal')
    vi.doUnmock('../../agent-sessions/logic/agent-binary')
    vi.doUnmock('../../agent-sessions/logic/agent-idle-timer')
    vi.resetModules()
    vi.restoreAllMocks()
  })

  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdinText = ''
    stdin = { end: (text = '') => { this.stdinText += text } }
    killed: string[] = []

    kill(signal: string): void { this.killed.push(signal) }

    close(code: number | null, signal: string | null = null): void { this.emit('close', code, signal) }
  }

  function mockAgentModules(onSpawn?: (ctx: { command: string; args: string[]; child: FakeChild }) => void): void {
    vi.doMock('../../runs/logic/runtime/auto-heal', () => ({
      pickAvailableHealAgent: (preferred?: string) => {
        if (preferred === 'claude' || preferred === 'codex') return availableAgents.includes(preferred) ? preferred : null
        return availableAgents[0] ?? null
      },
    }))
    // Prevent path resolution so spawn receives bare agent names.
    vi.doMock('../../agent-sessions/logic/agent-binary', () => ({
      resolveAgentBinary: (agent: string) => agent,
      isAgentKind: (cmd: string) => cmd === 'claude' || cmd === 'codex',
    }))
    // Capture the idle callbacks the spawn primitive wires up so the test can
    // drive idle-timeout and progress-tick behavior deterministically.
    vi.doMock('../../agent-sessions/logic/agent-idle-timer', () => ({
      startIdleTimer: (opts: { onIdle?: (ms: number) => void; onTick?: (ms: number) => void }) => {
        idleHandlers = { onIdle: opts.onIdle, onTick: opts.onTick }
        return { bump() {}, stop() {} }
      },
    }))
    vi.doMock('child_process', () => ({
      spawn: (command: string, args: string[]) => {
        const child = new FakeChild()
        spawnCalls.push({ command, args, child })
        setTimeout(() => onSpawn?.({ command, args, child }), 0)
        return child
      },
    }))
  }

  const rewriteJson = JSON.stringify({
    summary: 's',
    cases: [{ title: 't', whatWasChecked: 'w', whyItMatters: 'm', confidence: 'c' }],
  })

  it('surfaces the pinned claude session ref to onSession', async () => {
    availableAgents = ['claude']
    const sessions: Array<{ agent: string; sessionId: string }> = []
    mockAgentModules(({ child }) => {
      child.stdout.emit('data', `${JSON.stringify({ type: 'result', result: rewriteJson })}\n`)
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir, { onSession: (s) => sessions.push(s) })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].agent).toBe('claude')
    expect(sessions[0].sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('surfaces an empty codex session ref to onSession', async () => {
    availableAgents = ['codex']
    const sessions: Array<{ agent: string; sessionId: string }> = []
    mockAgentModules(({ args, child }) => {
      const outputPath = args[args.indexOf('--output-last-message') + 1]
      fs.writeFileSync(outputPath, JSON.stringify({ slots: [{ id: 'summary', text: 'localized' }] }))
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'codex', tmpDir, { onSession: (s) => sessions.push(s) })

    expect(sessions[0]).toEqual({ agent: 'codex', sessionId: '' })
  })

  it('rejects and kills the child when the evaluation agent goes idle', async () => {
    availableAgents = ['claude']
    mockAgentModules(({ child }) => {
      idleHandlers.onIdle?.(300000)
      child.close(null, 'SIGTERM')
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir))
      .rejects.toThrow(/idle for \d+ms/)
    expect(spawnCalls[0].child.killed).toContain('SIGTERM')
  })

  it('emits a progress note once the idle window passes the threshold', async () => {
    availableAgents = ['codex']
    const onOutput = vi.fn()
    mockAgentModules(({ args, child }) => {
      idleHandlers.onTick?.(4000)   // below threshold → no note
      idleHandlers.onTick?.(15000)  // above threshold → progress note
      const outputPath = args[args.indexOf('--output-last-message') + 1]
      fs.writeFileSync(outputPath, JSON.stringify({ slots: [{ id: 'summary', text: 'localized' }] }))
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'codex', tmpDir, { onOutput })

    const notes = onOutput.mock.calls
      .map((call) => call[0])
      .filter((text): text is string => typeof text === 'string' && text.includes('still running'))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('15s idle')
  })

  it('ignores a successful close that arrives after an abort', async () => {
    availableAgents = ['claude']
    const controller = new AbortController()
    mockAgentModules(({ child }) => {
      controller.abort()
      child.stdout.emit('data', `${JSON.stringify({ type: 'result', result: rewriteJson })}\n`)
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir, { signal: controller.signal }))
      .rejects.toThrow('evaluation rewrite cancelled')
  })

  it('ignores a failing close that arrives after an abort', async () => {
    availableAgents = ['claude']
    const controller = new AbortController()
    mockAgentModules(({ child }) => {
      controller.abort()
      child.stderr.emit('data', 'boom')
      child.close(2)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir, { signal: controller.signal }))
      .rejects.toThrow('evaluation rewrite cancelled')
  })

  it('wraps a process-error rejection from the agent runner', async () => {
    availableAgents = ['claude']
    mockAgentModules(({ child }) => {
      child.emit('error', new Error('spawn failed to launch'))
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir))
      .rejects.toThrow('evaluation rewrite agent failed: spawn failed to launch')
  })

  it('falls back to a plain code block when syntax highlighting throws', async () => {
    vi.doMock('shiki', () => ({ codeToHtml: () => { throw new Error('highlighter unavailable') } }))
    const featureDir = path.join(tmpDir, 'shiki-fallback')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'fallback.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('fallback highlight', async ({ page }) => {
  await expect(page.getByText('Ready')).toBeVisible()
})
`
    fs.writeFileSync(spec, specSource)
    const { createEvaluationHtml: createHtml } = await import('./test-review-export')
    const html = await createHtml(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('fallback highlight'")}`,
      title: 'fallback highlight',
    }))

    expect(html).toContain('fallback-code')
    expect(html).not.toContain('class="shiki"')
  })
})

function detail(opts: {
  featureDir: string
  feature?: string
  eventLocation?: string
  title?: string
  durationMs?: number
  passedNames?: string[]
}): RunDetail {
  const title = opts.title ?? 'passes checkout'
  return {
    runId: 'run-1',
    manifest: {
      runId: 'run-1',
      feature: opts.feature ?? 'checkout',
      featureDir: opts.featureDir,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:05.000Z',
      status: 'passed',
      healCycles: 0,
      services: [],
    },
    summary: { complete: true, total: 1, passed: 1, passedNames: opts.passedNames ?? [slugFromTitle(title)], failed: [] },
    playbackEvents: [
      {
        type: 'test-end',
        time: '2026-01-01T00:00:05.000Z',
        test: {
          name: slugFromTitle(title),
          title,
          location: opts.eventLocation ?? path.join(opts.featureDir, 'missing.spec.ts:1'),
        },
        status: 'passed',
        passed: true,
        durationMs: opts.durationMs ?? 5000,
        retry: 0,
      },
    ],
  }
}

// `detail()` always sets a `test-end` playback event, but `RunDetail.playbackEvents`
// is optional and `PlaywrightPlaybackEvent` is a discriminated union — fixtures that
// read/mutate `.status`/`.passed`/`.durationMs`/`.test.location` (fields only present
// on the `test-end` variant) need the array + element narrowed at the call site.
function testEndEvent(detail: RunDetail, index = 0): Extract<PlaywrightPlaybackEvent, { type: 'test-end' }> {
  const event = detail.playbackEvents?.[index]
  if (!event) throw new Error(`expected detail.playbackEvents[${index}] to be set`)
  if (event.type !== 'test-end') throw new Error(`expected a test-end event at index ${index}, got "${event.type}"`)
  return event
}

function lineOf(source: string, needle: string): number {
  const idx = source.indexOf(needle)
  expect(idx).toBeGreaterThanOrEqual(0)
  return source.slice(0, idx).split('\n').length
}

function slugFromTitle(title: string): string {
  return `test-case-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}
