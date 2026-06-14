import { describe, it, expect } from 'vitest'
import { runSabotage, type SabotageDeps } from './sabotage'

function deps(over: Partial<SabotageDeps> = {}): SabotageDeps {
  return {
    createStagingWorktree: async () => '/wt/staging',
    runSabotageAgent: async () => {},
    testsUntouched: async () => true,
    freeze: async () => 'a1b2c3d',
    captureDiff: async () => '--- diff ---',
    ...over,
  }
}

describe('runSabotage', () => {
  it('breaks the app, checks tests are untouched, freezes and captures the diff', async () => {
    const calls: string[] = []
    const result = await runSabotage('recipe text', deps({
      runSabotageAgent: async (wt, recipe) => { calls.push(`agent:${wt}:${recipe}`) },
      testsUntouched: async () => { calls.push('untouched'); return true },
      freeze: async () => { calls.push('freeze'); return 'a1b2c3d' },
      captureDiff: async () => { calls.push('diff'); return 'D' },
    }))
    expect(result.sabotageSha).toBe('a1b2c3d')
    expect(result.diff).toBe('D')
    expect(result.worktreePath).toBe('/wt/staging')
    // No boot+suite validity gate: agent → no-cheat check → freeze → diff, once.
    expect(calls).toEqual(['agent:/wt/staging:recipe text', 'untouched', 'freeze', 'diff'])
  })

  it('does NOT run the tests itself — validity is left to the race', async () => {
    // The linear flow has no test-running dep at all; it freezes whatever the
    // agent produced. A no-op break is caught later by the race, not here.
    const result = await runSabotage('r', deps())
    expect(result.sabotageSha).toBe('a1b2c3d')
  })

  it('rejects a sabotage that modified test files (no-cheat violation)', async () => {
    await expect(
      runSabotage('r', deps({ testsUntouched: async () => false })),
    ).rejects.toThrow(/test files/i)
  })

  it('propagates the freeze empty-diff guard when the agent edited nothing', async () => {
    await expect(
      runSabotage('r', deps({
        freeze: async () => { throw new Error('sabotage produced no file changes to freeze') },
      })),
    ).rejects.toThrow(/no file changes/i)
  })

  it('aborts promptly when isAborted() is true before the agent runs', async () => {
    let agentRan = false
    await expect(
      runSabotage('r', deps({ isAborted: () => true, runSabotageAgent: async () => { agentRan = true } })),
    ).rejects.toThrow(/aborted/i)
    expect(agentRan).toBe(false)
  })

  it('bails right after the agent finishes when a stop arrives mid-phase', async () => {
    // isAborted is false at the pre-agent check, then true after the agent —
    // exercising the second abort guard before the no-cheat check / freeze.
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
})
