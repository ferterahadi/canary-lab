import { test as base, type Page, type TestInfo } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { getProjectRoot } from '../runtime/project-root'

// Resolved at module load — same shape as the (now-moved) constant the
// web-server's runtime uses, just inlined here so this published fixture
// has no dependency on apps/web-server/. The published file ships to user
// templates via `canary-lab/feature-support/log-marker-fixture`.
const MANIFEST_PATH = process.env.CANARY_LAB_MANIFEST_PATH
  ?? path.join(getProjectRoot(), 'logs', 'manifest.json')

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function withLogMarkers(
  title: string,
  manifestPath: string,
  run: () => Promise<void>,
): Promise<void> {
  if (!fs.existsSync(manifestPath)) {
    await run()
    return
  }

  const manifest: { serviceLogs?: string[]; services?: Array<{ logPath?: string }> } = JSON.parse(
    fs.readFileSync(manifestPath, 'utf-8'),
  )
  const serviceLogs = [
    ...(Array.isArray(manifest.serviceLogs) ? manifest.serviceLogs : []),
    ...(Array.isArray(manifest.services)
      ? manifest.services
          .map((s) => s.logPath)
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []),
  ]
  const slug = slugify(title)
  const openTag = `<test-case-${slug}>\n`
  const closeTag = `</test-case-${slug}>\n`

  for (const logPath of serviceLogs) {
    fs.appendFileSync(logPath, openTag)
  }

  await run()

  for (const logPath of serviceLogs) {
    fs.appendFileSync(logPath, closeTag)
  }
}

export function shouldCaptureFinalPageScreenshot(testInfo: Pick<TestInfo, 'project' | 'status' | 'expectedStatus'>): boolean {
  const mode = (testInfo.project.use as { screenshot?: unknown }).screenshot
  if (mode === 'off') return false
  if (mode === 'only-on-failure') return testInfo.status !== testInfo.expectedStatus
  return mode === 'on'
}

export async function captureFinalPageScreenshot(page: Page, testInfo: TestInfo): Promise<void> {
  if (!shouldCaptureFinalPageScreenshot(testInfo)) return
  const filename = `canary-lab-final-page-${slugify(testInfo.title)}.png`
  const screenshotPath = testInfo.outputPath(filename)
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true })
    await testInfo.attach('canary-lab-final-page', {
      path: screenshotPath,
      contentType: 'image/png',
    })
  } catch {
    // Best-effort visual aid only. The raw Playwright terminal remains the
    // source of truth if the page has already closed or crashed.
  }
}

// Methods on Page (and Locator) that return another locator-like object.
// Their return values are re-wrapped so chained calls
// (`page.locator('x').click()`) carry the original call site through.
const LOCATOR_RETURNING = new Set([
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
  'frameLocator',
  'first',
  'last',
  'nth',
  'filter',
  'and',
  'or',
  'contentFrame',
  'frame',
])

export interface CallSiteFrame { file: string; line: number; column: number }

/** How `wrapWithCallSite` reports a located step. Passed in rather than reached
 *  for, because `test.step` only works inside a running Playwright worker —
 *  that runner context is the one edge a unit test cannot reproduce, so it is
 *  the only thing the tests substitute. */
export type CallSiteStep = (
  title: string,
  body: () => unknown,
  options: { location: CallSiteFrame },
) => unknown

function captureFrame(testFile: string): CallSiteFrame | null {
  // V8 always populates `stack`. Coercing rather than defaulting keeps the
  // undefined case handled (it splits to a single unmatchable line, so the
  // walk returns null) without leaving a fallback branch nothing can take.
  const stack = String(new Error().stack)
  for (const raw of stack.split('\n').slice(1)) {
    const m = raw.match(/\(([^()]+):(\d+):(\d+)\)/) ?? raw.match(/at\s+([^\s:]+):(\d+):(\d+)/)
    if (m && m[1] === testFile) {
      return { file: m[1], line: Number(m[2]), column: Number(m[3]) }
    }
  }
  return null
}

