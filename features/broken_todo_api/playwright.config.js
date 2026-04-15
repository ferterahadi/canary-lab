const { defineConfig } = require('@playwright/test')
const { baseConfig } = require('canary-lab/feature-support/playwright-base')

module.exports = defineConfig({
  ...baseConfig,
})
