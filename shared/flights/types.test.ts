import { describe, expect, it } from 'vitest'
import {
  ACTIVE_FLIGHT_STATUSES,
  deriveFeatureSlug,
  isActiveFlightStatus,
  isTerminalFlightStatus,
  FLIGHT_EXECUTION_ORDER,
  FLIGHT_STAGE_KEYS,
  STAGE_DEPENDS_ON,
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

describe('STAGE_DEPENDS_ON — the real dependency graph', () => {
  it('declares an entry for every stage key, so no stage is silently ungated', () => {
    for (const key of FLIGHT_STAGE_KEYS) {
      expect(STAGE_DEPENDS_ON[key], `missing entry for ${key}`).toBeDefined()
    }
    expect(Object.keys(STAGE_DEPENDS_ON).sort()).toEqual([...FLIGHT_STAGE_KEYS].sort())
  })

  it('never depends on a stage that runs later — a dependency must be producible first', () => {
    for (const key of FLIGHT_STAGE_KEYS) {
      for (const dep of STAGE_DEPENDS_ON[key]) {
        expect(
          FLIGHT_STAGE_KEYS.indexOf(dep),
          `${key} depends on ${dep}, which runs after it`,
        ).toBeLessThan(FLIGHT_STAGE_KEYS.indexOf(key))
      }
    }
  })

  it('is NOT the positional waterline — later stages skip artifacts they never read', () => {
    // The bug this map replaced: "everything to my left must exist". These three
    // stages must not inherit the requirements chain, or a suite with a green run
    // and no PRD can never re-enter them.
    expect(STAGE_DEPENDS_ON['portify']).not.toContain('prd-summary')
    expect(STAGE_DEPENDS_ON['portify']).not.toContain('specs-coverage')
    expect(STAGE_DEPENDS_ON['run']).not.toContain('prd-summary')
    expect(STAGE_DEPENDS_ON['evaluation-export']).toEqual(['run'])
    // Requirements collection boots nothing, so it needs no envset.
    expect(STAGE_DEPENDS_ON['docs']).toEqual(['scaffold'])
    expect(STAGE_DEPENDS_ON['prd-summary']).toEqual(['scaffold'])
    // What IS genuine stays: coverage maps specs onto requirements.
    expect(STAGE_DEPENDS_ON['specs-coverage']).toContain('prd-summary')
    expect(STAGE_DEPENDS_ON['run']).toContain('specs-coverage')
  })
})

describe('FLIGHT_EXECUTION_ORDER', () => {
  it('publishes the Report before independent Parallel setup', () => {
    expect(FLIGHT_EXECUTION_ORDER.indexOf('evaluation-export'))
      .toBeLessThan(FLIGHT_EXECUTION_ORDER.indexOf('portify'))
  })
})
