// Manifest-writing arms the orchestrator tests don't reach: a service carrying
// allocated ports, the heartbeat tick firing after the run stopped, and the
// fire-and-forget dirty-spec recompute rejecting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { setStatus, startHeartbeat, stopHeartbeat, writeInitialManifest } from './run-manifest-writer'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { ServiceSpec } from './orchestrator'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-manifest-w-')))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, opts, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

describe('writeInitialManifest', () => {
  it('carries a service\'s allocated ports into the manifest', () => {
    const { ctx, sink } = ctxFor()
    const services: ServiceSpec[] = [
      { name: 'api', safeName: 'api', command: 'noop', cwd: tmpDir, allocatedPorts: { API: 4310 } },
      // An empty map is omitted rather than written as `{}` — readers treat a
      // present-but-empty `allocatedPorts` as "this run allocated nothing".
      { name: 'web', safeName: 'web', command: 'noop', cwd: tmpDir, allocatedPorts: {} },
      { name: 'db', safeName: 'db', command: 'noop', cwd: tmpDir },
    ] as unknown as ServiceSpec[]
    ;(ctx as { services: ServiceSpec[] }).services = services

    writeInitialManifest(ctx)

    const written = (sink.bootstrap as unknown as { mock: { calls: [{ services: unknown[] }][] } }).mock.calls[0][0]
    expect(written.services).toEqual([
      expect.objectContaining({ safeName: 'api', allocatedPorts: { API: 4310 } }),
      expect.not.objectContaining({ allocatedPorts: expect.anything() }),
      expect.not.objectContaining({ allocatedPorts: expect.anything() }),
    ])
  })

  it('keeps only repo paths that exist on disk', () => {
    const real = path.join(tmpDir, 'repo-here')
    fs.mkdirSync(real)
    const { ctx, sink } = ctxFor()
    ctx.feature.repos = [
      { name: 'here', localPath: real },
      { name: 'gone', localPath: path.join(tmpDir, 'no-such-repo') },
    ] as never

    writeInitialManifest(ctx)

    const written = (sink.bootstrap as unknown as { mock: { calls: [{ repoPaths: string[] }][] } }).mock.calls[0][0]
    expect(written.repoPaths).toEqual([real])
  })
})

describe('startHeartbeat', () => {
  it('stops writing heartbeats once the run has stopped', () => {
    vi.useFakeTimers()
    const { ctx } = ctxFor()
    const recordHeartbeat = vi.fn()
    ;(ctx.stateSink as unknown as { recordHeartbeat: unknown }).recordHeartbeat = recordHeartbeat

    startHeartbeat(ctx)
    vi.advanceTimersByTime(5_000)
    expect(recordHeartbeat).toHaveBeenCalledTimes(1)

    // A stopped run's timer may still fire once before stopHeartbeat lands —
    // the tick has to no-op rather than resurrect the run in the index.
    ctx.stopped = true
    vi.advanceTimersByTime(15_000)
    expect(recordHeartbeat).toHaveBeenCalledTimes(1)

    stopHeartbeat(ctx)
    expect(ctx.heartbeatTimer).toBeNull()
  })
})

describe('setStatus', () => {
  it('swallows a rejected dirty-spec recompute rather than failing the status write', async () => {
    const finalizeRun = vi.fn(async () => { throw new Error('hook exploded') })
    const { ctx } = ctxFor({}, { dirtySpecHooks: { finalizeRun } })

    expect(() => setStatus(ctx, 'passed')).not.toThrow()
    expect(finalizeRun).toHaveBeenCalledWith(ctx.feature.name, ctx.feature.featureDir, true)
    // Let the rejected promise settle — an unhandled rejection here would fail
    // the suite, which is exactly what the `.catch` is preventing.
    await new Promise((r) => setImmediate(r))
    expect(ctx.status).toBe('passed')
  })

  it('does not touch the spec baseline for a failed run', () => {
    const finalizeRun = vi.fn(async () => {})
    const { ctx } = ctxFor({}, { dirtySpecHooks: { finalizeRun } })

    setStatus(ctx, 'failed')

    expect(finalizeRun).not.toHaveBeenCalled()
  })
})
