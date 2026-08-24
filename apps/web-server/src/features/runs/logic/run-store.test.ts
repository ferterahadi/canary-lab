import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { listRuns, reapStaleRuns, renameRunFeature, readRunSummary, RunStore, type RunStoreEvent } from './run-store'
import { createRegistry } from './run-registry'

import { readManifest, writeManifest, writeRunsIndex, readRunsIndex } from './runtime/manifest'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import { HEARTBEAT_STALE_MS } from '../../../../../../shared/run-state'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rs-')))
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

  it('backfills healCycles from the manifest for entries written before it was mirrored', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'healed', feature: 'foo', startedAt: '2026-01-03T00:00:00Z', status: 'failed' },
      { runId: 'clean', feature: 'foo', startedAt: '2026-01-02T00:00:00Z', status: 'passed' },
      { runId: 'gone', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
    ])
    const manifest = (runId: string, healCycles: number) => {
      const dir = runDirFor(tmpDir, runId)
      fs.mkdirSync(dir, { recursive: true })
      writeManifest(path.join(dir, 'manifest.json'), {
        runId, feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed', healCycles, services: [],
      })
    }
    manifest('healed', 4)
    manifest('clean', 0)
    const byId = Object.fromEntries(listRuns(tmpDir).map((e) => [e.runId, e.healCycles]))
    expect(byId.healed).toBe(4)
    // A run that never healed and one whose directory has been cleaned away both
    // stay absent — nothing is invented to fill the column.
    expect(byId.clean).toBeUndefined()
    expect(byId.gone).toBeUndefined()
  })

  it('backfills external repair ownership from a legacy index row', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'external', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
    ])
    const dir = runDirFor(tmpDir, 'external')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'external', feature: 'foo', startedAt: '2026-01-01T00:00:00Z',
      status: 'passed', healCycles: 1, healMode: 'external', services: [],
    })

    expect(listRuns(tmpDir)[0]).toMatchObject({ healCycles: 1, healMode: 'external' })
  })

  it('leaves an already-mirrored healCycles alone instead of re-reading the manifest', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'failed', healCycles: 2 },
    ])
    expect(listRuns(tmpDir)[0].healCycles).toBe(2)
  })

  it('treats equal startedAt deterministically', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'failed' },
    ])
    const ids = listRuns(tmpDir).map((e) => e.runId)
    expect(ids.sort()).toEqual(['a', 'b'])
  })

  it('keeps already-newer entries before older entries', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'newer', feature: 'foo', startedAt: '2026-02-01T00:00:00Z', status: 'passed' },
      { runId: 'older', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'failed' },
    ])
    expect(listRuns(tmpDir).map((e) => e.runId)).toEqual(['newer', 'older'])
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
      heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1).toISOString(),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'stale-untouched', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    const result = listRuns(tmpDir)
    expect(result[0].status).toBe('running')
    expect(readManifest(path.join(dir, 'manifest.json'))?.status).toBe('running')
  })
})

describe('renameRunFeature', () => {
  function writeRun(runId: string, feature: string): string {
    const dir = runDirFor(tmpDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    const manifestPath = path.join(dir, 'manifest.json')
    writeManifest(manifestPath, {
      runId,
      feature,
      startedAt: '2026-01-01T00:00:00Z',
      status: 'passed',
      healCycles: 0,
      services: [],
    })
    return manifestPath
  }

  it('rewrites the feature in the index and in every matching manifest', () => {
    const a = writeRun('a', 'old')
    const b = writeRun('b', 'other')
    const c = writeRun('c', 'old')
    writeRunsIndex(tmpDir, [
      { runId: 'a', feature: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'other', startedAt: '2026-01-02T00:00:00Z', status: 'passed' },
      { runId: 'c', feature: 'old', startedAt: '2026-01-03T00:00:00Z', status: 'passed' },
    ])

    expect(renameRunFeature(tmpDir, 'old', 'new')).toBe(2)

    expect(readRunsIndex(tmpDir).map((e) => e.feature).sort()).toEqual(['new', 'new', 'other'])
    expect(readManifest(a)?.feature).toBe('new')
    expect(readManifest(c)?.feature).toBe('new')
    expect(readManifest(b)?.feature).toBe('other')
    expect(listRuns(tmpDir, { feature: 'new' }).map((e) => e.runId)).toEqual(['c', 'a'])
  })

  it('is a no-op with no index, no match, or from === to', () => {
    expect(renameRunFeature(tmpDir, 'old', 'new')).toBe(0)
    writeRunsIndex(tmpDir, [
      { runId: 'a', feature: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
    ])
    expect(renameRunFeature(tmpDir, 'absent', 'new')).toBe(0)
    expect(renameRunFeature(tmpDir, 'old', 'old')).toBe(0)
    expect(readRunsIndex(tmpDir)[0].feature).toBe('old')
  })

  it('still rewrites the index row when the run directory is gone', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'ghost', feature: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
    ])
    expect(renameRunFeature(tmpDir, 'old', 'new')).toBe(1)
    expect(readRunsIndex(tmpDir)[0].feature).toBe('new')
  })
})

