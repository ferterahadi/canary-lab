import { describe, expect, it, vi } from 'vitest'
import type { HealAgent } from './agent-binary'
import { resolveAvailableAgentOrder } from './agent-selection'

describe('resolveAvailableAgentOrder', () => {
  it.each([
    { preferred: 'codex', available: ['claude', 'codex'], automatic: 'claude', expected: ['codex', 'claude'] },
    { preferred: 'claude', available: ['claude', 'codex'], automatic: 'codex', expected: ['claude', 'codex'] },
    { available: ['claude', 'codex'], automatic: 'codex', expected: ['codex', 'claude'] },
    { available: ['claude', 'codex'], automatic: 'claude', expected: ['claude', 'codex'] },
    { available: ['claude', 'codex'], automatic: null, expected: ['claude', 'codex'] },
    { preferred: 'codex', available: ['claude'], automatic: 'claude', expected: ['claude'] },
    { preferred: 'claude', available: ['codex'], automatic: 'codex', expected: ['codex'] },
    { available: [], automatic: null, expected: [] },
  ] satisfies Array<{ preferred?: HealAgent; available: HealAgent[]; automatic: HealAgent | null; expected: HealAgent[] }>)('preserves selection and probes for %j', ({ preferred, available, automatic, expected }) => {
    const pick = vi.fn((agent?: HealAgent) => agent ? (available.includes(agent) ? agent : null) : automatic)
    expect(resolveAvailableAgentOrder(preferred, pick)).toEqual(expected)
    expect(pick.mock.calls).toEqual([preferred ? [preferred] : [], ['claude'], ['codex']])
  })

  it('reads changed availability on the next invocation', () => {
    const pick = vi.fn<() => HealAgent | null>().mockReturnValue('claude')
    expect(resolveAvailableAgentOrder(undefined, pick)).toEqual(['claude'])
    pick.mockReturnValue('codex')
    expect(resolveAvailableAgentOrder(undefined, pick)).toEqual(['codex'])
    expect(pick).toHaveBeenCalledTimes(6)
  })
})
