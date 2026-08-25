import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HealAgentChoice } from './logic/runtime/launcher/project-config'

// `pickAvailableHealAgent` shells out to check whether each CLI is installed,
// which is the one edge a unit test can't reproduce — and the only thing this
// module delegates. What it decides for itself is the PRECEDENCE, so the fake
// records what it was asked for and the assertions are about that.
const picked = vi.hoisted(() => ({ calls: [] as unknown[], answer: 'claude' as unknown }))
vi.mock('./logic/runtime/auto-heal', () => ({
  pickAvailableHealAgent: (...args: unknown[]) => {
    picked.calls.push(args[0])
    return picked.answer
  },
}))

const { pickConfiguredHealAgent } = await import('./pick-heal-agent')

beforeEach(() => {
  picked.calls = []
  picked.answer = 'claude'
})

describe('pickConfiguredHealAgent', () => {
  it('honours a run\'s persisted choice over the project config', () => {
    picked.answer = 'codex'

    expect(pickConfiguredHealAgent('claude', 'codex')).toBe('codex')

    // A run that already healed with codex must keep healing with codex, even
    // after the project default changes underneath it.
    expect(picked.calls).toEqual(['codex'])
  })

  it('asks for whichever CLI is installed when the config says auto', () => {
    expect(pickConfiguredHealAgent('auto')).toBe('claude')

    expect(picked.calls).toEqual([undefined])
  })

  for (const agent of ['claude', 'codex'] as const) {
    it(`asks for ${agent} when the config names it`, () => {
      picked.answer = agent

      expect(pickConfiguredHealAgent(agent)).toBe(agent)

      expect(picked.calls).toEqual([agent])
    })
  }

  it('reports the named agent as unavailable rather than substituting another', () => {
    picked.answer = null

    expect(pickConfiguredHealAgent('claude')).toBeNull()
  })

  for (const choice of ['manual', 'external'] as HealAgentChoice[]) {
    it(`picks no local agent for '${choice}' without probing the CLIs`, () => {
      expect(pickConfiguredHealAgent(choice)).toBeNull()

      // Probing would be wrong, not merely wasteful: these two choices mean the
      // heal is somebody else's job, so a local agent must never be selected.
      expect(picked.calls).toEqual([])
    })
  }
})
