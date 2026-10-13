import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { RunStore, SERVER_EXITED_MESSAGE, type RunStoreEvent } from './run-store'
import { createRegistry, type OrchestratorLike } from './run-registry'
import { readManifest, readRunsIndex, writeManifest, writeRunsIndex } from './runtime/manifest'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import type { RunHeartbeatOwner, RunManifest } from '../../../../../../shared/run-manifest'
import { HEARTBEAT_STALE_MS } from '../../../../../../shared/run-state'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

// A run outlives the server that drove it whenever that server stops mid-run.
// Live case (2026-10-09, runs 0559-ulr5 and 0628-citr): the next server booted
// inside the ten-minute staleness window, read the fresh heartbeat as a live
// peer's, and left both runs `healing` with no runner and no services — Stop
// Heal 404'd, start_run reused the corpse and signal_run fed a dead poll loop.
// Each row is signed by the server that beats it, so these tests stage servers
// as signatures and decide which pids are alive.

const tempDir = trackTempDirs('cl-rso-')
let logsDir: string

const SELF: RunHeartbeatOwner = { pid: 100, instanceId: 'this-server' }
const PEER: RunHeartbeatOwner = { pid: 200, instanceId: 'peer-server' }
const DEAD: RunHeartbeatOwner = { pid: 300, instanceId: 'exited-server' }
const livePids = new Set<number>([SELF.pid, PEER.pid])

beforeEach(() => {
  logsDir = tempDir()
  livePids.clear()
  livePids.add(SELF.pid).add(PEER.pid)
})

function store(registry = createRegistry()): { store: RunStore; events: RunStoreEvent[] } {
  const s = new RunStore(logsDir, registry, { owner: SELF, isProcessAlive: (pid) => livePids.has(pid) })
  const events: RunStoreEvent[] = []
  s.onEvent((e) => events.push(e))
  return { store: s, events }
}

function seed(runId: string, over: Partial<RunManifest> = {}): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  const manifest: RunManifest = {
    runId,
    feature: 'storefront-journey',
    startedAt: '2026-10-09T05:59:00.000Z',
    status: 'healing',
    healCycles: 1,
    services: [{ name: 'api', safeName: 'api', command: 'x', cwd: '/', status: 'ready', logPath: '/x.log' }],
    heartbeatAt: new Date().toISOString(),
    ...over,
  }
  writeManifest(path.join(dir, 'manifest.json'), manifest)
  writeRunsIndex(logsDir, [
    ...readRunsIndex(logsDir).filter((e) => e.runId !== runId),
    { runId, feature: manifest.feature, startedAt: manifest.startedAt, status: manifest.status },
  ])
}

const manifestOf = (s: RunStore, runId: string) => readManifest(s.manifestPath(runId))!
const staleBeat = () => new Date(Date.now() - HEARTBEAT_STALE_MS - 1_000).toISOString()

describe('boot reconcile (abortAllActiveOrStale)', () => {
  it('settles a fresh healing run whose signing server exited, and says why', async () => {
    seed('2026-10-09T0559-ulr5', { heartbeatOwner: DEAD })
    const { store: s } = store()

    expect(await s.abortAllActiveOrStale()).toEqual({ aborted: ['2026-10-09T0559-ulr5'] })

    const m = manifestOf(s, '2026-10-09T0559-ulr5')
    expect(m.status).toBe('aborted')
    expect(m.services[0].status).toBe('stopped')
    expect(readRunsIndex(logsDir)[0].status).toBe('aborted')
    expect(m.lifecycle).toMatchObject({
      phase: 'aborted',
      headline: 'Run aborted — its Canary Lab server stopped',
      detail: expect.stringContaining('Restart the run'),
      abortReason: { reason: 'server-exited' },
    })
    const events = fs.readFileSync(buildRunPaths(runDirFor(logsDir, '2026-10-09T0559-ulr5')).lifecycleEventsPath, 'utf-8')
    expect(JSON.parse(events.trim().split('\n').at(-1)!)).toMatchObject({ phase: 'aborted', severity: 'warning' })
  })

  it('spares a run a live peer server drives', async () => {
    seed('peer-run', { heartbeatOwner: PEER })
    const { store: s } = store()

    expect(await s.abortAllActiveOrStale()).toEqual({ aborted: [] })
    expect(manifestOf(s, 'peer-run').status).toBe('healing')
  })

  it('claims a row this server signed: at boot it is a previous life, at shutdown a vanishing queue slot', async () => {
    seed('my-queued', { status: 'queued', heartbeatOwner: SELF })
    const { store: s } = store()

    expect(await s.abortAllActiveOrStale()).toEqual({ aborted: ['my-queued'] })
    expect(manifestOf(s, 'my-queued').status).toBe('aborted')
  })

  it('settles a boot-only session as calmly stopped services, with no abort reason', async () => {
    seed('boot-run', { status: 'running', executionType: 'boot', heartbeatOwner: DEAD })
    const { store: s } = store()

    await s.abortAllActiveOrStale()

    const lifecycle = manifestOf(s, 'boot-run').lifecycle!
    expect(lifecycle).toMatchObject({ phase: 'aborted', headline: 'Services stopped', detail: expect.stringContaining('server holding these services exited') })
    expect(lifecycle.abortReason).toBeUndefined()
  })
})

