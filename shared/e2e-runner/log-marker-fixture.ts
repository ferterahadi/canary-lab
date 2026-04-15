import { test as base, expect } from '@playwright/test'
import fs from 'fs'
import { MANIFEST_PATH } from './paths'

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
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
      if (!fs.existsSync(MANIFEST_PATH)) {
        await use(undefined as never)
        return
      }

      const manifest: { serviceLogs: string[] } = JSON.parse(
        fs.readFileSync(MANIFEST_PATH, 'utf-8'),
      )
      const slug = slugify(testInfo.title)
      const openTag = `<test-case-${slug}>\n`
      const closeTag = `</test-case-${slug}>\n`

      for (const logPath of manifest.serviceLogs) {
        fs.appendFileSync(logPath, openTag)
      }

      await use(undefined as never)

      for (const logPath of manifest.serviceLogs) {
        fs.appendFileSync(logPath, closeTag)
      }
    },
    { auto: true },
  ],
})

export { expect }
export type { APIRequestContext, Page } from '@playwright/test'
