import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { runAgentProcess } from '../../../agent-sessions/logic/agent-process'
import { agentSpawnJob, evaluationExportJob, portifyJob, runJob } from './stage-jobs'
import type { FlightInject, FlightStageDeps } from './context'
import { stageContextStub } from './__fixtures__/stage-context'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '../types'
import { buildFlightStageAdapters } from './index'

// The four job factories, tested at the level that matters: what each one asks
// its subsystem to do, and — crucially — the states in which it deliberately asks
// for NOTHING. A stop that fires unconditionally would be worse than no stop at
// all: it would rewrite settled verdicts and discard verified work.

interface InjectCall { method: string; url: string }

function makeInject(
  impl: (call: InjectCall) => { statusCode: number; body: unknown } | undefined,
  calls: InjectCall[] = [],
): FlightInject {
  return async (opts) => {
    calls.push({ method: opts.method, url: opts.url })
    const res = impl({ method: opts.method, url: opts.url }) ?? { statusCode: 200, body: {} }
    return { statusCode: res.statusCode, json: () => res.body }
  }
}

function deps(inject: FlightInject): FlightStageDeps {
  return { featuresDir: '/features', logsDir: '/logs', projectRoot: '/root', inject }
}

describe('runJob', () => {
  const active = (calls: InjectCall[]) => makeInject((call) => {
    if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running' } } }
    return { statusCode: 204, body: {} }
  }, calls)

  it('aborts a run that is still going', async () => {
    const calls: InjectCall[] = []
    await runJob(deps(active(calls)), 'run-1').stop('pause')
    expect(calls).toContainEqual({ method: 'POST', url: '/api/runs/run-1/abort' })
  })

  it('leaves a settled run alone — re-aborting would rewrite a verdict', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => (call.method === 'GET'
      ? { statusCode: 200, body: { manifest: { status: 'passed' } } }
      : { statusCode: 204, body: {} }), calls)
    await runJob(deps(inject), 'run-1').stop('abort')
    expect(calls.some((c) => c.url.endsWith('/abort'))).toBe(false)
  })

  it('leaves a vanished run alone', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject(() => ({ statusCode: 200, body: {} }), calls) // no manifest
    await runJob(deps(inject), 'run-1').stop('pause')
    expect(calls.some((c) => c.url.endsWith('/abort'))).toBe(false)
  })

  it('carries the runId as its diagnostic id', () => {
    expect(runJob(deps(makeInject(() => undefined)), 'run-7').id).toBe('run-7')
  })
})

describe('portifyJob', () => {
  const withStatus = (status: string | undefined, calls: InjectCall[]) => makeInject((call) => {
    if (call.method === 'GET') return { statusCode: 200, body: status === undefined ? {} : { status } }
    return { statusCode: 200, body: {} }
  }, calls)

  it('cancels a workflow that is still editing', async () => {
    const calls: InjectCall[] = []
    await portifyJob(deps(withStatus('editing', calls)), 'w-1').stop('pause')
    expect(calls).toContainEqual({ method: 'POST', url: '/api/portify/w-1/cancel' })
  })

  it('SPARES a verified review the user still has to answer', async () => {
    // The one case where stopping would destroy something: that diff passed a
    // concurrent double-boot, resume re-adopts it, and the user never declined it.
    const calls: InjectCall[] = []
    await portifyJob(deps(withStatus('ready-to-save', calls)), 'w-1').stop('pause')
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false)
  })

  for (const status of ['saved', 'failed', 'aborted']) {
    it(`leaves an already-${status} workflow alone`, async () => {
      const calls: InjectCall[] = []
      await portifyJob(deps(withStatus(status, calls)), 'w-1').stop('abort')
      expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false)
    })
  }

  it('leaves a workflow with no status at all alone (record gone)', async () => {
    const calls: InjectCall[] = []
    await portifyJob(deps(withStatus(undefined, calls)), 'w-1').stop('pause')
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false)
  })
})

describe('evaluationExportJob', () => {
  it('uses the ABORT route, never the delete — a pause must leave the record readable', async () => {
    const calls: InjectCall[] = []
    await evaluationExportJob(deps(makeInject(() => undefined, calls)), 'task-1').stop('pause')
    expect(calls).toEqual([{ method: 'POST', url: '/api/evaluation-exports/task-1/abort' }])
  })
})

