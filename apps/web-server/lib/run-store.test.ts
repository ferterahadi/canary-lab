import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createRegistry,
  listRuns,
  reapStaleRuns,
  removeRunFromHistory,
  getRunDetail,
  readRunSummary,
  RunStore,
  type RunStoreEvent,
} from './run-store'
import { readManifest, writeManifest, writeRunsIndex, readRunsIndex } from './runtime/manifest'
import { runDirFor } from './runtime/run-paths'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rs-')))
})

describe('createRegistry', () => {
  it('round-trips orchestrator-like values', () => {
    const reg = createRegistry()
    const stub = {
      runId: 'r1',
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    }
    reg.set('r1', stub)
    expect(reg.get('r1')).toBe(stub)
    expect(reg.list()).toEqual([stub])
    expect(reg.delete('r1')).toBe(true)
    expect(reg.get('r1')).toBeUndefined()
    expect(reg.delete('r1')).toBe(false)
  })
})

describe('listRuns', () => {
  it('returns [] when index missing', () => {
    expect(listRuns(tmpDir)).toEqual([])
  })

  it('returns entries newest first', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'bar', startedAt: '2026-02-01T00:00:00Z', status: 'failed' },
      { runId: 'c', feature: 'foo', startedAt: '2026-03-01T00:00:00Z', status: 'running' },
    ])
    expect(listRuns(tmpDir).map((e) => e.runId)).toEqual(['c', 'b', 'a'])
  })

  it('filters by feature', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'bar', startedAt: '2026-02-01T00:00:00Z', status: 'failed' },
    ])
    expect(listRuns(tmpDir, { feature: 'bar' }).map((e) => e.runId)).toEqual(['b'])
  })

  it('treats equal startedAt deterministically', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'failed' },
    ])
    const ids = listRuns(tmpDir).map((e) => e.runId)
    expect(ids.sort()).toEqual(['a', 'b'])
  })

  it('does not mutate manifests for stale running entries (cleanup is reapStaleRuns'
    + "'s job)", () => {
    const dir = runDirFor(tmpDir, 'stale-untouched')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'stale-untouched',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'stale-untouched', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    const result = listRuns(tmpDir)
    expect(result[0].status).toBe('running')
    expect(readManifest(path.join(dir, 'manifest.json'))?.status).toBe('running')
  })
})

