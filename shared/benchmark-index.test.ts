import { expect, it } from 'vitest'
import { isActiveBenchmarkStatus, isTerminalBenchmarkStatus, type BenchmarkStatus } from './benchmark-index'

const states: [BenchmarkStatus, boolean, boolean][] = [
  ['sabotaging', true, false], ['ready', true, false], ['running', true, false],
  ['done', false, true], ['invalid', false, true], ['aborted', false, true], ['error', false, true],
]
it.each(states)('classifies %s without conflating terminal with cleanup eligibility', (status, active, terminal) => {
  expect(isActiveBenchmarkStatus(status)).toBe(active)
  expect(isTerminalBenchmarkStatus(status)).toBe(terminal)
})
it('does not classify unknown states as active or terminal', () => {
  for (const status of [undefined, 'unknown']) {
    expect(isActiveBenchmarkStatus(status)).toBe(false)
    expect(isTerminalBenchmarkStatus(status)).toBe(false)
  }
})
