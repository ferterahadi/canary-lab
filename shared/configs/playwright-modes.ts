// The artifact modes Playwright accepts in `use.screenshot` / `use.video` /
// `use.trace`, kept in one place because six copies had drifted apart.
//
// These mirror Playwright's own `ScreenshotMode` / `TraceMode` / `VideoMode`
// unions (`playwright/types/test.d.ts`). Drift here is not cosmetic: the run
// manifest records the retention policy it read out of the feature's
// `playwright.config.ts`, so a mode missing from these lists gets silently
// rewritten to the default and the manifest then reports a retention policy
// the run did not use. The Config → Playwright dropdowns read the same lists,
// so a missing mode is also a mode the user cannot select.
//
// Trace and video accept the identical set; screenshot has its own.

export const PLAYWRIGHT_SCREENSHOT_MODES = [
  'off',
  'on',
  'only-on-failure',
  'on-first-failure',
] as const

export const PLAYWRIGHT_RETAINED_ARTIFACT_MODES = [
  'off',
  'on',
  'retain-on-failure',
  'on-first-retry',
  'on-all-retries',
  'retain-on-first-failure',
  'retain-on-failure-and-retries',
] as const

export type PlaywrightScreenshotMode = (typeof PLAYWRIGHT_SCREENSHOT_MODES)[number]

export type PlaywrightRetainedArtifactMode = (typeof PLAYWRIGHT_RETAINED_ARTIFACT_MODES)[number]

export interface PlaywrightArtifactPolicy {
  screenshot: PlaywrightScreenshotMode
  video: PlaywrightRetainedArtifactMode
  trace: PlaywrightRetainedArtifactMode
}
