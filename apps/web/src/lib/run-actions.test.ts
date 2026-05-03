import { describe, it, expect } from 'vitest'
import { canCancelHeal, canDelete, canPauseHeal, canStop, deriveDisplayStatus } from './run-actions'

describe('canPauseHeal', () => {
  it('is true only when status is running', () => {
    expect(canPauseHeal('running')).toBe(true)
  })

  it.each([
    ['healing'],
    ['passed'],
    ['failed'],
    ['aborted'],
  ] as const)('is false when status is %s', (status) => {
    expect(canPauseHeal(status)).toBe(false)
  })
})

describe('canCancelHeal', () => {
  it('is true only while healing', () => {
    expect(canCancelHeal('healing')).toBe(true)
  })
  it.each([['running'], ['passed'], ['failed'], ['aborted']] as const)(
    'is false when status is %s',
    (s) => {
      expect(canCancelHeal(s)).toBe(false)
    },
  )
})

describe('canStop', () => {
  it.each([['running'], ['healing']] as const)('is true when status is %s', (s) => {
    expect(canStop(s)).toBe(true)
  })
  it.each([['passed'], ['failed'], ['aborted']] as const)('is false when status is %s', (s) => {
    expect(canStop(s)).toBe(false)
  })
})

describe('canDelete', () => {
  it.each([['passed'], ['failed'], ['aborted']] as const)('is true when status is %s (terminal)', (s) => {
    expect(canDelete(s)).toBe(true)
  })
  it.each([['running'], ['healing']] as const)('is false when status is %s (active)', (s) => {
    expect(canDelete(s)).toBe(false)
  })
})

describe('deriveDisplayStatus', () => {
  it('returns the persisted status when no transient action is in flight', () => {
    expect(deriveDisplayStatus('running', null)).toBe('running')
    expect(deriveDisplayStatus('passed', null)).toBe('passed')
  })

  it.each([
    ['aborting'],
    ['deleting'],
    ['cancelling-heal'],
    ['pausing'],
  ] as const)('overlays the transient action %s on top of the persisted status', (t) => {
    expect(deriveDisplayStatus('running', t)).toBe(t)
    expect(deriveDisplayStatus('healing', t)).toBe(t)
  })
})
