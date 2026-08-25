import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'
import { loadFeatureEnv } from 'canary-lab/feature-support/load-env'

// Port allocation writes WORKFLOW_URL into this feature's applied `.env`.
// Load it before the spec module reads the URL.
loadFeatureEnv(__dirname)

export default defineConfig({
  ...baseConfig,
  workers: 1,
  use: {
    video: 'off',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
