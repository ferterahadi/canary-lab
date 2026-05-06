import { describe, expect, it } from 'vitest'
import { shouldShowAgentInputBar } from './RunDetailColumn'

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
