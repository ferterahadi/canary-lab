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
  // Restated to match `healOnFailureThreshold: 4` in feature.config.cjs, which is
  // what actually caps failures — it arrives as `--max-failures=4` and overrides
  // this key. Spelling it out keeps the Suite setup panel, which parses this file,
  // from reporting a cap the run does not use.
  maxFailures: 4,
  // Four workers, but baseConfig leaves `fullyParallel: false` and the suite is a
  // single spec file — Playwright parallelizes per file at that setting, so the
  // seven journeys still execute serially in declaration order. This is a ceiling
  // for when the suite grows a second spec file, not a change to how the demo runs
  // today. Turning on `fullyParallel` would race the journeys against one shared
  // set of three services, where J4 reprices a product and J5 deletes one.
  workers: 4,
  use: {
    video: 'off',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
