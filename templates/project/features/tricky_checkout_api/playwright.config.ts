import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

export default defineConfig({ ...baseConfig })
