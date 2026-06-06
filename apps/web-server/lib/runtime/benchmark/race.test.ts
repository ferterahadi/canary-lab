import { describe, it, expect } from 'vitest'
import { BenchmarkRace, SabotageNoopError } from './race'
import type { ArmIterationResult } from './report'

describe('BenchmarkRace.runRace', () => {
  it('runs both arms each iteration, resets between iterations, accumulates results, reports', async () => {
    const calls: string[] = []
    const race = new BenchmarkRace({
      iterations: 2,
      sabotageSha: 'a1b2c3d',
      runArm: async (arm, mode, iteration) => {
        calls.push(`run:${arm}:${mode}:${iteration}`)
        const healed = arm === 'A' ? true : iteration === 2 // baseline only heals iter 2
        return {
          arm,
          iteration,
          healed,
          healCycles: arm === 'A' ? 2 : iteration === 2 ? 4 : 5,
          wallClockMs: 1000,
        }
      },
      resetArms: async (sha) => {
        calls.push(`reset:${sha}`)
      },
    })

    const report = await race.runRace()

    expect(calls.filter((c) => c.startsWith('run:A')).length).toBe(2)
    expect(calls.filter((c) => c.startsWith('run:B')).length).toBe(2)
    // arm A is always the harness, arm B always the baseline
    expect(calls).toContain('run:A:harness:1')
    expect(calls).toContain('run:B:baseline:2')
    // reset exactly once — between the two iterations, never after the last
    expect(calls.filter((c) => c.startsWith('reset:')).length).toBe(1)
    expect(calls.filter((c) => c.startsWith('reset:'))[0]).toBe('reset:a1b2c3d')

    expect(report.harness.iterationsHealed).toBe(2)
    expect(report.baseline.iterationsHealed).toBe(1)
    expect(report.reliabilityMultiple).toBe(2)
  })

  it('treats a thrown arm as a failed iteration without blocking the other arm', async () => {
    const race = new BenchmarkRace({
      iterations: 1,
      sabotageSha: 's',
      runArm: async (arm): Promise<ArmIterationResult> => {
        if (arm === 'B') throw new Error('agent crashed')
        return { arm, iteration: 1, healed: true, healCycles: 2, wallClockMs: 100 }
      },
      resetArms: async () => {},
    })

    const report = await race.runRace()

    expect(report.harness.iterationsHealed).toBe(1)
    expect(report.baseline.iterationsHealed).toBe(0)
    expect(report.baseline.iterationsTotal).toBe(1)
  })

  it('stops early when isAborted() becomes true', async () => {
    let firstDone = false
    const race = new BenchmarkRace({
      iterations: 3,
      sabotageSha: 's',
      runArm: async (arm, _mode, iteration) => ({
        arm,
        iteration,
        healed: true,
        healCycles: 1,
        wallClockMs: 1,
      }),
      resetArms: async () => {},
      onIterationComplete: () => { firstDone = true },
      isAborted: () => firstDone, // abort once the first iteration completes
    })

    const report = await race.runRace()

    // Only iteration 1 ran (both arms) before the abort short-circuited the loop.
    expect(report.harness.iterationsTotal).toBe(1)
    expect(report.baseline.iterationsTotal).toBe(1)
  })

  it('emits per-result and per-iteration callbacks for live streaming', async () => {
    const results: ArmIterationResult[] = []
    const completed: number[] = []
    const race = new BenchmarkRace({
      iterations: 1,
      sabotageSha: 's',
      runArm: async (arm, _mode, iteration) => ({
        arm,
        iteration,
        healed: true,
        healCycles: 1,
        wallClockMs: 10,
      }),
      resetArms: async () => {},
      onResult: (r) => results.push(r),
      onIterationComplete: (k) => completed.push(k),
    })

    await race.runRace()

    expect(results).toHaveLength(2) // both arms
    expect(completed).toEqual([1])
  })

  it('runs arms concurrently by default (both start before either finishes)', async () => {
    const order: string[] = []
    const race = new BenchmarkRace({
      iterations: 1,
      sabotageSha: 's',
      runArm: async (arm) => {
        order.push(`${arm}:start`)
        await Promise.resolve()
        order.push(`${arm}:end`)
        return { arm, iteration: 1, healed: true, healCycles: 1, wallClockMs: 1 }
      },
      resetArms: async () => {},
    })
    await race.runRace()
    // both started before either ended
    expect(order.slice(0, 2).sort()).toEqual(['A:start', 'B:start'])
  })

  it('runs arms sequentially when parallel:false (degraded box)', async () => {
    const order: string[] = []
    const race = new BenchmarkRace({
      iterations: 1,
      sabotageSha: 's',
      parallel: false,
      runArm: async (arm) => {
        order.push(`${arm}:start`)
        await Promise.resolve()
        order.push(`${arm}:end`)
        return { arm, iteration: 1, healed: true, healCycles: 1, wallClockMs: 1 }
      },
      resetArms: async () => {},
    })
    await race.runRace()
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('fires onArmStart with each arm runId before the arm finishes', async () => {
    const starts: string[] = []
    const race = new BenchmarkRace({
      iterations: 1,
      sabotageSha: 's',
      runArm: async (arm, _mode, iteration, onStart) => {
        onStart(`run-${arm}-${iteration}`)
        return { arm, iteration, healed: true, healCycles: 1, wallClockMs: 1 }
      },
      resetArms: async () => {},
      onArmStart: (arm, iteration, runId) => starts.push(`${arm}:${iteration}:${runId}`),
    })

    await race.runRace()

    expect(starts.sort()).toEqual(['A:1:run-A-1', 'B:1:run-B-1'])
  })
})
