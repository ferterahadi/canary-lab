import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildRunScheduling } from './run-scheduling'
import { createRegistry, RunStore } from './logic/run-store'
import { DirtySpecStore } from './logic/dirty-specs/store'
import { readManifest, writeManifest, writeRunsIndex, type RunIndexEntry, type RunManifest } from './logic/runtime/manifest'
import { runDirFor } from './logic/runtime/run-paths'
import type { PtyFactory } from './logic/runtime/pty-spawner'
import type { ServerContext } from '../../server-context'
import type { WorkspaceEvent } from '../../shared/workspace-events'
import type { FeatureConfig } from '../../../../../shared/launcher/types'

let tmpDir: string
let logsDir: string
let featuresDir: string
let events: WorkspaceEvent[]
let runStore: RunStore

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-runsched-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
  events = []
  runStore = new RunStore(logsDir, createRegistry())
  // The resource heuristic reads this at build time; an ambient value on the
  // developer's machine would silently change whether promote() admits.
  vi.stubEnv('CANARY_MAX_CONCURRENT_RUNS', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * `buildRunScheduling` destructures the whole `ServerContext` but only reads
 * `logsDir`, `runStore` and `workspaceEvents`. The rest of the context is
 * process-lifetime state owned by other features, so the fixture builds what
 * this module can actually observe and casts away the remainder — a full
 * context would mean constructing nine unrelated stores to prove nothing.
 */
function makeCtx(): ServerContext {
  return {
    projectRoot: tmpDir,
    featuresDir,
    logsDir,
    registry: runStore.registry,
    runStore,
    dirtySpecStore: new DirtySpecStore(logsDir),
    workspaceEvents: { publish: (e: WorkspaceEvent) => events.push(e) },
    brokers: new Map(),
    activeEnvsets: new Map(),
    ptyFactory: inertPtyFactory,
  } as unknown as ServerContext
}

function makeFeature(over: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    name: 'foo',
    description: 'd',
    envs: [],
    featureDir: path.join(featuresDir, 'foo'),
    ...over,
  } as FeatureConfig
}

function baseManifest(over: Partial<RunManifest>): RunManifest {
  return {
    runId: 'r',
    feature: 'foo',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    healCycles: 0,
    services: [],
    ...over,
  }
}

function writeRunManifest(manifest: RunManifest): void {
  const dir = runDirFor(logsDir, manifest.runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), manifest)
}

function indexEntry(over: Partial<RunIndexEntry>): RunIndexEntry {
  return {
    runId: 'r',
    feature: 'foo',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    healCycles: 0,
    ...over,
  }
}

function serviceEntry(safeName: string) {
  return {
    name: safeName,
    safeName,
    command: 'serve',
    cwd: tmpDir,
    logPath: path.join(tmpDir, `${safeName}.log`),
  }
}

describe('buildRunScheduling — admission config', () => {
  it('resolves the concurrency ceiling from the environment', () => {
    vi.stubEnv('CANARY_MAX_CONCURRENT_RUNS', '3')
    expect(buildRunScheduling(makeCtx()).admissionConfig.maxConcurrentRuns).toBe(3)
  })
})

describe('buildRunScheduling — listActiveForScheduler', () => {
  it('reports only active runs, costing each by its manifest services', () => {
    writeRunManifest(baseManifest({
      runId: 'act-1',
      status: 'healing',
      repoPaths: [tmpDir],
      services: [serviceEntry('api'), serviceEntry('web')],
    }))
    writeRunManifest(baseManifest({ runId: 'done-1', status: 'passed' }))
    writeRunsIndex(logsDir, [
      indexEntry({ runId: 'act-1', status: 'healing' }),
      indexEntry({ runId: 'done-1', status: 'passed' }),
    ])

    expect(buildRunScheduling(makeCtx()).listActiveForScheduler()).toEqual([
      { runId: 'act-1', feature: 'foo', repoPaths: [tmpDir], cost: 3 },
    ])
  })

  it('costs an active run whose manifest is gone, or predates `services`, as one slot with no repos', () => {
    // An index row with no run directory (the manifest was cleaned away) and a
    // manifest written before `services` existed are the two shapes that make
    // the scheduler read through a missing value. Both must still be counted:
    // dropping them would let the budget admit a run the machine can't host.
    writeRunManifest(
      { ...baseManifest({ runId: 'old-1' }), services: undefined } as unknown as RunManifest,
    )
    writeRunsIndex(logsDir, [
      indexEntry({ runId: 'gone-1' }),
      indexEntry({ runId: 'old-1' }),
    ])

    expect(buildRunScheduling(makeCtx()).listActiveForScheduler()).toEqual([
      { runId: 'gone-1', feature: 'foo', repoPaths: [], cost: 1 },
      { runId: 'old-1', feature: 'foo', repoPaths: [], cost: 1 },
    ])
  })
})

