import { describe, expect, it } from 'vitest'
import { assertionFilename, assertionHref, isAssertionExportable, shouldShowAgentInputBar } from './RunDetailColumn'

describe('shouldShowAgentInputBar', () => {
  it('is only shown while an auto heal agent is active', () => {
    expect(shouldShowAgentInputBar('healing', 'auto')).toBe(true)
    expect(shouldShowAgentInputBar('healing', undefined)).toBe(true)
  })

  it('is hidden once the signal handoff returns the run to running', () => {
    expect(shouldShowAgentInputBar('running', 'auto')).toBe(false)
  })

  it('is hidden for manual heal mode', () => {
    expect(shouldShowAgentInputBar('healing', 'manual')).toBe(false)
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
