import { describe, it, expect } from 'vitest'
import { BenchmarkOrchestrator } from './orchestrator'
import type { BenchmarkManifest } from './types'
import type { BenchmarkReport } from './report'

function makeManifest(over: Partial<BenchmarkManifest> = {}): BenchmarkManifest {
  return {
    benchmarkId: 'b1',
    feature: 'example_todo_api',
    skill: 'broken-delete-contract',
    level: 'med',
    iterations: 1,
    agent: 'claude',
    status: 'sabotaging',
    startedAt: '2026-06-03T00:00:00.000Z',
    currentIteration: 0,
    arms: [],
    results: [],
    ...over,
  }
}

const REPORT: BenchmarkReport = {
  harness: { iterationsHealed: 1, iterationsTotal: 1, avgHealCycles: 2, totalWallClockMs: 100 },
  baseline: { iterationsHealed: 0, iterationsTotal: 1, avgHealCycles: 5, totalWallClockMs: 200 },
  reliabilityMultiple: null,
}

describe('BenchmarkOrchestrator.run', () => {
  it('runs the full lifecycle: sabotaging → running → done, attaching sha/diff/results/report', async () => {
    const persisted: BenchmarkManifest[] = []
    const calls: string[] = []
    const orch = new BenchmarkOrchestrator({
      manifest: makeManifest(),
      persist: (m) => persisted.push(structuredClone(m)),
      sabotage: async () => {
        calls.push('sabotage')
        return { sabotageSha: 'a1b2c3d', diff: 'D' }
      },
      writeDiff: (d) => calls.push(`diff:${d}`),
      setupArms: async (sha) => calls.push(`setup:${sha}`),
      runRace: async ({ onResult, onIterationComplete }) => {
        onResult({ arm: 'A', iteration: 1, healed: true, healCycles: 2, wallClockMs: 100 })
        onResult({ arm: 'B', iteration: 1, healed: false, healCycles: 5, wallClockMs: 200 })
        onIterationComplete(1)
        return REPORT
      },
      now: () => '2026-06-03T02:00:00.000Z',
    })

    const final = await orch.run()

    expect(final.status).toBe('done')
    expect(final.sabotageSha).toBe('a1b2c3d')
    expect(final.report).toEqual(REPORT)
    expect(final.results).toHaveLength(2)
    expect(final.endedAt).toBe('2026-06-03T02:00:00.000Z')

    const statuses = persisted.map((m) => m.status)
    expect(statuses[0]).toBe('sabotaging')
    expect(statuses).toContain('running')
    expect(statuses[statuses.length - 1]).toBe('done')
    expect(calls).toEqual(['sabotage', 'diff:D', 'setup:a1b2c3d'])
  })

  it('records an arm runId into the manifest and persists it as soon as the arm starts', async () => {
    const persisted: BenchmarkManifest[] = []
    const orch = new BenchmarkOrchestrator({
      manifest: makeManifest({
        arms: [
          { arm: 'A', mode: 'harness', runIds: [] },
          { arm: 'B', mode: 'baseline', runIds: [] },
        ],
      }),
      persist: (m) => persisted.push(structuredClone(m)),
      sabotage: async () => ({ sabotageSha: 'sha', diff: 'D' }),
      writeDiff: () => {},
      setupArms: async () => {},
      runRace: async ({ onArmStart }) => {
        onArmStart('A', 1, 'run-A')
        onArmStart('B', 1, 'run-B')
        return REPORT
      },
      now: () => 't',
    })

    const final = await orch.run()

    expect(final.arms.find((a) => a.arm === 'A')?.runIds).toEqual(['run-A'])
    expect(final.arms.find((a) => a.arm === 'B')?.runIds).toEqual(['run-B'])
    // The runId was persisted live (a snapshot before the terminal 'done' state).
    const liveWithRunId = persisted.find(
      (m) => m.status === 'running' && m.arms.find((a) => a.arm === 'A')?.runIds.includes('run-A'),
    )
    expect(liveWithRunId).toBeDefined()
  })

  it('marks the run aborted (not done) when isAborted() is true', async () => {
    let final: BenchmarkManifest | undefined
    const orch = new BenchmarkOrchestrator({
      manifest: makeManifest(),
      persist: (m) => { final = m },
      sabotage: async () => ({ sabotageSha: 'a1b2c3d', diff: 'D' }),
      writeDiff: () => {},
      setupArms: async () => {},
      runRace: async () => REPORT,
      now: () => '2026-06-03T02:00:00.000Z',
      isAborted: () => true,
    })
    const result = await orch.run()
    expect(result.status).toBe('aborted')
    expect(final?.status).toBe('aborted')
  })

  it('short-circuits to aborted after sabotage without running the race', async () => {
    let raceRan = false
    const orch = new BenchmarkOrchestrator({
      manifest: makeManifest(),
      persist: () => {},
      sabotage: async () => ({ sabotageSha: 'sha', diff: 'D' }),
      writeDiff: () => {},
      setupArms: async () => {},
      runRace: async () => { raceRan = true; return REPORT },
      now: () => 't',
      isAborted: () => true,
    })
    const final = await orch.run()
    expect(final.status).toBe('aborted')
    expect(raceRan).toBe(false)
  })

  it('records a throw during an abort as aborted, not error', async () => {
    const orch = new BenchmarkOrchestrator({
      manifest: makeManifest(),
      persist: () => {},
      sabotage: async () => { throw new Error('child killed') },
      writeDiff: () => {},
      setupArms: async () => {},
      runRace: async () => REPORT,
      now: () => 't',
      isAborted: () => true,
    })
    const final = await orch.run()
    expect(final.status).toBe('aborted')
    expect(final.error).toBeUndefined()
  })

  it('captures errors as status=error with a message, and still runs cleanup', async () => {
    let cleaned = false
    const orch = new BenchmarkOrchestrator({
      manifest: makeManifest(),
      persist: () => {},
      sabotage: async () => {
        throw new Error('could not break it')
      },
      writeDiff: () => {},
      setupArms: async () => {},
      runRace: async () => REPORT,
      now: () => '2026-06-03T02:00:00.000Z',
      cleanup: async () => {
        cleaned = true
      },
    })

    const final = await orch.run()

    expect(final.status).toBe('error')
    expect(final.error).toMatch(/could not break it/)
    expect(cleaned).toBe(true)
  })
})
