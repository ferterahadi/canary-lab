import { describe, it, expect } from 'vitest'
import { canPauseHeal } from './run-actions'

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