function isThenable(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function'
}

// Wrap a Page or Locator with a Proxy that, on every async method invocation,
// captures the first stack frame inside `testFile` and emits a `test.step` at
// that location. Playwright then sees the pw:api step it would already emit
// as a *child* of our step, so walking `step.parent` in the summary reporter
// surfaces the call site in the user's spec.
export function wrapWithCallSite<T extends object>(
  target: T,
  testFile: string,
  step: CallSiteStep,
  inheritedFrame?: CallSiteFrame,
): T {
  return new Proxy(target, {
    get(obj, prop, recv) {
      const value = Reflect.get(obj, prop, recv)
      if (typeof value !== 'function' || typeof prop === 'symbol') return value
      const methodName = prop
      return new Proxy(value as (...args: unknown[]) => unknown, {
        apply(fn, _thisArg, args) {
          const frame = inheritedFrame ?? captureFrame(testFile)
          const result = Reflect.apply(fn, obj, args)
          if (
            LOCATOR_RETURNING.has(methodName) &&
            result &&
            typeof result === 'object' &&
            !isThenable(result)
          ) {
            return wrapWithCallSite(result as object, testFile, step, frame ?? inheritedFrame)
          }
          if (frame && isThenable(result)) {
            return step(`page.${methodName}`, () => result, { location: frame })
          }
          return result
        },
      })
    },
  })
}

/**
 * Extended Playwright `test` that writes XML markers into every service log
 * listed in the active run manifest. If the manifest doesn't exist because tests
 * are run directly with Playwright instead of the Canary Lab UI, the fixture
 * is a no-op.
 *
 * The `page` fixture is also wrapped with a call-site-capturing Proxy so the
 * summary reporter's running-step `locations` chain reaches back into the
 * test body even when user helpers aren't wrapped in `test.step(...)`. This
 * is what powers per-line "currently executing" highlighting in the UI.
 *
 * https://playwright.dev/docs/extensibility
 */
/** The `page` fixture body, named so it can be driven directly with fakes.
 *  Hands the test a call-site-wrapping proxy, then screenshots the REAL page
 *  (not the proxy) once the test body has finished with it. */
export async function pageFixture(
  page: Page,
  use: (wrapped: Page) => Promise<void>,
  testInfo: TestInfo,
  step: CallSiteStep,
): Promise<void> {
  const wrapped = wrapWithCallSite(page, testInfo.file, step) as Page
  await use(wrapped)
  await captureFinalPageScreenshot(page, testInfo)
}

/** The auto `_logMarker` fixture body, named for the same reason. */
export async function logMarkerFixture(
  use: (value: never) => Promise<void>,
  testInfo: Pick<TestInfo, 'title'>,
  manifestPath: string = MANIFEST_PATH,
): Promise<void> {
  await withLogMarkers(testInfo.title, manifestPath, async () => {
    await use(undefined as never)
  })
}

/** Production step runner. Playwright's `test.step` only resolves inside a
 *  running worker, so this is the single line the unit tests substitute — they
 *  assert it delegates rather than trying to reproduce a worker. */
export const playwrightStep: CallSiteStep = (title, body, options) => test.step(title, body, options)

/** `base.extend` wiring, named rather than inline so the fixtures are ordinary
 *  callable functions in a unit test instead of values only Playwright can reach. */
export async function pageFixtureEntry(
  { page }: { page: Page },
  use: (wrapped: Page) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  await pageFixture(page, use, testInfo, playwrightStep)
}

export async function logMarkerFixtureEntry(
  _fixtures: unknown,
  use: (value: never) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  await logMarkerFixture(use, testInfo)
}

export const test = base.extend<{ _logMarker: void }>({
  page: pageFixtureEntry,
  _logMarker: [logMarkerFixtureEntry, { auto: true }],
})

export { expect, type APIRequestContext, type Page } from '@playwright/test'
