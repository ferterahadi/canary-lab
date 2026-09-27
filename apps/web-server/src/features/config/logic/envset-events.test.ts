import { expect, it, vi } from 'vitest'
import { publishEnvsetChange } from './envset-events'

it('announces one slot change for each successful operation, including repeats', () => {
  const publish = vi.fn()
  publishEnvsetChange({ publish }, 'checkout', 'slots')
  publishEnvsetChange({ publish }, 'checkout', 'slots')
  publishEnvsetChange({ publish }, 'search', 'slots')
  expect(publish.mock.calls).toEqual([
    [{ type: 'envsets-changed', feature: 'checkout' }],
    [{ type: 'envsets-changed', feature: 'checkout' }],
    [{ type: 'envsets-changed', feature: 'search' }],
  ])
})

it('announces structural changes in envset-then-feature order', () => {
  const publish = vi.fn()
  publishEnvsetChange({ publish }, 'checkout', 'structure')
  expect(publish.mock.calls).toEqual([
    [{ type: 'envsets-changed', feature: 'checkout' }], [{ type: 'features-changed' }],
  ])
})

it.each(['slots', 'structure'] as const)('allows a %s writer without a workspace publisher', (scope) => {
  expect(() => publishEnvsetChange(undefined, 'checkout', scope)).not.toThrow()
})
