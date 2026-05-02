import { describe, it, expect } from 'vitest'
import { canCancelHeal, canDelete, canPauseHeal, canStop } from './run-actions'

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
