import { describe, expect, it } from 'vitest'
import { assertionFilename, assertionHref, canRestartHeal, isAssertionExportable } from './RunDetailColumn'

describe('canRestartHeal', () => {
  it('is enabled only for terminal runs that can be restarted', () => {
    expect(canRestartHeal('failed')).toBe(true)
    expect(canRestartHeal('aborted')).toBe(true)
    expect(canRestartHeal('running')).toBe(false)
    expect(canRestartHeal('healing')).toBe(false)
    expect(canRestartHeal('passed')).toBe(false)
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