describe('reapStaleRuns', () => {
  it('marks stale running entry as aborted when no registry', async () => {
    const dir = runDirFor(tmpDir, 'stale-1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'stale-1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'stale-1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    await reapStaleRuns(tmpDir)
    const manifest = readManifest(path.join(dir, 'manifest.json'))
    expect(manifest?.status).toBe('aborted')
    const indexed = listRuns(tmpDir)
    expect(indexed[0].status).toBe('aborted')
    expect(indexed[0].endedAt).toBeDefined()
  })

  it('leaves running entry alone when heartbeat is fresh', async () => {
    const dir = runDirFor(tmpDir, 'fresh-1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'fresh-1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date().toISOString(),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'fresh-1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    await reapStaleRuns(tmpDir)
    expect(listRuns(tmpDir)[0].status).toBe('running')
  })

  it('leaves entry alone when manifest has no heartbeatAt (legacy manifest)', async () => {
    const dir = runDirFor(tmpDir, 'legacy-1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'legacy-1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      // intentionally no heartbeatAt
    })
    writeRunsIndex(tmpDir, [
      { runId: 'legacy-1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    await reapStaleRuns(tmpDir)
    expect(listRuns(tmpDir)[0].status).toBe('running')
    expect(readManifest(path.join(dir, 'manifest.json'))?.status).toBe('running')
  })

  it('stops and removes dead orchestrator from registry when heartbeat is stale', async () => {
    const reg = createRegistry()
    let stopped = false
    const stub = {
      runId: 'dead-1',
      stop: async () => { stopped = true },
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    }
    reg.set('dead-1', stub)

    const dir = runDirFor(tmpDir, 'dead-1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'dead-1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'dead-1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    await reapStaleRuns(tmpDir, reg)
    expect(listRuns(tmpDir)[0].status).toBe('aborted')
    expect(stopped).toBe(true)
    expect(reg.get('dead-1')).toBeUndefined()
  })

  it('skips entries that are not running or healing', async () => {
    writeRunsIndex(tmpDir, [
      { runId: 'done', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
    ])
    await reapStaleRuns(tmpDir)
    expect(listRuns(tmpDir)[0].status).toBe('passed')
  })

  it('skips entries whose manifest cannot be read', async () => {
    // Index entry exists but no manifest file on disk → readManifest returns null.
    writeRunsIndex(tmpDir, [
      { runId: 'no-manifest', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    await reapStaleRuns(tmpDir)
    expect(listRuns(tmpDir)[0].status).toBe('running')
  })

  it('skips entries with non-parseable heartbeatAt', async () => {
    const dir = runDirFor(tmpDir, 'nan-1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'nan-1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: 'not-a-real-date',
    })
    writeRunsIndex(tmpDir, [
      { runId: 'nan-1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    await reapStaleRuns(tmpDir)
    expect(listRuns(tmpDir)[0].status).toBe('running')
  })

  it('swallows errors thrown by orchestrator.stop', async () => {
    const reg = createRegistry()
    reg.set('boom-1', {
      runId: 'boom-1',
      stop: async () => { throw new Error('stop failed') },
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })
    const dir = runDirFor(tmpDir, 'boom-1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'boom-1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'healing',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'boom-1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'healing' },
    ])
    await reapStaleRuns(tmpDir, reg)
    expect(listRuns(tmpDir)[0].status).toBe('aborted')
    expect(reg.get('boom-1')).toBeUndefined()
  })

  it('does not stop orchestrator from registry when heartbeat is fresh', async () => {
    const reg = createRegistry()
    let stopped = false
    const stub = {
      runId: 'alive-1',
      stop: async () => { stopped = true },
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    }
    reg.set('alive-1', stub)

    const dir = runDirFor(tmpDir, 'alive-1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'alive-1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date().toISOString(),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'alive-1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    await reapStaleRuns(tmpDir, reg)
    expect(listRuns(tmpDir)[0].status).toBe('running')
    expect(stopped).toBe(false)
    expect(reg.get('alive-1')).toBe(stub)
  })
})

describe('removeRunFromHistory', () => {
  it('drops the index entry and recursively deletes the run dir', () => {
    const dir = runDirFor(tmpDir, 'r-rm-1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'svc-foo.log'), 'x')
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r-rm-1', feature: 'foo', startedAt: 'now', status: 'passed', healCycles: 0, services: [],
    })
    writeRunsIndex(tmpDir, [
      { runId: 'r-rm-1', feature: 'foo', startedAt: 'now', status: 'passed' },
      { runId: 'keep', feature: 'foo', startedAt: 'now', status: 'passed' },
    ])
    expect(removeRunFromHistory(tmpDir, 'r-rm-1')).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
    const remaining = listRuns(tmpDir).map((e) => e.runId)
    expect(remaining).toEqual(['keep'])
  })

  it('returns false when nothing matches', () => {
    expect(removeRunFromHistory(tmpDir, 'no-such')).toBe(false)
  })

  it('returns true when only the dir exists (no index entry)', () => {
    const dir = runDirFor(tmpDir, 'orphan-dir')
    fs.mkdirSync(dir, { recursive: true })
    expect(removeRunFromHistory(tmpDir, 'orphan-dir')).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('returns true when only the index entry exists (no dir)', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'orphan-idx', feature: 'foo', startedAt: 'now', status: 'passed' },
    ])
    expect(removeRunFromHistory(tmpDir, 'orphan-idx')).toBe(true)
    expect(listRuns(tmpDir)).toEqual([])
  })
})

describe('getRunDetail', () => {
  it('returns null when run dir missing', () => {
    expect(getRunDetail(tmpDir, 'nonsuch')).toBeNull()
  })

  it('returns null when manifest unreadable', () => {
    const dir = runDirFor(tmpDir, 'corrupt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{not json')
    expect(getRunDetail(tmpDir, 'corrupt')).toBeNull()
  })

  it('reads a valid manifest', () => {
    const dir = runDirFor(tmpDir, 'r1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r1',
      feature: 'foo',
      startedAt: 'now',
      status: 'passed',
      healCycles: 0,
      services: [],
    })
    const d = getRunDetail(tmpDir, 'r1')
    expect(d?.runId).toBe('r1')
    expect(d?.manifest.feature).toBe('foo')
    expect(d?.summary).toBeUndefined()
  })

  it('includes summary when e2e-summary.json exists alongside manifest', () => {
    const dir = runDirFor(tmpDir, 'r-sum')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r-sum',
      feature: 'foo',
      startedAt: 'now',
      status: 'failed',
      healCycles: 0,
      services: [],
    })
    fs.writeFileSync(
      path.join(dir, 'e2e-summary.json'),
      JSON.stringify({
        complete: true,
        total: 2,
        passed: 1,
        failed: [{ name: 'test-case-x', error: { message: 'boom' } }],
      }),
    )
    const d = getRunDetail(tmpDir, 'r-sum')
    expect(d?.summary?.complete).toBe(true)
    expect(d?.summary?.failed[0].name).toBe('test-case-x')
  })
})

describe('readRunSummary', () => {
  it('returns undefined when summary file missing', () => {
    expect(readRunSummary(tmpDir)).toBeUndefined()
  })

  it('returns undefined when summary file is unparseable', () => {
    fs.writeFileSync(path.join(tmpDir, 'e2e-summary.json'), '{not json')
    expect(readRunSummary(tmpDir)).toBeUndefined()
  })

  it('returns undefined when summary parses to a non-object', () => {
    fs.writeFileSync(path.join(tmpDir, 'e2e-summary.json'), 'null')
    expect(readRunSummary(tmpDir)).toBeUndefined()
  })

  it('returns parsed summary on a valid file', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'e2e-summary.json'),
      JSON.stringify({ complete: false, total: 0, passed: 0, failed: [] }),
    )
    expect(readRunSummary(tmpDir)).toEqual({ complete: false, total: 0, passed: 0, failed: [] })
  })
})

describe('RunStore', () => {
  // Helper: create a run dir + manifest + index entry so the store has
  // something to read/mutate.
  function seedRun(runId: string, overrides: Partial<{
    status: 'running' | 'passed' | 'failed' | 'aborted' | 'healing'
    feature: string
    healCycles: number
    services: NonNullable<ReturnType<typeof readManifest>>['services']
  }> = {}): string {
    const dir = runDirFor(tmpDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    const status = overrides.status ?? 'running'
    const feature = overrides.feature ?? 'foo'
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature,
      startedAt: '2026-01-01T00:00:00Z',
      status,
      healCycles: overrides.healCycles ?? 0,
      services: overrides.services ?? [],
    })
    writeRunsIndex(tmpDir, [
      ...readRunsIndex(tmpDir).filter((e) => e.runId !== runId),
      { runId, feature, startedAt: '2026-01-01T00:00:00Z', status },
    ])
    return dir
  }

  it('list and get delegate to standalone helpers', () => {
    seedRun('r1', { status: 'passed' })
    const store = new RunStore(tmpDir, createRegistry())
    expect(store.list().map((e) => e.runId)).toEqual(['r1'])
    expect(store.get('r1')?.manifest.status).toBe('passed')
    expect(store.get('missing')).toBeNull()
  })

  it('bootstrap writes manifest, index, and current symlink, then emits', () => {
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    store.bootstrap({
      runId: 'rb1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
    })
    const dir = runDirFor(tmpDir, 'rb1')
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true)
    expect(readRunsIndex(tmpDir).find((e) => e.runId === 'rb1')?.status).toBe('running')
    expect(events).toEqual([{ kind: 'bootstrap', runId: 'rb1' }])
  })

  it('setStatus mirrors status into both manifest and index, and emits changed', () => {
    seedRun('r1', { status: 'running' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    store.setStatus('r1', 'healing', 2)
    expect(readManifest(store.manifestPath('r1'))?.status).toBe('healing')
    expect(readManifest(store.manifestPath('r1'))?.healCycles).toBe(2)
    expect(readRunsIndex(tmpDir).find((e) => e.runId === 'r1')?.status).toBe('healing')
    expect(events).toEqual([{ kind: 'changed', runId: 'r1' }])
  })

  it('finalize flips services to stopped, writes endedAt, and emits finalized', () => {
    const dir = seedRun('r1', { status: 'running' })
    // Add a service entry so updateAllServicesStatus has something to flip.
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 1,
      services: [{ name: 'api', safeName: 'api', command: 'x', cwd: '/', status: 'ready', logPath: '/x.log' }],
    })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    store.finalize('r1', 'aborted', '2026-01-01T00:05:00Z', 1)
    const m = readManifest(store.manifestPath('r1'))!
    expect(m.status).toBe('aborted')
    expect(m.endedAt).toBe('2026-01-01T00:05:00Z')
    expect(m.services[0].status).toBe('stopped')
    const indexed = readRunsIndex(tmpDir).find((e) => e.runId === 'r1')!
    expect(indexed.status).toBe('aborted')
    expect(indexed.endedAt).toBe('2026-01-01T00:05:00Z')
    expect(events).toEqual([{ kind: 'finalized', runId: 'r1' }])
  })

  it('recordHeartbeat writes the timestamp WITHOUT emitting (would flood subscribers)', () => {
    seedRun('r1')
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    store.recordHeartbeat('r1')
    expect(readManifest(store.manifestPath('r1'))?.heartbeatAt).toBeTruthy()
    expect(events).toEqual([])
  })

  it('abort calls orch.stop and removes from registry; 404s when not active', async () => {
    const reg = createRegistry()
    let stopped = false
    reg.set('r1', {
      runId: 'r1',
      stop: async () => { stopped = true },
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })
    const store = new RunStore(tmpDir, reg)
    expect(await store.abort('r1')).toEqual({ ok: true })
    expect(stopped).toBe(true)
    expect(reg.get('r1')).toBeUndefined()
    expect(await store.abort('ghost')).toEqual({ ok: false, reason: 'not-active' })
  })

  it('abort finalizes a registered run when the orchestrator stop path does not', async () => {
    const reg = createRegistry()
    seedRun('r1', {
      status: 'running',
      services: [{ name: 'api', safeName: 'api', command: 'x', cwd: '/', status: 'ready', logPath: '/x.log' }],
    })
    reg.set('r1', {
      runId: 'r1',
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })
    const store = new RunStore(tmpDir, reg)
    expect(await store.abort('r1')).toEqual({ ok: true })
    const manifest = readManifest(store.manifestPath('r1'))!
    expect(manifest.status).toBe('aborted')
    expect(manifest.endedAt).toBeTruthy()
    expect(manifest.services[0].status).toBe('stopped')
    expect(readRunsIndex(tmpDir)[0].status).toBe('aborted')
  })

  it('abort finalizes an orphaned persisted running run and emits finalized', async () => {
    seedRun('orphan', {
      status: 'running',
      services: [{ name: 'api', safeName: 'api', command: 'x', cwd: '/', status: 'ready', logPath: '/x.log' }],
    })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))

    expect(await store.abort('orphan')).toEqual({ ok: true })

    const manifest = readManifest(store.manifestPath('orphan'))!
    expect(manifest.status).toBe('aborted')
    expect(manifest.endedAt).toBeTruthy()
    expect(manifest.services[0].status).toBe('stopped')
    const indexed = readRunsIndex(tmpDir).find((e) => e.runId === 'orphan')!
    expect(indexed.status).toBe('aborted')
    expect(indexed.endedAt).toBe(manifest.endedAt)
    expect(events).toEqual([{ kind: 'finalized', runId: 'orphan' }])
  })

  it('abortAllActiveOrStale stops registered runs and finalizes orphaned active rows', async () => {
    const reg = createRegistry()
    const stopped: string[] = []
    seedRun('registered', { status: 'running' })
    seedRun('orphan', { status: 'healing' })
    seedRun('done', { status: 'passed' })
    reg.set('registered', {
      runId: 'registered',
      stop: async () => { stopped.push('registered') },
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })
    const store = new RunStore(tmpDir, reg)

    const result = await store.abortAllActiveOrStale()

    expect(result.aborted.sort()).toEqual(['orphan', 'registered'])
    expect(stopped).toEqual(['registered'])
    expect(reg.get('registered')).toBeUndefined()
    expect(readManifest(store.manifestPath('registered'))?.status).toBe('aborted')
    expect(readManifest(store.manifestPath('orphan'))?.status).toBe('aborted')
    expect(readManifest(store.manifestPath('done'))?.status).toBe('passed')
  })

  it('delete refuses active runs (registered) and stale-active manifests', () => {
    const reg = createRegistry()
    reg.set('active', {
      runId: 'active',
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })
    seedRun('active', { status: 'running' })
    seedRun('stale', { status: 'running' })
    seedRun('done', { status: 'passed' })
    const store = new RunStore(tmpDir, reg)
    expect(store.delete('active')).toEqual({ ok: false, reason: 'active' })
    expect(store.delete('stale')).toEqual({ ok: false, reason: 'stale' })
    expect(store.delete('ghost')).toEqual({ ok: false, reason: 'not-found' })
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    expect(store.delete('done')).toEqual({ ok: true })
    expect(fs.existsSync(runDirFor(tmpDir, 'done'))).toBe(false)
    expect(events).toEqual([{ kind: 'removed', runId: 'done' }])
  })

  it('reapStale flips stale entries to aborted and emits index-changed exactly once', async () => {
    const dir = runDirFor(tmpDir, 'stale')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'stale',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'stale', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    await store.reapStale()
    expect(readRunsIndex(tmpDir)[0].status).toBe('aborted')
    expect(events).toEqual([{ kind: 'index-changed' }])
  })

  it('reapStale does not emit when nothing changes', async () => {
    seedRun('healthy', { status: 'passed' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    await store.reapStale()
    expect(events).toEqual([])
  })

  it('setServiceStatus mutates the named service and emits changed', () => {
    const dir = runDirFor(tmpDir, 'r1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [{ name: 'api', safeName: 'api', command: 'x', cwd: '/', status: 'starting', logPath: '/x.log' }],
    })
    writeRunsIndex(tmpDir, [
      { runId: 'r1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    store.setServiceStatus('r1', 'api', 'ready')
    const m = readManifest(store.manifestPath('r1'))!
    expect(m.services[0].status).toBe('ready')
    expect(events).toEqual([{ kind: 'changed', runId: 'r1' }])
  })
})
