import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
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
