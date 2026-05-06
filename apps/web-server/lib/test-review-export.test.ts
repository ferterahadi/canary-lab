import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildTestReviewPacket, createAssertionMarkdown } from './test-review-export'
import type { RunDetail } from './run-store'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('test review export', () => {
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

  it('creates deterministic assertion review markdown', () => {
    const body = createAssertionMarkdown(detail({ featureDir: tmpDir }))

    expect(body).toContain('# Assertion Review: checkout')
    expect(body).toContain('- Scope: local codebase helper implementations are inlined once below')
    expect(body).toContain('## Test Cases')
    expect(body).not.toContain('test-review.json')
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

  it('renders test bodies, helper calls, nested helper assertions, imports, and deduped helpers', () => {
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
    const markdown = createAssertionMarkdown(detail({
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
    expect(markdown).toContain('### Test Body')
    expect(markdown).toContain('### Helper Calls')
    expect(markdown).toContain('## Local Codebase Implementations')
    expect(markdown).toContain('helper: `expectReadyAlias`')
    expect(markdown).toContain('nested strict:')
    expect(markdown).toContain('External imports preserved from the original files:')
    expect(markdown).toContain('### expectCheckoutReady')
    expect(markdown.match(/### expectCheckoutReady/g)).toHaveLength(1)
    expect(markdown).toContain('- Result: passed (250ms)')
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
import { missingHelper } from './missing'
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

      expect(packet.tests[0].testBody).toBe('expectLocal(page)')
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

  it('covers side-effect imports, namespace imports, skipped suite calls, function callbacks, and shared helper rendering', () => {
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
import { missingDep } from './dep'

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
      const markdown = createAssertionMarkdown({
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
      expect(markdown.match(/### expectShared/g)).toHaveLength(1)
    } finally {
      readSpy.mockRestore()
    }
  })

  it('renders local helpers without an external import section', () => {
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

    const markdown = createAssertionMarkdown(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('local helper only'")}`,
      title: 'local helper only',
    }))

    expect(markdown).toContain('## Local Codebase Implementations')
    expect(markdown).toContain('### expectLocalOnly')
    expect(markdown).not.toContain('External imports preserved from the original files:')
  })
})

function detail(opts: {
  featureDir: string
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
      feature: 'checkout',
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
