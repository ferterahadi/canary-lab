import { describe, it, expect } from 'vitest'
import { classifyHealFailure } from './heal-failure-classifier'

describe('classifyHealFailure', () => {
  it('returns undefined for an empty / whitespace tail', () => {
    expect(classifyHealFailure('')).toBeUndefined()
    expect(classifyHealFailure('   \n\t  ')).toBeUndefined()
  })

  it('returns unknown when the tail matches no fingerprint', () => {
    expect(classifyHealFailure('Thinking about the failing test...')).toBe('unknown')
  })

  it('classifies codex usage-limit output', () => {
    expect(
      classifyHealFailure("You've hit your usage limit. Upgrade your plan to continue.", 'codex'),
    ).toBe('usage-limit')
    expect(classifyHealFailure('Error: weekly limit reached for this account')).toBe('usage-limit')
  })

  it('classifies claude credit-balance output as usage-limit', () => {
    expect(
      classifyHealFailure('Your credit balance is too low to access the API.', 'claude'),
    ).toBe('usage-limit')
  })

  it('classifies auth failures', () => {
    expect(classifyHealFailure('You are not logged in. Run `codex login`.', 'codex')).toBe('auth')
    expect(classifyHealFailure('HTTP 401 Unauthorized: invalid api key')).toBe('auth')
  })

  it('classifies rate-limit / overloaded output', () => {
    expect(classifyHealFailure('Error 429: too many requests, try again later')).toBe('rate-limit')
    expect(classifyHealFailure('The server is overloaded. Please retry.', 'claude')).toBe(
      'rate-limit',
    )
  })

  it('classifies a crash / spawn error', () => {
    expect(classifyHealFailure('codex: command not found')).toBe('crash')
    expect(classifyHealFailure('panic: runtime error: nil pointer dereference')).toBe('crash')
  })

  it('is case-insensitive and tolerates ANSI color codes', () => {
    expect(classifyHealFailure('\x1b[31mUSAGE LIMIT\x1b[0m exceeded')).toBe('usage-limit')
  })

  it('prefers the more specific cause when several could match', () => {
    // "usage limit" also contains "limit"; usage-limit must win over rate-limit.
    expect(classifyHealFailure('monthly usage limit — rate limit note below')).toBe('usage-limit')
  })
})
