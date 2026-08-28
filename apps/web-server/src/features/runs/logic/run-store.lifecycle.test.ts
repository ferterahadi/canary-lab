import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { trimRunArtifacts, getRunDetail, RunStore, type RunStoreEvent } from './run-store'
import { createRegistry } from './run-registry'
import { readManifest, writeManifest, writeRunsIndex, readRunsIndex } from './runtime/manifest'
import { buildRunPaths, runDirFor } from './runtime/run-paths'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rs-')))
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

  it('list and get delegate to standalone helpers', () => {
    seedRun('r1', { status: 'passed' })
    const store = new RunStore(tmpDir, createRegistry())
    expect(store.list().map((e) => e.runId)).toEqual(['r1'])
    expect(store.get('r1')?.manifest.status).toBe('passed')
    expect(store.get('missing')).toBeNull()
  })

  it('bootstrap writes manifest and index, then emits', () => {
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

  it('onEvent and offEvent subscribe and unsubscribe typed event listeners', () => {
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    const listener = (event: RunStoreEvent) => events.push(event)

    expect(store.onEvent(listener)).toBe(store)
    store.bootstrap({
      runId: 'r-on-off-1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
    })
    expect(events).toEqual([{ kind: 'bootstrap', runId: 'r-on-off-1' }])

    expect(store.offEvent(listener)).toBe(store)
    store.setStatus('r-on-off-1', 'passed')
    expect(events).toEqual([{ kind: 'bootstrap', runId: 'r-on-off-1' }])
  })

  it('patchManifest applies partial manifest updates and emits changed', () => {
    seedRun('r-patch-1', { status: 'running' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.onEvent((event) => events.push(event))

    store.patchManifest('r-patch-1', { status: 'healing', healCycles: 3 })

    const manifest = readManifest(store.manifestPath('r-patch-1'))!
    expect(manifest.status).toBe('healing')
    expect(manifest.healCycles).toBe(3)
    expect(events).toEqual([{ kind: 'changed', runId: 'r-patch-1' }])
  })

  it('recordLifecycleEvent appends lifecycle, mirrors manifest snapshot, and emits changed', () => {
    const dir = seedRun('r-life-1', { status: 'running' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.onEvent((event) => events.push(event))

    store.recordLifecycleEvent('r-life-1', {
      phase: 'restarting-services',
      headline: 'Restart plan ready',
      updatedAt: '2026-05-08T00:00:05.000Z',
      restartPlan: { restarted: ['api'], kept: ['ngrok'], startedBecauseMissing: ['ngrok'] },
    })

    expect(readManifest(store.manifestPath('r-life-1'))?.lifecycle).toMatchObject({
      phase: 'restarting-services',
      restartPlan: { restarted: ['api'], kept: ['ngrok'], startedBecauseMissing: ['ngrok'] },
    })
    expect(getRunDetail(tmpDir, 'r-life-1')?.lifecycleEvents).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, 'lifecycle-events.jsonl'), 'utf-8')).toContain('Restart plan ready')
    expect(events).toEqual([{ kind: 'changed', runId: 'r-life-1' }])
  })

  it('emits journal-changed without mutating run detail', () => {
    seedRun('r-journal-1', { status: 'healing' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.onEvent((event) => events.push(event))

    store.recordJournalChange('r-journal-1')

    expect(events).toEqual([{ kind: 'journal-changed', runId: 'r-journal-1' }])
    expect(readManifest(store.manifestPath('r-journal-1'))?.status).toBe('healing')
  })

  it('emits changed for a reporter-owned summary write without mutating the manifest', () => {
    seedRun('r-summary-1', { status: 'running' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.onEvent((event) => events.push(event))

    store.notifySummaryChanged('r-summary-1')

    expect(events).toEqual([{ kind: 'changed', runId: 'r-summary-1' }])
    expect(readManifest(store.manifestPath('r-summary-1'))?.status).toBe('running')
  })

  it('emits an external-heal-task event when an external run waits for a signal', () => {
    seedRun('r-life-external', { status: 'healing', healMode: 'external' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.onEvent((event) => events.push(event))

    store.recordLifecycleEvent('r-life-external', {
      phase: 'waiting-for-signal',
      headline: 'Waiting for heal signal',
      updatedAt: '2026-05-08T00:00:05.000Z',
    })

    expect(events).toEqual([
      { kind: 'changed', runId: 'r-life-external' },
      { kind: 'external-heal-task', runId: 'r-life-external' },
    ])
  })

  it('does not emit an external-heal-task event when a non-external run waits for a signal', () => {
    seedRun('r-life-manual', { status: 'healing', healMode: 'manual' })
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.onEvent((event) => events.push(event))

    store.recordLifecycleEvent('r-life-manual', {
      phase: 'waiting-for-signal',
      headline: 'Waiting for heal signal',
      updatedAt: '2026-05-08T00:00:05.000Z',
    })

    expect(events).toEqual([{ kind: 'changed', runId: 'r-life-manual' }])
  })

  it('ignores corrupt lifecycle JSONL lines and entries that lack a phase string', () => {
    const dir = seedRun('r-life-bad', { status: 'running' })
    const lifecyclePath = path.join(dir, 'lifecycle-events.jsonl')
    // Mix valid entry with two unusable lines: one corrupt JSON and one with a non-string phase.
    fs.writeFileSync(
      lifecyclePath,
      [
        '{not valid json',
        JSON.stringify({ phase: 7, headline: 'numeric phase' }),
        '',
        JSON.stringify({ phase: 'restarting-services', headline: 'ok', updatedAt: '2026-05-08T00:00:05.000Z' }),
      ].join('\n'),
    )
    const events = getRunDetail(tmpDir, 'r-life-bad')?.lifecycleEvents
    expect(events).toHaveLength(1)
    expect(events?.[0]).toMatchObject({ phase: 'restarting-services' })
  })

  it('returns undefined when every lifecycle JSONL line fails to parse into an event', () => {
    const dir = seedRun('r-life-all-bad', { status: 'running' })
    fs.writeFileSync(path.join(dir, 'lifecycle-events.jsonl'), '{nope\n{also-nope\n')
    expect(getRunDetail(tmpDir, 'r-life-all-bad')?.lifecycleEvents).toBeUndefined()
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

  it('trimRunArtifacts deletes only the playwright-artifacts dirs, keeps the manifest, is idempotent', () => {
    seedRun('trim-me', { status: 'passed' })
    seedArtifacts('trim-me', 1024)
    const paths = buildRunPaths(runDirFor(tmpDir, 'trim-me'))
    expect(trimRunArtifacts(tmpDir, 'trim-me')).toBe(2048)
    expect(fs.existsSync(paths.playwrightArtifactsDir)).toBe(false)
    expect(fs.existsSync(paths.playwrightArtifactsKeepDir)).toBe(false)
    expect(fs.existsSync(paths.manifestPath)).toBe(true)
    expect(trimRunArtifacts(tmpDir, 'trim-me')).toBe(0)
  })

  it('store.trimArtifacts guards active/stale/not-found and emits changed on success', () => {
    const reg = createRegistry()
    reg.set('active', fakeOrch('active'))
    seedRun('active', { status: 'running' }); seedArtifacts('active', 512)
    seedRun('stale', { status: 'running' }); seedArtifacts('stale', 512)
    seedRun('done', { status: 'passed' }); seedArtifacts('done', 512)
    const store = new RunStore(tmpDir, reg)
    expect(store.trimArtifacts('active')).toEqual({ ok: false, reason: 'active' })
    expect(store.trimArtifacts('stale')).toEqual({ ok: false, reason: 'stale' })
    expect(store.trimArtifacts('ghost')).toEqual({ ok: false, reason: 'not-found' })
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    expect(store.trimArtifacts('done')).toEqual({ ok: true, freedBytes: 1024 })
    expect(events).toEqual([{ kind: 'changed', runId: 'done' }])
  })

  it('store.delete removes an orphan directory with no manifest', () => {
    const dir = runDirFor(tmpDir, 'orphan')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'playwright.log'), 'partial run, never finalized')
    const store = new RunStore(tmpDir, createRegistry())
    const events: RunStoreEvent[] = []
    store.on('event', (e) => events.push(e))
    expect(store.delete('orphan')).toEqual({ ok: true })
    expect(fs.existsSync(dir)).toBe(false)
    expect(events).toEqual([{ kind: 'removed', runId: 'orphan' }])
  })

  it('cleanupListing reports sizes, orphans, active flags, and reclaimable totals', () => {
    const reg = createRegistry()
    reg.set('live', fakeOrch('live'))
    seedRun('live', { status: 'running' }); seedArtifacts('live', 100)
    seedRun('done', { status: 'passed', feature: 'bar' }); seedArtifacts('done', 100)
    const orphanDir = runDirFor(tmpDir, 'orphan')
    fs.mkdirSync(orphanDir, { recursive: true })
    fs.writeFileSync(path.join(orphanDir, 'x.log'), Buffer.alloc(50))
    const store = new RunStore(tmpDir, reg)
    const listing = store.cleanupListing()

    const done = listing.runs.find((r) => r.runId === 'done')!
    const live = listing.runs.find((r) => r.runId === 'live')!
    expect(done.active).toBe(false)
    expect(done.artifactBytes).toBe(200)
    expect(live.active).toBe(true)
    expect(listing.orphans.map((o) => o.runId)).toEqual(['orphan'])
    // Trim reclaims artifacts of non-active runs only; delete reclaims whole
    // non-active folders plus every orphan.
    expect(listing.totals.reclaimableTrimBytes).toBe(200)
    expect(listing.totals.reclaimableDeleteBytes).toBe(done.folderBytes + 50)
  })
})
