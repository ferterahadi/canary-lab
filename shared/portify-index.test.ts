import { expect, it } from 'vitest'
import { isActionablePortifyStatus, isActivePortifyStatus, isExecutingPortifyStatus, isTerminalPortifyStatus, type PortifyStatus } from './portify-index'

const states: [PortifyStatus, boolean, boolean, boolean][] = [
  ['planning', true, true, false], ['editing', true, true, false], ['verifying', true, true, false],
  ['ready-to-save', false, true, false], ['saved', false, false, true],
  ['failed', false, false, true], ['aborted', false, false, true],
]
it.each(states)('classifies %s without treating actionable as executing', (status, executing, active, terminal) => {
  expect(isExecutingPortifyStatus(status)).toBe(executing)
  expect(isActionablePortifyStatus(status)).toBe(active)
  expect(isActivePortifyStatus(status)).toBe(active)
  expect(isTerminalPortifyStatus(status)).toBe(terminal)
})
it('retains the active compatibility alias', () => {
  expect(isActivePortifyStatus).toBe(isActionablePortifyStatus)
})
it('does not classify unknown states', () => {
  for (const status of [undefined, 'unknown']) {
    expect(isExecutingPortifyStatus(status)).toBe(false)
    expect(isActivePortifyStatus(status)).toBe(false)
    expect(isTerminalPortifyStatus(status)).toBe(false)
  }
})
