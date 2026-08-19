import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

export default defineConfig({
  ...baseConfig,
  workers: 1,
  use: {
    video: 'off',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
