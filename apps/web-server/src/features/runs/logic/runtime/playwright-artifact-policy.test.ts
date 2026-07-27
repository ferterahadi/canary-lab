import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  PLAYWRIGHT_RETAINED_ARTIFACT_MODES,
  PLAYWRIGHT_SCREENSHOT_MODES,
} from '../../../../../../../shared/configs/playwright-modes'
import {
  DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY,
  artifactPolicyFromConfig,
  readPlaywrightArtifactPolicy,
} from './playwright-artifact-policy'

describe('artifactPolicyFromConfig', () => {
  it('uses base defaults when config does not specify use artifacts', () => {
    expect(artifactPolicyFromConfig({})).toEqual(DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY)
    expect(artifactPolicyFromConfig(null)).toEqual(DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY)
    expect(artifactPolicyFromConfig([])).toEqual(DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY)
    expect(artifactPolicyFromConfig({ use: [] })).toEqual(DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY)
  })

  it('extracts explicit Playwright artifact modes', () => {
    expect(artifactPolicyFromConfig({
      use: {
        screenshot: 'on',
        video: 'on-first-retry',
        trace: 'on',
      },
    })).toEqual({
      screenshot: 'on',
      video: 'on-first-retry',
      trace: 'on',
    })
  })

  // The defect these pin: the reader's own mode lists had drifted behind
  // Playwright's `TraceMode` / `VideoMode` / `ScreenshotMode` unions, so a
  // feature config using a perfectly valid mode was silently rewritten to the
  // default — and the run manifest then reported a retention policy the run
  // never used. Walking the shared lists keeps the reader and the declared
  // modes from drifting apart again.
  it('round-trips every mode Playwright accepts, with no silent downgrade', () => {
    for (const mode of PLAYWRIGHT_RETAINED_ARTIFACT_MODES) {
      expect(artifactPolicyFromConfig({ use: { video: mode, trace: mode } })).toMatchObject({
        video: mode,
        trace: mode,
      })
    }
    for (const mode of PLAYWRIGHT_SCREENSHOT_MODES) {
      expect(artifactPolicyFromConfig({ use: { screenshot: mode } })).toMatchObject({
        screenshot: mode,
      })
    }
  })

  it('keeps the modes that used to be silently downgraded to the default', () => {
    expect(artifactPolicyFromConfig({
      use: {
        screenshot: 'on-first-failure',
        video: 'retain-on-failure-and-retries',
        trace: 'on-all-retries',
      },
    })).toEqual({
      screenshot: 'on-first-failure',
      video: 'retain-on-failure-and-retries',
      trace: 'on-all-retries',
    })
  })

  it('falls back per field for unsupported or complex values', () => {
    expect(artifactPolicyFromConfig({
      use: {
        screenshot: 'retain-on-failure',
        video: { $expr: 'process.env.CI ? "on" : "off"' },
        trace: 'off',
      },
    })).toEqual({
      screenshot: 'only-on-failure',
      video: 'off',
      trace: 'off',
    })
  })
})

describe('readPlaywrightArtifactPolicy', () => {
  it('uses defaults when no Playwright config exists or parsing fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pw-policy-'))
    expect(readPlaywrightArtifactPolicy(dir)).toEqual(DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY)
    fs.writeFileSync(path.join(dir, 'playwright.config.js'), 'export default defineConfig({ use: ')
    expect(readPlaywrightArtifactPolicy(dir)).toEqual(DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads the policy from playwright.config.ts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pw-policy-'))
    fs.writeFileSync(
      path.join(dir, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test'
export default defineConfig({ use: { screenshot: 'off', video: 'retain-on-failure', trace: 'on-first-retry' } })
`,
    )

    expect(readPlaywrightArtifactPolicy(dir)).toEqual({
      screenshot: 'off',
      video: 'retain-on-failure',
      trace: 'on-first-retry',
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
