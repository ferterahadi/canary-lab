import { defineConfig } from '@playwright/test'
import { baseConfig } from '../../shared/configs/playwright.base'

export default defineConfig({
  ...baseConfig,
})