describe('settleIfOrphaned', () => {
  it('settles an orphan once and publishes the change to subscribers', () => {
    seed('orphan', { heartbeatOwner: DEAD })
    const { store: s, events } = store()

    expect(s.settleIfOrphaned('orphan')).toBe(true)
    expect(manifestOf(s, 'orphan').status).toBe('aborted')
    expect(events).toEqual([{ kind: 'finalized', runId: 'orphan' }, { kind: 'changed', runId: 'orphan' }])
    // Now terminal: a second action finds nothing to settle.
    expect(s.settleIfOrphaned('orphan')).toBe(false)
  })

  it('leaves a run that something still drives', () => {
    const registry = createRegistry()
    registry.set('registered', { runId: 'registered' } as unknown as OrchestratorLike)
    seed('registered', { heartbeatOwner: DEAD })
    seed('peer', { heartbeatOwner: PEER })
    seed('my-queue-slot', { status: 'queued', heartbeatOwner: SELF })
    const { store: s, events } = store(registry)

    expect(s.settleIfOrphaned('registered')).toBe(false)
    expect(s.settleIfOrphaned('peer')).toBe(false)
    expect(s.settleIfOrphaned('my-queue-slot')).toBe(false)
    expect(events).toEqual([])
  })

  it('acts only on positive evidence of death: never on a terminal, unknown or heartbeat-less row', () => {
    seed('done', { status: 'failed', heartbeatOwner: DEAD })
    seed('legacy', { heartbeatAt: undefined })
    const { store: s } = store()

    expect(s.settleIfOrphaned('done')).toBe(false)
    expect(s.settleIfOrphaned('legacy')).toBe(false)
    expect(s.settleIfOrphaned('never-existed')).toBe(false)
    expect(manifestOf(s, 'legacy').status).toBe('healing')
  })

  it('settles an unsigned row only once its heartbeat goes stale', () => {
    seed('unsigned-fresh')
    seed('unsigned-stale', { heartbeatAt: staleBeat() })
    const { store: s } = store()

    expect(s.settleIfOrphaned('unsigned-fresh')).toBe(false)
    expect(s.settleIfOrphaned('unsigned-stale')).toBe(true)
  })
})

describe('settleOrphanedRuns (the running server sweep)', () => {
  it('catches a peer server that dies after boot reconcile spared its run', async () => {
    seed('peer-run', { heartbeatOwner: PEER })
    seed('settled', { status: 'passed', heartbeatOwner: DEAD })
    const { store: s } = store()
    await s.abortAllActiveOrStale()
    expect(s.settleOrphanedRuns()).toEqual([])

    livePids.delete(PEER.pid)

    expect(s.settleOrphanedRuns()).toEqual(['peer-run'])
    expect(manifestOf(s, 'peer-run').status).toBe('aborted')
    expect(manifestOf(s, 'settled').status).toBe('passed')
  })
})

describe('abort on a row nobody registered', () => {
  it('records the server exit when the owner is gone', async () => {
    seed('orphan', { heartbeatOwner: DEAD })
    const { store: s } = store()

    expect(await s.abort('orphan')).toEqual({ ok: true })
    expect(manifestOf(s, 'orphan').lifecycle?.abortReason).toEqual({ reason: 'server-exited' })
  })

  it('records a plain stop when a live peer still drove it', async () => {
    seed('peer-run', { heartbeatOwner: PEER })
    const { store: s } = store()

    expect(await s.abort('peer-run')).toEqual({ ok: true })
    const lifecycle = manifestOf(s, 'peer-run').lifecycle!
    expect(lifecycle).toMatchObject({ headline: 'Run aborted', abortReason: { reason: 'run-stopped' } })
    expect(lifecycle.detail).toBeUndefined()
  })
})

it('names the recovery in the message actions return', () => {
  expect(SERVER_EXITED_MESSAGE).toMatch(/server driving this run stopped.*aborted.*Restart/)
})
