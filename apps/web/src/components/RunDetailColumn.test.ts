import { describe, expect, it } from 'vitest'
import { assertionFilename, assertionHref, isAssertionExportable, shouldShowRestartHealButton } from './RunDetailColumn'

describe('shouldShowRestartHealButton', () => {
  // The button only appears after the heal-agent REPL has stopped. While the
  // agent is healing, the user types directly into the xterm pane — no
  // button needed. While the run is back to `running` (post-signal Playwright
  // rerun), the orchestrator is mid-cycle and a restart isn't meaningful.
  it('is hidden while the REPL is alive (healing)', () => {
    expect(shouldShowRestartHealButton('healing', 'auto')).toBe(false)
    expect(shouldShowRestartHealButton('healing', undefined)).toBe(false)
  })

  it('is hidden during the post-heal Playwright rerun', () => {
    expect(shouldShowRestartHealButton('running', 'auto')).toBe(false)
  })

  it('is shown only after a failed auto-heal run — REPL has been cleaned up', () => {
    expect(shouldShowRestartHealButton('failed', 'auto')).toBe(true)
    // Without auto-heal configured, restart isn't an option (no agent CLI).
    expect(shouldShowRestartHealButton('failed', undefined)).toBe(false)
  })

  it('is hidden for manual heal mode (no agent CLI to restart)', () => {
    expect(shouldShowRestartHealButton('healing', 'manual')).toBe(false)
    expect(shouldShowRestartHealButton('failed', 'manual')).toBe(false)
  })
})

describe('assertion export helpers', () => {
  it('is only available after a run reaches terminal state', () => {
    expect(isAssertionExportable('passed')).toBe(true)
    expect(isAssertionExportable('failed')).toBe(true)
    expect(isAssertionExportable('aborted')).toBe(true)
    expect(isAssertionExportable('running')).toBe(false)
    expect(isAssertionExportable('healing')).toBe(false)
  })

  it('builds a zip download filename from feature and run id', () => {
    expect(assertionFilename('shop redeeming', '2026:05:06 run')).toBe(
      'canary-lab-assertion-shop-redeeming-2026-05-06-run.zip',
    )
    expect(assertionHref('2026:05:06 run')).toBe('/api/runs/2026%3A05%3A06%20run/assertion.html')
  })
})
