import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

// `use` repeats two of baseConfig's own values on purpose. Canary Lab reads this
// file with a parser, not by executing it, so a spread of an imported constant is
// invisible to Settings — spreading alone left the Suite setup panel showing no
// Video/Trace row at all and reporting "screenshot: off" while runs were really
// capturing on failure. Spelling them out is what makes the panel say what the
// suite does.
//
// `retries` is deliberately NOT restated. A key is spelled out here only when
// this suite depends on the value; retries is baseConfig's business, and naming
// it just to light one more row in the Settings panel would be padding the demo
// with a setting it doesn't actually make a choice about.
export default defineConfig({
  ...baseConfig,
  maxFailures: 1,
  workers: 1,
  use: {
    video: 'off',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
