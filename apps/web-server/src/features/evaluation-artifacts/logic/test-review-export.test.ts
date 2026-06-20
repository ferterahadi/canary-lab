import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { __testReviewExportInternals, buildEvaluationLlmPrompt, buildTestReviewPacket, createAssertionExport, createAssertionHtml, createEvaluationExport, createEvaluationHtml, evaluationCodexArgs } from './test-review-export'
import type { RunDetail } from '../../orchestration/logic/run-store'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('test review export', () => {
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

    expect(body).toContain('<p class="eyebrow">Test Results</p>')
    expect(body).toContain('<h1 id="evaluation-report">Checkout</h1>')
    expect(body).toContain('Test Cases')
    expect(body).not.toContain('Evaluation Summary')
    expect(body).not.toContain('Product Evaluation')
    expect(body).not.toContain('Engineering Evidence')
    expect(body).toContain('<div class="summary-strip">')
    expect(body).toContain('<nav class="toc" aria-label="Table of contents">')
    expect(body).toContain('<a href="#evaluation-report" data-section-id="evaluation-report" aria-current="true">Checkout</a>')
    expect(body).toContain('<a href="#test-cases" data-section-id="test-cases">Test Cases</a>')
    expect(body).toContain('<section class="test-case" id="1-passes-checkout">')
    expect(body).toContain('<li class="toc-level-2"><a href="#test-cases" data-section-id="test-cases">Test Cases</a></li>')
    expect(body).toContain('<li class="toc-level-3"><a href="#1-passes-checkout" data-section-id="1-passes-checkout">1. Passes checkout</a></li>')
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

    expect(body).toContain('<h1 id="evaluation-report">Shop Redeeming Eats Voucher</h1>')
    expect(body).toContain('<a href="#evaluation-report" data-section-id="evaluation-report" aria-current="true">Shop Redeeming Eats Voucher</a>')
  })

  it('creates external flowchart svg assets for each test case', async () => {
    const exported = await createEvaluationExport(detail({ featureDir: tmpDir }))

    expect(exported.assets).toEqual([])
    const svg = exported.html
    expect(svg).toContain('<svg class="flowchart" xmlns="http://www.w3.org/2000/svg" width="1280" height="186"')
    expect(svg).toContain('class="flow-node"')
    expect(svg).toContain('class="connector"')
    expect(svg).toContain('filter="url(#nodeShadow)"')
    expect(svg).toContain('text-anchor="middle"')
    expect(svg).not.toContain('text-anchor="end" font-size="10"')
    expect(svg).toContain('font-family:ui-sans-serif')
    expect(svg).toContain('stroke="#64748b"')
    expect(svg).toContain('stroke="#16a34a"')
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
        detail({ featureDir, eventLocation: `${spec}:${first}`, title: 'same title' }).playbackEvents[0],
        detail({ featureDir, eventLocation: `${spec}:${second}`, title: 'same title' }).playbackEvents[0],
      ],
    })

    expect(body).toContain('<section class="test-case" id="1-same-title">')
    expect(body).toContain('<section class="test-case" id="2-same-title">')
    expect(body).toContain('<a href="#1-same-title" data-section-id="1-same-title">1. Same title</a>')
    expect(body).toContain('<a href="#2-same-title" data-section-id="2-same-title">2. Same title</a>')
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
    failed.playbackEvents[0].status = 'failed'
    failed.playbackEvents[0].passed = false
    failed.playbackEvents[0].durationMs = undefined
    failed.playbackEvents[0].test.location = 'unparseable-location'
    failed.manifest.endedAt = undefined

    const packet = buildTestReviewPacket(failed)

    expect(packet).toEqual(expect.objectContaining({
      total: 1,
      passed: 0,
      failed: 1,
    }))
    expect(packet.endedAt).toBeUndefined()
    expect(packet.tests[0].assertions).toEqual([
      expect.objectContaining({
        label: 'unknown',
        rationale: 'No static assertion detected in the matched test body.',
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
      expect.objectContaining({ label: 'toBeTruthy', quality: 'unknown' }),
      expect.objectContaining({ helperName: 'expectReadyAlias', quality: 'strict' }),
    ]))
    expect(html).toContain('<summary>Test code</summary>')
    expect(html).toContain('<h3>How the test runs</h3>')
    expect(html).toContain('Evaluation flow for Renders checkout review')
    expect(html).not.toContain('<h3>Helper Calls</h3>')
    expect(html).toContain('Helper functions used')
    expect(html).toContain('<a href="#local-codebase-implementations" data-section-id="local-codebase-implementations">Helper functions used</a>')
    expect(html).toContain('helper: <code>expectReadyAlias</code>')
    expect(html).toContain('nested strong:')
    expect(html).not.toContain('<h3>External Imports</h3>')
    expect(html).not.toContain('<h3>expectCheckoutReady</h3>')
    expect(html).toContain('@playwright/test')
    expect(html).toContain('expectCheckoutReady')
    expect(html).toContain('localDefault')
    expect(html).toContain('passed</span> <span class="muted">(250ms)</span>')
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
          detail({ featureDir, eventLocation: `${spec}:${firstLine}`, title: 'static template title' }).playbackEvents[0],
          detail({ featureDir, eventLocation: `${spec}:${secondLine}`, title: 'second shared helper' }).playbackEvents[0],
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
        quality: 'strict',
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

    expect(html).toContain('<h1 id="evaluation-report">Message Chain</h1>')
    expect(html).toContain('1. Wa metadata url then sms')
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
    failed.playbackEvents![0].status = 'failed'
    failed.playbackEvents![0].passed = false
    failed.playbackEvents![0].durationMs = undefined

    const exported = await createAssertionExport(failed)
    const html = exported.html
    const svg = exported.html

    expect(exported.assets).toEqual([])
    expect(html).toContain('status-failed')
    expect(html).not.toContain('<span class="muted">(')
    expect(svg).toContain('stroke="#e11d48"')
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
    expect(html).toContain('Confidence: 4 strong, 4 not graded')
    expect(html).toContain('Helper implementation could not be resolved statically')
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
    failed.summary = { complete: true, total: 1, passed: 0, failed: [{ name: 'test-case-fails-checkout', error: 'boom' }] }
    failed.playbackEvents![0].status = 'failed'
    failed.playbackEvents![0].passed = false
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
    expect(__testReviewExportInternals.audienceFlowDetail('2 nested assertions')).toBe('2 checks inside this shared step')
    expect(__testReviewExportInternals.audienceFlowDetail('1 nested assertion')).toBe('1 check inside this shared step')
    expect(__testReviewExportInternals.audienceFlowDetail('strict unknown nested assertion')).toBe('strong not graded included checks')
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

    expect(__testReviewExportInternals.confidenceForAssertions([{ kind: 'direct', label: 'x', quality: 'moderate', rationale: '', snippet: '' }])).toContain('moderate')
    expect(__testReviewExportInternals.confidenceForAssertions([{ kind: 'direct', label: 'x', quality: 'unknown', rationale: '', snippet: '' }])).toContain('Review the engineering evidence')
    expect(__testReviewExportInternals.qualityLabel('moderate')).toBe('moderate')
    expect(__testReviewExportInternals.qualitySummary([])).toBe('')
    expect(__testReviewExportInternals.qualitySummaryForAudience([{ kind: 'direct', label: 'x', quality: 'shallow', rationale: '', snippet: '' }])).toBe('1 shallow')
    expect(__testReviewExportInternals.rationaleForAudience('Static analysis could not confidently classify this assertion.')).toContain("couldn't auto-rate")
    expect(__testReviewExportInternals.rationaleForAudience('other')).toBe('other')

    expect(__testReviewExportInternals.resultColor('failed')).toMatchObject({ stroke: '#e11d48' })
    expect(__testReviewExportInternals.resultColor('aborted')).toMatchObject({ stroke: '#64748b' })
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

function lineOf(source: string, needle: string): number {
  const idx = source.indexOf(needle)
  expect(idx).toBeGreaterThanOrEqual(0)
  return source.slice(0, idx).split('\n').length
}

function slugFromTitle(title: string): string {
  return `test-case-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}
