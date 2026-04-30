import { test as base } from '@playwright/test'
import fs from 'fs'
import { MANIFEST_PATH } from './paths'

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

  const manifest: { serviceLogs: string[] } = JSON.parse(
    fs.readFileSync(manifestPath, 'utf-8'),
  )
  const slug = slugify(title)
  const openTag = `<test-case-${slug}>\n`
  const closeTag = `</test-case-${slug}>\n`

  for (const logPath of manifest.serviceLogs) {
    fs.appendFileSync(logPath, openTag)
  }

  await run()

  for (const logPath of manifest.serviceLogs) {
    fs.appendFileSync(logPath, closeTag)
  }
}

/**
 * Extended Playwright `test` that writes XML markers into every service log
 * listed in logs/manifest.json. If the manifest doesn't exist because tests
 * are run directly with Playwright instead of `canary-lab run`, the fixture
 * is a no-op.
 * https://playwright.dev/docs/extensibility
 */
export const test = base.extend<{ _logMarker: void }>({
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