describe('buildRunScheduling — store event fan-out', () => {
  it('promotes the queue when a run finalizes', async () => {
    const { scheduler } = buildRunScheduling(makeCtx())
    let launched = false
    scheduler.enqueue({
      runId: 'q-1',
      feature: 'foo',
      repoPaths: [],
      cost: 1,
      reason: 'resources',
      launch: async () => { launched = true },
    })

    runStore.bootstrap(baseManifest({ runId: 'act-1' }))
    runStore.finalize('act-1', 'passed', '2026-01-01T00:01:00.000Z', 0)

    // `promote()` is fired fire-and-forget from the listener, so the launch
    // lands on a later microtask than the synchronous finalize call.
    for (let i = 0; i < 50 && !launched; i += 1) await Promise.resolve()
    expect(launched).toBe(true)
    expect(scheduler.isQueued('q-1')).toBe(false)
  })

  it('republishes a per-run journal change onto the workspace bus', () => {
    buildRunScheduling(makeCtx())
    runStore.recordJournalChange('act-1')
    expect(events).toEqual([{ type: 'journal-changed', runId: 'act-1' }])
  })

  it('ignores other store events and a journal change with no run id', () => {
    buildRunScheduling(makeCtx())
    // `RunStoreEvent.runId` is optional across all eight kinds, so a
    // journal-changed carrying none is representable — emitted directly here
    // because every current producer supplies one and the published
    // `journal-changed` event requires a run id.
    runStore.emit('event', { kind: 'journal-changed' })
    runStore.emit('event', { kind: 'changed', runId: 'act-1' })
    expect(events).toEqual([])
  })
})

describe('buildRunScheduling — writeQueuedManifest', () => {
  it('persists a queued placeholder with the services that will boot and the run repos', () => {
    const { writeQueuedManifest } = buildRunScheduling(makeCtx())
    const feature = makeFeature({
      repos: [{ name: 'r', localPath: tmpDir, startCommands: [{ command: 'serve', name: 'svc' }] }],
    } as Partial<FeatureConfig>)

    writeQueuedManifest('q-1', feature, 'local', 'repo-collision')

    const manifest = readManifest(path.join(runDirFor(logsDir, 'q-1'), 'manifest.json'))!
    expect(manifest).toMatchObject({
      runId: 'q-1',
      executionType: 'run',
      feature: 'foo',
      env: 'local',
      status: 'queued',
      healCycles: 0,
      queueReason: 'repo-collision',
      repoPaths: [tmpDir],
    })
    expect(manifest.services.map((s) => ({ safeName: s.safeName, status: s.status })))
      .toEqual([{ safeName: 'svc', status: 'queued' }])
    // The heartbeat starts at the queue time so the reaper doesn't treat a
    // freshly-parked run as an orphan.
    expect(manifest.heartbeatAt).toBe(manifest.startedAt)
  })

  it('carries a non-run execution type and leaves repoPaths empty when the feature has no repos', () => {
    const { writeQueuedManifest } = buildRunScheduling(makeCtx())

    writeQueuedManifest('q-2', makeFeature(), undefined, 'resources', 'verify')

    const manifest = readManifest(path.join(runDirFor(logsDir, 'q-2'), 'manifest.json'))!
    expect(manifest).toMatchObject({
      executionType: 'verify',
      status: 'queued',
      queueReason: 'resources',
      repoPaths: [],
      services: [],
    })
    expect(manifest.env).toBeUndefined()
  })
})

describe('buildRunScheduling — cancelQueuedRun', () => {
  it('aborts a run still parked in the queue', () => {
    const { scheduler, writeQueuedManifest, cancelQueuedRun } = buildRunScheduling(makeCtx())
    writeQueuedManifest('q-1', makeFeature(), undefined, 'resources')
    scheduler.enqueue({
      runId: 'q-1',
      feature: 'foo',
      repoPaths: [],
      cost: 1,
      reason: 'resources',
      launch: async () => { throw new Error('a cancelled run must never launch') },
    })

    expect(cancelQueuedRun('q-1')).toBe(true)
    expect(scheduler.isQueued('q-1')).toBe(false)
    expect(readManifest(path.join(runDirFor(logsDir, 'q-1'), 'manifest.json'))!.status).toBe('aborted')
  })

  it('reports no cancellation for a run that is not queued', () => {
    const { cancelQueuedRun } = buildRunScheduling(makeCtx())
    expect(cancelQueuedRun('never-queued')).toBe(false)
    expect(runStore.list()).toEqual([])
  })
})
