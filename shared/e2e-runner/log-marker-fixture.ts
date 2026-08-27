import { test as base, type Page, type TestInfo } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { getProjectRoot } from '../runtime/project-root'

export { resolveRunRepoPath } from './repo-path-overrides'

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

// ─── Per-test network log (HAR) ─────────────────────────────────────────────
//
// Playwright records every request a test makes into a HAR file via
// `context.tracing.startHar()` (added in 1.60). Canary keeps it only for
// failures, matching the `trace: 'retain-on-failure'` stance already in the
// base config: a passing test's network log is noise, while a failing one often
// carries the actual root cause in a response body.
//
// Guarded at RUNTIME, not just by types. This file is published to feature
// repos, which resolve their own `@playwright/test` — a feature pinned below
// 1.60 has no `startHar`, and must keep running rather than fail every test on
// a missing method.

/** The slice of Playwright's `Tracing` this module needs, so a unit test can
 *  drive the fixture with a fake context instead of a real browser. */
export interface HarTracing {
  startHar(harPath: string): Promise<unknown>
  stopHar(): Promise<void>
}

export function supportsHar(tracing: unknown): tracing is HarTracing {
  return (
    !!tracing &&
    typeof (tracing as HarTracing).startHar === 'function' &&
    typeof (tracing as HarTracing).stopHar === 'function'
  )
}

/** Resolve the tracing object off a page's context, tolerating the fakes unit
 *  tests pass in (no `context()`, or a context with no tracing). */
export function harTracingFor(page: Pick<Page, 'context'>): HarTracing | null {
  let tracing: unknown
  try {
    tracing = page.context?.()?.tracing
  } catch {
    return null
  }
  return supportsHar(tracing) ? tracing : null
}

export async function startHarRecording(
  page: Pick<Page, 'context'>,
  testInfo: Pick<TestInfo, 'title' | 'outputPath'>,
): Promise<string | null> {
  const tracing = harTracingFor(page)
  if (!tracing) return null
  const harPath = testInfo.outputPath(`canary-lab-network-${slugify(testInfo.title)}.har`)
  try {
    await tracing.startHar(harPath)
    return harPath
  } catch {
    // Best-effort evidence. A run without a network log is still a valid run.
    return null
  }
}

/** Stop recording, then keep the HAR only if the test did not end as expected.
 *  Attaching (rather than leaving it on disk) is what lets the summary reporter
 *  find it without knowing the fixture's naming scheme. */
export async function stopHarRecording(
  page: Pick<Page, 'context'>,
  testInfo: Pick<TestInfo, 'status' | 'expectedStatus' | 'attach'>,
  harPath: string | null,
): Promise<void> {
  if (!harPath) return
  const tracing = harTracingFor(page)
  if (!tracing) return
  try {
    await tracing.stopHar()
  } catch {
    return
  }
  if (testInfo.status === testInfo.expectedStatus) {
    try { fs.rmSync(harPath, { force: true }) } catch { /* nothing to clean up */ }
    return
  }
  try {
    await testInfo.attach('canary-lab-network-har', {
      path: harPath,
      contentType: 'application/json',
    })
  } catch {
    // The file stays on disk either way; only the reporter pointer is lost.
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
// that location. Playwright starts its native pw:api step inside this proxy,
// then our overlapping located step becomes the reporter's latest active step
// for the lifetime of the returned promise. That gives the summary a trusted
// call site in the user's spec instead of the proxy's own line.
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
 * powers the UI's source-line highlight for the latest Playwright-reported
 * Page or Locator call. Code with no trustworthy spec call site stays at the
 * test-level running state instead of claiming an exact line.
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
  // HAR recording rides on the `page` fixture rather than its own auto fixture
  // on purpose: an auto fixture depending on `context` would force a browser
  // context onto API-only tests that never open a page.
  const harPath = await startHarRecording(page, testInfo)
  const wrapped = wrapWithCallSite(page, testInfo.file, step) as Page
  await use(wrapped)
  await captureFinalPageScreenshot(page, testInfo)
  await stopHarRecording(page, testInfo, harPath)
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

// The `{}` first parameter is required, not stylistic: Playwright parses every
// fixture function and rejects a plain identifier with "First argument must use
// the object destructuring pattern". That rejection is fatal at module load, so
// it takes down every spec importing this file, not just one test.
// Typed `object` rather than a narrower shape because Playwright hands the
// fixture the whole args bag; anything with an index signature (or `unknown`)
// fails to accept it.
export async function logMarkerFixtureEntry(
  {}: object,
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
