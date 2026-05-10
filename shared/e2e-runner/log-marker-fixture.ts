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

/**
 * Extended Playwright `test` that writes XML markers into every service log
 * listed in the active run manifest. If the manifest doesn't exist because tests
 * are run directly with Playwright instead of the Canary Lab UI, the fixture
 * is a no-op.
 * https://playwright.dev/docs/extensibility
 */
export const test = base.extend<{ _logMarker: void }>({
  page: async ({ page }, use, testInfo) => {
    await use(page)
    await captureFinalPageScreenshot(page, testInfo)
  },
  _logMarker: [
    async ({}, use, testInfo) => {
      await withLogMarkers(testInfo.title, MANIFEST_PATH, async () => {
        await use(undefined as never)
      })
    },
    { auto: true },
  ],
})

export { expect, type APIRequestContext, type Page } from '@playwright/test'
