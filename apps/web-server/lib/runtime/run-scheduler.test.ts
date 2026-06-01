import { describe, expect, it } from 'vitest'
import { RunScheduler, type SchedulerActiveRun } from './run-scheduler'
import { estimateRunCost, type AdmissionConfig, type SystemResources } from './admission'

const GB = 1024 * 1024 * 1024
const bigBox: SystemResources = { cpuCount: 16, freeMemBytes: 32 * GB }
const heuristic: AdmissionConfig = { maxConcurrentRuns: null, perRunMemBytes: 768 * 1024 * 1024 }

function scheduler(active: SchedulerActiveRun[], config: AdmissionConfig = heuristic, resources = bigBox) {
  return new RunScheduler({ listActive: () => active, readResources: () => resources, config })
}

describe('RunScheduler.fits', () => {
  it('admits when there is no collision and resources allow', () => {
    expect(scheduler([]).fits({ repoPaths: ['/a'], cost: 2 })).toEqual({ ok: true })
  })

  it('reports repo-collision before resources', () => {
    const s = scheduler([{ runId: 'r1', feature: 'a', repoPaths: ['/a'], cost: 2 }])
    expect(s.fits({ repoPaths: ['/a'], cost: 2 })).toEqual({ ok: false, reason: 'repo-collision' })
  })

  it('reports resources when the manual ceiling is hit', () => {
    const s = scheduler(
      [{ runId: 'r1', feature: 'a', repoPaths: ['/a'], cost: 2 }],
      { maxConcurrentRuns: 1, perRunMemBytes: 768 * 1024 * 1024 },
    )
    expect(s.fits({ repoPaths: ['/b'], cost: 2 })).toEqual({ ok: false, reason: 'resources' })
  })
})

describe('RunScheduler queue ops', () => {
  it('enqueues, reports membership, exposes the queue, and cancels', () => {
    const s = scheduler([])
    s.enqueue({ runId: 'q1', feature: 'a', repoPaths: ['/a'], cost: 2, reason: 'resources', launch: async () => {} })
    expect(s.isQueued('q1')).toBe(true)
    expect(s.queued().map((q) => q.runId)).toEqual(['q1'])
    expect(s.cancel('q1')).toBe(true)
    expect(s.isQueued('q1')).toBe(false)
    expect(s.queued()).toEqual([])
    expect(s.cancel('nope')).toBe(false)
  })
})

describe('RunScheduler.promote', () => {
  it('launches a queued run once its blocking run ends', async () => {
    const active: SchedulerActiveRun[] = [{ runId: 'r1', feature: 'a', repoPaths: ['/a'], cost: 2 }]
    const s = new RunScheduler({ listActive: () => active, readResources: () => bigBox, config: heuristic })
    const launched: string[] = []
    s.enqueue({
      runId: 'q1', feature: 'a', repoPaths: ['/a'], cost: 2, reason: 'repo-collision',
      launch: async () => { launched.push('q1') },
    })

    // While r1 holds /a, the collision keeps q1 queued.
    await s.promote()
    expect(launched).toEqual([])

    // r1 ends → /a frees → q1 promotes.
    active.length = 0
    await s.promote()
    expect(launched).toEqual(['q1'])
    expect(s.isQueued('q1')).toBe(false)
  })

  it('swallows a launch failure during promotion and still dequeues', async () => {
    const active: SchedulerActiveRun[] = []
    const s = new RunScheduler({ listActive: () => active, readResources: () => bigBox, config: heuristic })
    s.enqueue({
      runId: 'q1', feature: 'a', repoPaths: ['/a'], cost: 1, reason: 'resources',
      launch: async () => { throw new Error('boom') },
    })
    await expect(s.promote()).resolves.toBeUndefined()
    expect(s.isQueued('q1')).toBe(false)
  })

  it('guards against re-entrant promote() calls', async () => {
    const active: SchedulerActiveRun[] = []
    const s = new RunScheduler({ listActive: () => active, readResources: () => bigBox, config: heuristic })
    const calls: string[] = []
    s.enqueue({
      runId: 'q1', feature: 'a', repoPaths: ['/a'], cost: 1, reason: 'resources',
      // Re-enter promote() while the outer promote() is still running — the
      // guard must early-return rather than double-launch.
      launch: async () => { calls.push('launch'); await s.promote() },
    })
    await s.promote()
    expect(calls).toEqual(['launch'])
  })

  it('promotes FIFO and stops when the budget is exhausted, re-evaluating after each launch', async () => {
    // Small box: cpuCount 3 → cpu slots 2; mem ample. Budget = 2 slots.
    const small: SystemResources = { cpuCount: 3, freeMemBytes: 32 * GB }
    const active: SchedulerActiveRun[] = []
    const s = new RunScheduler({ listActive: () => active, readResources: () => small, config: heuristic })
    const launched: string[] = []
    const makeLaunch = (id: string, cost: number) => async () => {
      launched.push(id)
      active.push({ runId: id, feature: id, repoPaths: [`/${id}`], cost })
    }
    s.enqueue({ runId: 'q1', feature: 'q1', repoPaths: ['/q1'], cost: 1, reason: 'resources', launch: makeLaunch('q1', 1) })
    s.enqueue({ runId: 'q2', feature: 'q2', repoPaths: ['/q2'], cost: 1, reason: 'resources', launch: makeLaunch('q2', 1) })
    s.enqueue({ runId: 'q3', feature: 'q3', repoPaths: ['/q3'], cost: 1, reason: 'resources', launch: makeLaunch('q3', 1) })

    await s.promote()
    // First promotion: nothing active → q1 admitted always. Then used=1,
    // budget 2 → q2 admitted (1+1<=2). Then used=2, q3 → 2+1>2 → stays queued.
    expect(launched).toEqual(['q1', 'q2'])
    expect(s.isQueued('q3')).toBe(true)
  })
})
