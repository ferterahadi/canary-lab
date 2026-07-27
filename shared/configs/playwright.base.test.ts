import { describe, expect, it } from 'vitest'
import { baseConfig } from './playwright.base'

// `baseConfig` ships as the published `canary-lab/feature-support/playwright-base`
// export and every scaffolded feature spreads it, so its defaults are a semver
// contract rather than an internal preference. The serial settings in particular
// are load-bearing: Canary Lab attributes each playback event to one run and
// injects one port set per feature, both of which assume a single worker.
describe('baseConfig', () => {
  it('runs specs serially in a single worker', () => {
    expect(baseConfig.fullyParallel).toBe(false)
    expect(baseConfig.workers).toBe(1)
  })

  it('never retries, so a reported failure is a real failure', () => {
    // A retry would let a flaky test report as passed, which is exactly the
    // rounding-up the run-evidence rules forbid.
    expect(baseConfig.retries).toBe(0)
  })

  it('keeps failure artifacts and points at the scaffold test dir', () => {
    expect(baseConfig.testDir).toBe('./e2e')
    expect(baseConfig.use.trace).toBe('retain-on-failure')
    expect(baseConfig.use.screenshot).toBe('only-on-failure')
    expect(baseConfig.timeout).toBe(90_000)
  })
})
