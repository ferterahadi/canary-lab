import { describe, it, expect } from 'vitest'
import path from 'path'
import { planRestart } from './restart-planner'
import type { ServiceSpec } from './orchestrator'

function svc(safeName: string, cwd: string): ServiceSpec {
  return { name: safeName, safeName, command: 'echo', cwd }
}

describe('planRestart', () => {
  const services = [
    svc('api', '/repos/api'),
    svc('web', '/repos/web'),
    svc('worker', '/repos/worker'),
  ]

  it('returns noMatch=false and full keep list when filesChanged is empty (legacy)', () => {
    const plan = planRestart([], services)
    expect(plan.toRestart).toEqual([])
    expect(plan.toKeep).toEqual(['api', 'web', 'worker'])
    expect(plan.noMatch).toBe(false)
  })

  it('matches a single file under one service', () => {
    const plan = planRestart(['/repos/api/src/server.ts'], services)
    expect(plan.toRestart).toEqual(['api'])
    expect(plan.toKeep).toEqual(['web', 'worker'])
    expect(plan.noMatch).toBe(false)
  })

  it('matches multiple services when files span repos', () => {
    const plan = planRestart(
      ['/repos/api/src/a.ts', '/repos/web/src/b.tsx'],
      services,
    )
    expect(plan.toRestart.sort()).toEqual(['api', 'web'])
    expect(plan.toKeep).toEqual(['worker'])
    expect(plan.noMatch).toBe(false)
  })

  it('matches the cwd path itself', () => {
    const plan = planRestart(['/repos/api'], services)
    expect(plan.toRestart).toEqual(['api'])
  })

  it('returns noMatch=true when filesChanged points outside every service', () => {
    const plan = planRestart(['/elsewhere/x.ts'], services)
    expect(plan.toRestart).toEqual([])
    expect(plan.toKeep).toEqual(['api', 'web', 'worker'])
    expect(plan.noMatch).toBe(true)
  })

  it('does not falsely match a sibling dir prefix (api vs api-v2)', () => {
    const ss = [svc('api', '/repos/api'), svc('apiv2', '/repos/api-v2')]
    const plan = planRestart(['/repos/api-v2/src/x.ts'], ss)
    expect(plan.toRestart).toEqual(['apiv2'])
    expect(plan.toKeep).toEqual(['api'])
  })

  it('resolves relative paths against cwd before matching', () => {
    // Use a real abs cwd we know — the test process cwd. Build a relative
    // file under it and a service cwd that is also abs.
    const procCwd = process.cwd()
    const ss = [svc('here', procCwd)]
    const plan = planRestart(['package.json'], ss)
    expect(plan.toRestart).toEqual(['here'])
  })

  it('handles empty service list', () => {
    const plan = planRestart(['/x/y.ts'], [])
    expect(plan.toRestart).toEqual([])
    expect(plan.toKeep).toEqual([])
    expect(plan.noMatch).toBe(true)
  })
})
