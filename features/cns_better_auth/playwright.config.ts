import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

loadDotenv({ path: path.join(__dirname, '.env') })

export default defineConfig({
  ...baseConfig,
  fullyParallel: true,
  workers: 4,
  use: {
    ...baseConfig.use,
    headless: true,
    video: 'on',
    trace: 'on',
    screenshot: 'on',
  },
})