describe('agentSpawnJob', () => {
  const { mockNodeSpawn } = vi.hoisted(() => ({ mockNodeSpawn: vi.fn() }))

  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = { end: vi.fn() }
    signals: NodeJS.Signals[] = []
    kill(signal?: NodeJS.Signals): boolean {
      this.signals.push(signal ?? 'SIGTERM')
      this.emit('close', null, signal ?? 'SIGTERM')
      return true
    }
  }

  let flightDir: string

  beforeEach(() => {
    flightDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-stagejobs-')))
  })

  afterEach(() => {
    fs.rmSync(flightDir, { recursive: true, force: true })
    mockNodeSpawn.mockReset()
  })

  function ctxIn(dir: string) {
    return stageContextStub({
      manifest: () => ({ flightDir: dir } as unknown as FlightManifest),
      flightDir: dir,
      patchFlight: () => {},
    })
  }

  function spawnUnder(scope: string): FakeChild {
    const child = new FakeChild()
    runAgentProcess({
      command: 'claude', args: [], idleMs: 60_000, spawnScope: scope,
      spawnImpl: (() => child as unknown as ChildProcess) as never,
      resolveBinary: () => null,
    })
    return child
  }

  it('stops the agent spawned under the stage sidecar dir', async () => {
    const child = spawnUnder(path.join(flightDir, 'scout'))
    await agentSpawnJob(ctxIn(flightDir), 'scout').stop('pause')
    expect(child.signals).toContain('SIGTERM')
  })

  it('stops BOTH halves of specs-coverage — the author and the mapper', async () => {
    // The one stage with two spawns under two dirs. A teardown that knew about
    // only the stage key would have left the coverage mapper running.
    const author = spawnUnder(path.join(flightDir, 'specs-coverage'))
    const mapper = spawnUnder(path.join(flightDir, 'coverage-map'))
    await agentSpawnJob(ctxIn(flightDir), 'specs-coverage').stop('abort')
    expect(author.signals).toContain('SIGTERM')
    expect(mapper.signals).toContain('SIGTERM')
  })

  it('is a no-op when the stage has no live spawn', async () => {
    // Covers every "nothing running" case at once: never spawned, already
    // exited, or an external client is executing the step.
    const other = spawnUnder(path.join(flightDir, 'docs'))
    await agentSpawnJob(ctxIn(flightDir), 'scout').stop('pause')
    expect(other.signals).toEqual([])
    other.kill('SIGTERM')
  })

  it('names itself by stage — there is no process id worth logging', () => {
    expect(agentSpawnJob(ctxIn(flightDir), 'docs').id).toBe('agent:docs')
  })
})

describe('every stage answers the teardown question', () => {
  // The point of making `teardown` required rather than optional. Its predecessor
  // was an optional `interrupt?` that was silently skipped when absent, so ten of
  // eleven adapters opted out with no compile error and no failing test — and a
  // pause stopped the flight's WAITING while the portify agent kept editing the
  // user's repo. This table is the runtime half of that guarantee: a new stage
  // that forgets shows up here, not in production.
  const adapters = buildFlightStageAdapters(deps(makeInject(() => undefined)))
  const flightDir = '/tmp/cl-teardown-table'
  const ctx = stageContextStub({
    manifest: () => ({ flightDir, stages: [], links: {} } as unknown as FlightManifest),
    flightDir,
    patchFlight: () => {},
  })

  it.each(FLIGHT_STAGE_KEYS)('%s implements teardown', (key) => {
    expect(typeof adapters[key]!.teardown).toBe('function')
  })

  // Owning nothing is a legitimate answer — but it has to be the adapter's own
  // answer, stated deliberately, not the absence of one.
  it.each(['similarity', 'scaffold', 'heal'] as const)('%s owns no work and says so', (key) => {
    expect(adapters[key]!.teardown(ctx)).toBeNull()
  })

  // A stage with a subsystem pointer it has not set yet owns nothing either — the
  // pointer is what a teardown reaches for.
  it.each(['env-capture', 'portify', 'run', 'evaluation-export'] as const)(
    '%s owns nothing before it has started its work',
    (key) => {
      expect(adapters[key]!.teardown(ctx)).toBeNull()
    },
  )

  // The spawn stages always hand back a job: the scope lookup is what decides
  // whether anything is actually running, so they never have to guess.
  it.each(['scout', 'docs', 'prd-summary', 'specs-coverage'] as const)(
    '%s always hands back its spawn scope',
    (key) => {
      expect(adapters[key]!.teardown(ctx)).toMatchObject({ id: `agent:${key}` })
    },
  )
})
