import { describe, it, expect } from 'vitest'
import { runSabotage, type SabotageDeps } from './sabotage'

function deps(over: Partial<SabotageDeps> = {}): SabotageDeps {
  return {
    createStagingWorktree: async () => '/wt/staging',
    runSabotageAgent: async () => {},
    testsUntouched: async () => true,
    testsFail: async () => true,
    resetWorktree: async () => {},
    freeze: async () => 'a1b2c3d',
    captureDiff: async () => '--- diff ---',
    maxAttempts: 2,
    ...over,
  }
}

describe('runSabotage', () => {
  it('breaks the app, validates tests go red, freezes and captures the diff', async () => {
    const calls: string[] = []
    const result = await runSabotage('recipe text', deps({
      runSabotageAgent: async (wt, recipe) => { calls.push(`agent:${wt}:${recipe}`) },
      freeze: async () => { calls.push('freeze'); return 'a1b2c3d' },
      captureDiff: async () => { calls.push('diff'); return 'D' },
    }))
    expect(result.sabotageSha).toBe('a1b2c3d')
    expect(result.diff).toBe('D')
    expect(result.attempts).toBe(1)
    expect(calls).toEqual(['agent:/wt/staging:recipe text', 'freeze', 'diff'])
  })

  it('retries when the first sabotage attempt leaves tests green, resetting between attempts', async () => {
    let attempt = 0
    let resets = 0
    const result = await runSabotage('r', deps({
      testsFail: async () => { attempt++; return attempt >= 2 }, // green first, red second
      resetWorktree: async () => { resets++ },
    }))
    expect(result.attempts).toBe(2)
    expect(resets).toBe(1)
  })

  it('rejects a sabotage that modified test files (no-cheat violation)', async () => {
    await expect(
      runSabotage('r', deps({ testsUntouched: async () => false })),
    ).rejects.toThrow(/test files/i)
  })

  it('gives up with an error when the tests never go red', async () => {
    await expect(
      runSabotage('r', deps({ testsFail: async () => false, maxAttempts: 3 })),
    ).rejects.toThrow(/never (failed|went red)|failed to break/i)
  })

  it('aborts promptly when isAborted() is true, skipping the validity-gate trial', async () => {
    let trialRan = false
    await expect(
      runSabotage('r', deps({ isAborted: () => true, testsFail: async () => { trialRan = true; return true } })),
    ).rejects.toThrow(/aborted/i)
    expect(trialRan).toBe(false)
  })

  it('bails right after the agent finishes when a stop arrives mid-attempt', async () => {
    // isAborted is false at the top-of-loop check, then true after the agent —
    // exercising the second abort guard before the no-cheat / validity gate.
    let agentRan = false
    let checked = 0
    let untouchedRan = false
    await expect(
      runSabotage('r', deps({
        isAborted: () => { checked++; return checked > 1 },
        runSabotageAgent: async () => { agentRan = true },
        testsUntouched: async () => { untouchedRan = true; return true },
      })),
    ).rejects.toThrow(/aborted/i)
    expect(agentRan).toBe(true)
    expect(untouchedRan).toBe(false)
  })

  it('defaults to 2 attempts when maxAttempts is unset', async () => {
    let attempts = 0
    await expect(
      runSabotage('r', deps({
        maxAttempts: undefined,
        testsFail: async () => { attempts++; return false }, // never goes red
      })),
    ).rejects.toThrow(/failed to break/i)
    expect(attempts).toBe(2)
  })
})
