import { describe, expect, it } from 'vitest'
import { displayError } from './error-message'
import { ApiError } from './internal'

describe('displayError', () => {
  it('prefers `reason` from a structured ApiError body', () => {
    expect(displayError(new ApiError(409, { reason: 'no-failures-yet' }))).toBe('no-failures-yet')
  })

  it('falls back to `error` when there is no `reason`', () => {
    expect(displayError(new ApiError(404, { error: 'run not found' }))).toBe('run not found')
  })

  it('skips a field that is not a non-empty string', () => {
    expect(displayError(new ApiError(422, { reason: 42, error: 'bad slot' }))).toBe('bad slot')
    expect(displayError(new ApiError(422, { reason: '', error: { code: 1 } }))).toBe('HTTP 422')
  })

  it('falls back to the ApiError message when the body has neither field', () => {
    expect(displayError(new ApiError(500, null))).toBe('HTTP 500')
    expect(displayError(new ApiError(500, { other: 1 }), 'Save failed')).toBe('HTTP 500')
  })

  it('translates network-failure TypeErrors to a user-readable message', () => {
    expect(displayError(new TypeError('Failed to fetch'))).toContain('Lost connection')
    expect(displayError(new TypeError('Load failed'))).toContain('Lost connection')
    expect(displayError(new TypeError('NetworkError when attempting to fetch resource'))).toContain('Lost connection')
  })

  it('keeps a non-network TypeError message as-is', () => {
    expect(displayError(new TypeError('x is not a function'))).toBe('x is not a function')
  })

  it('returns plain Error.message for generic errors, ignoring the fallback', () => {
    expect(displayError(new Error('something broke'))).toBe('something broke')
    expect(displayError(new Error('something broke'), 'Save failed')).toBe('something broke')
  })

  it('stringifies non-Error throws unless the caller names a fallback', () => {
    expect(displayError('plain string')).toBe('plain string')
    expect(displayError({ code: 1 }, 'Save failed')).toBe('Save failed')
  })
})
