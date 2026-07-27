import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { buildTestReviewPacket, createAssertionExport, createAssertionHtml, createEvaluationHtml } from './test-review-export'
import { coverageLedgerFor, detail, lineOf, testEndEvent } from './__fixtures__/test-review-fixtures'

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

  it('title-cases feature slugs in the report chrome', async () => {
    const body = await createEvaluationHtml(detail({ featureDir: tmpDir, feature: 'shop_redeeming_eats_voucher' }))

    expect(body).toContain('<h1>Shop Redeeming Eats Voucher</h1>')
    expect(body).toContain('<title>Evaluation Report: Shop Redeeming Eats Voucher</title>')
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
})