describe('RunStore', () => {
  // Helper: create a run dir + manifest + index entry so the store has
  // something to read/mutate.
  function seedRun(runId: string, overrides: Partial<{
    status: 'running' | 'passed' | 'failed' | 'aborted' | 'healing'
    feature: string
    healCycles: number
    healMode: 'auto' | 'manual' | 'external'
    services: NonNullable<ReturnType<typeof readManifest>>['services']
    heartbeatAt: string
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
      ...(overrides.healMode ? { healMode: overrides.healMode } : {}),
      ...(overrides.heartbeatAt ? { heartbeatAt: overrides.heartbeatAt } : {}),
    })
    writeRunsIndex(tmpDir, [
      ...readRunsIndex(tmpDir).filter((e) => e.runId !== runId),
      { runId, feature, startedAt: '2026-01-01T00:00:00Z', status },
    ])
    return dir
  }

  // ─── cleanup: trim artifacts / orphan delete / listing ────────────────

  function seedArtifacts(runId: string, bytesEach: number): void {
    const paths = buildRunPaths(runDirFor(tmpDir, runId))
    for (const dir of [paths.playwrightArtifactsDir, paths.playwrightArtifactsKeepDir]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'video.webm'), Buffer.alloc(bytesEach))
    }
  }

  function fakeOrch(runId: string) {
    return {
      runId,
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    }
  }

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

  it('clears stale running state from the summary when abort finalizes a run', async () => {
    const reg = createRegistry()
    const dir = seedRun('r1', { status: 'running' })
    fs.writeFileSync(
      path.join(dir, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 2,
        passed: 1,
        passedNames: ['test-case-a'],
        running: { name: 'test-case-b', location: '/b.spec.ts:10' },
        failed: [],
      }, null, 2),
    )
    reg.set('r1', {
      runId: 'r1',
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })

    const store = new RunStore(tmpDir, reg)
    expect(await store.abort('r1')).toEqual({ ok: true })

    expect(readRunSummary(dir)).toEqual({
      complete: false,
      total: 2,
      passed: 1,
      passedNames: ['test-case-a'],
      failed: [],
    })
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

  it('abort finalizes a persisted running entry that has no manifest', async () => {
    // An interrupted boot run leaves an active index entry but no manifest, so
    // get() returns null. abort must still flip the index terminal — otherwise
    // the UI Stop button is a silent no-op against an unstoppable zombie.
    writeRunsIndex(tmpDir, [
      { runId: 'no-manifest', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))

    expect(await store.abort('no-manifest')).toEqual({ ok: true })

    const indexed = readRunsIndex(tmpDir).find((e) => e.runId === 'no-manifest')!
    expect(indexed.status).toBe('aborted')
    expect(indexed.endedAt).toBeTruthy()
    expect(events.some((e) => e.kind === 'finalized')).toBe(true)
  })

  it('abort still reports not-active for an unknown run with no manifest or index entry', async () => {
    const store = new RunStore(tmpDir, createRegistry())
    expect(await store.abort('ghost')).toEqual({ ok: false, reason: 'not-active' })
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

  it('abortAllActiveOrStale leaves an unregistered active row alone while its heartbeat is fresh', async () => {
    // The incident this guard exists for: a second server booting against the
    // same logs dir marked a live healing run `aborted`. It could not stop the
    // real heal loop (that lives in the owning process), so the run kept
    // repairing while every disk reader was told it had ended.
    seedRun('owned-elsewhere', { status: 'healing', heartbeatAt: new Date().toISOString() })
    const store = new RunStore(tmpDir, createRegistry())

    expect(await store.abortAllActiveOrStale()).toEqual({ aborted: [] })
    expect(readManifest(store.manifestPath('owned-elsewhere'))?.status).toBe('healing')
    expect(readRunsIndex(tmpDir)[0].status).toBe('healing')
  })

  it('abortAllActiveOrStale still finalizes an unregistered active row once its heartbeat goes stale', async () => {
    // Negative control for the guard above — without this the guard could be a
    // blanket "never touch active rows" and the test above would still pass.
    seedRun('really-dead', {
      status: 'healing',
      heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1_000).toISOString(),
    })
    const store = new RunStore(tmpDir, createRegistry())

    expect(await store.abortAllActiveOrStale()).toEqual({ aborted: ['really-dead'] })
    expect(readManifest(store.manifestPath('really-dead'))?.status).toBe('aborted')
  })

  it('abortAllActiveOrStale stops a registered run even when its heartbeat is fresh', async () => {
    // The guard is scoped to rows this process does NOT own. Shutdown aborts
    // our own orchestrators, whose heartbeats are fresh by definition, so a
    // guard applied to both loops would leave every run running at exit.
    const reg = createRegistry()
    let stopped = false
    seedRun('mine', { status: 'healing', heartbeatAt: new Date().toISOString() })
    reg.set('mine', {
      runId: 'mine',
      stop: async () => { stopped = true },
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })
    const store = new RunStore(tmpDir, reg)

    expect(await store.abortAllActiveOrStale()).toEqual({ aborted: ['mine'] })
    expect(stopped).toBe(true)
  })

  it('abortAllActiveOrStale finalizes indexed active rows even when persisted detail is missing', async () => {
    // A manifest-less active row (interrupted boot run) must still be recovered
    // on shutdown cleanup — otherwise it stays a permanently-running zombie no
    // restart can clear.
    writeRunsIndex(tmpDir, [
      { runId: 'missing-detail', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    const store = new RunStore(tmpDir, createRegistry())

    expect(await store.abortAllActiveOrStale()).toEqual({ aborted: ['missing-detail'] })
    expect(readRunsIndex(tmpDir)[0].status).toBe('aborted')
  })

  it('abortAllActiveOrStale aborts registered runs even when persisted detail is missing', async () => {
    const reg = createRegistry()
    let stopped = false
    reg.set('missing-registered', {
      runId: 'missing-registered',
      stop: async () => { stopped = true },
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })
    const store = new RunStore(tmpDir, reg)

    expect(await store.abortAllActiveOrStale()).toEqual({ aborted: ['missing-registered'] })
    expect(stopped).toBe(true)
    expect(reg.get('missing-registered')).toBeUndefined()
  })

  it('abortAllActiveOrStale skips an index row whose manifest already finalized', async () => {
    // Index still claims 'running' but the on-disk manifest is terminal and no
    // orchestrator is registered → abort() returns ok:false, so it is not
    // counted as aborted (the false branch of the result.ok guard).
    const dir = runDirFor(tmpDir, 'already-done')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'already-done',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'passed',
      healCycles: 0,
      services: [],
    })
    writeRunsIndex(tmpDir, [
      { runId: 'already-done', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    const store = new RunStore(tmpDir, createRegistry())
    expect(await store.abortAllActiveOrStale()).toEqual({ aborted: [] })
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

  it('removeFromHistory returns false without emitting when no run is removed', () => {
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.onEvent((event) => events.push(event))

    expect(store.removeFromHistory('missing')).toBe(false)
    expect(events).toEqual([])
  })

  it('removeFromHistory emits removed when a run is removed', () => {
    seedRun('remove-direct', { status: 'failed' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.onEvent((event) => events.push(event))

    expect(store.removeFromHistory('remove-direct')).toBe(true)
    expect(fs.existsSync(runDirFor(tmpDir, 'remove-direct'))).toBe(false)
    expect(events).toEqual([{ kind: 'removed', runId: 'remove-direct' }])
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
      heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1).toISOString(),
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
})
