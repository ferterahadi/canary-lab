import { describe, expect, it } from 'vitest'
import {
  ACTIVE_FLIGHT_STATUSES,
  deriveFeatureSlug,
  isActiveFlightStatus,
  isTerminalFlightStatus,
} from './types'

describe('deriveFeatureSlug', () => {
  it('slugifies the final path segment', () => {
    expect(deriveFeatureSlug('/Users/dev/Documents/My Repo')).toBe('my-repo')
    expect(deriveFeatureSlug('/srv/checkout_api.v2')).toBe('checkout-api-v2')
  })

  it('ignores trailing separators and handles Windows paths', () => {
    expect(deriveFeatureSlug('/Users/dev/todo-api/')).toBe('todo-api')
    expect(deriveFeatureSlug('/Users/dev/todo-api///')).toBe('todo-api')
    expect(deriveFeatureSlug('C:\\Users\\dev\\Todo API')).toBe('todo-api')
  })

  it('falls back to "feature" when the path yields no slug characters', () => {
    // The four surfaces that derive names (CLI, MCP start_flight, the
    // new-flight dialog, the conductor) must agree even on degenerate input —
    // an empty slug would create an unaddressable feature directory.
    expect(deriveFeatureSlug('')).toBe('feature')
    expect(deriveFeatureSlug('/')).toBe('feature')
    expect(deriveFeatureSlug('/srv/___')).toBe('feature')
  })
})

describe('flight status predicates', () => {
  it('treats only lock-holding statuses as active', () => {
    for (const status of ACTIVE_FLIGHT_STATUSES) expect(isActiveFlightStatus(status)).toBe(true)
    expect(isActiveFlightStatus('paused')).toBe(false)
    expect(isActiveFlightStatus('done')).toBe(false)
  })

  it('treats settled statuses as terminal, and paused as neither', () => {
    expect(isTerminalFlightStatus('done')).toBe(true)
    expect(isTerminalFlightStatus('failed')).toBe(true)
    expect(isTerminalFlightStatus('aborted')).toBe(true)
    // Paused is resumable, so it is neither active nor terminal — a flight
    // parked mid-stage still owns its work and must not be swept up as done.
    expect(isTerminalFlightStatus('paused')).toBe(false)
    expect(isActiveFlightStatus('paused')).toBe(false)
  })
})
