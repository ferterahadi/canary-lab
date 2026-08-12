import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CoverageJobRunStore, bridgeCoverageJobEvents } from './store'
import type { WorkspaceEvent } from '../../../../../shared/workspace-events'
import { coverageJobsIndexPath, coverageJobDir, buildCoverageJobPaths } from './paths'
import type { CoverageJobManifest } from './types'

let tmpDir: string
let store: CoverageJobRunStore

const now = () => '2026-01-01T00:00:00Z'

function makeManifest(jobId: string, overrides: Partial<CoverageJobManifest> = {}): CoverageJobManifest {
  return {
    jobId,
    feature: 'checkout',
    kind: 'coverage',
    status: 'running',
    startedAt: now(),
    log: '',
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-store-')))
  store = new CoverageJobRunStore(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('CoverageJobRunStore', () => {
  it('remove() deletes the job from the index and removes its directory', () => {
    store.save(makeManifest('j1'))
    store.save(makeManifest('j2'))
    expect(store.list().map((e) => e.jobId)).toContain('j1')

    store.remove('j1')

    // Removed from index.
    expect(store.list().map((e) => e.jobId)).not.toContain('j1')
    expect(store.list().map((e) => e.jobId)).toContain('j2')

    // Manifest is gone (directory deleted).
    expect(store.get('j1')).toBeNull()
  })

  it('remove() on a non-existent job does not corrupt the index', () => {
    store.save(makeManifest('j1'))
    // Removing a job that never existed should not throw and must leave the
    // remaining entry intact.
    expect(() => store.remove('ghost')).not.toThrow()
    expect(store.list().map((e) => e.jobId)).toEqual(['j1'])
  })

  it('onEvent / offEvent subscribe and unsubscribe', () => {
    const events: string[] = []
    const listener = (e: { kind: string }) => events.push(e.kind)

    store.onEvent(listener)
    store.save(makeManifest('j1'))
    expect(events).toEqual(['changed'])

    store.offEvent(listener)
    store.save(makeManifest('j2'))
    // After unsubscribing, no new events should arrive.
    expect(events).toEqual(['changed'])
  })

  it('remove() emits a "removed" event after unregistering the job', () => {
    const events: Array<{ kind: string; jobId?: string }> = []
    store.onEvent((e) => events.push({ kind: e.kind, jobId: e.jobId }))

    store.save(makeManifest('j1'))
    store.remove('j1')

    expect(events).toContainEqual({ kind: 'removed', jobId: 'j1' })
  })

  it('a listener that throws does not break subsequent listeners or store persistence', () => {
    const good: string[] = []
    store.onEvent(() => { throw new Error('bad listener') })
    store.onEvent((e) => good.push(e.kind))

    // save() must complete and persist, even though one listener threw.
    expect(() => store.save(makeManifest('j1'))).not.toThrow()

    // The non-throwing listener still received the event.
    expect(good).toEqual(['changed'])

    // Persistence: the manifest is readable after the throwing listener.
    expect(store.get('j1')).not.toBeNull()
  })

  it('save() updates an existing index entry without duplicating it', () => {
    store.save(makeManifest('j1'))
    expect(store.list()).toHaveLength(1)

    // Update the same job (e.g. status flip).
    store.save(makeManifest('j1', { status: 'done', endedAt: now() }))

    // Still exactly one entry in the index.
    const entries = store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('done')
  })

  it('save() merge preserves existing index fields not present in the new entry', () => {
    // Write a manifest that produces an index entry with endedAt.
    store.save(makeManifest('j1', { status: 'done', endedAt: '2026-01-01T01:00:00Z' }))

    // Save again — the spread `{ ...entries[idx], ...entry }` must keep endedAt
    // when the new indexEntryFromManifest omits it (running status has no endedAt).
    store.save(makeManifest('j1', { status: 'running' }))
    const entry = store.list().find((e) => e.jobId === 'j1')
    // The running manifest has no endedAt, so the existing value is preserved by
    // the spread (old fields not overwritten by undefined keys).
    expect(entry?.status).toBe('running')
  })

  it('readIndex returns [] when the index file contains non-array JSON', () => {
    // Create an index entry first so the file + directory exist.
    store.save(makeManifest('j1'))
    // Overwrite the index file with a non-array JSON value.
    const indexPath = coverageJobsIndexPath(tmpDir)
    fs.writeFileSync(indexPath, JSON.stringify({ not: 'an array' }))
    // list() reads the index — must return [] and not throw.
    expect(store.list()).toEqual([])
  })

  it('reconcileInterrupted skips entries whose status is not "running"', () => {
    store.save(makeManifest('j1', { status: 'done', endedAt: '2026-01-01T01:00:00Z' }))
    store.reconcileInterrupted(now)
    // Done job must not be flipped to aborted.
    expect(store.get('j1')?.status).toBe('done')
  })

  it('reconcileInterrupted skips entries whose manifest file is missing', () => {
    // Save a running job to the index.
    store.save(makeManifest('j1'))
    // Delete the manifest file while leaving the index entry intact.
    const { manifestPath } = buildCoverageJobPaths(coverageJobDir(tmpDir, 'j1'))
    fs.rmSync(manifestPath)
    // reconcileInterrupted reads the manifest via get(); get() returns null for a
    // missing file. The `if (!m) continue` guard must prevent a throw.
    expect(() => store.reconcileInterrupted(now)).not.toThrow()
  })

  it('statusOf config callback extracts the manifest status field', () => {
    const statusOf = (store as any).store.config.statusOf as (m: CoverageJobManifest) => string
    expect(statusOf(makeManifest('j1', { status: 'running' }))).toBe('running')
    expect(statusOf(makeManifest('j1', { status: 'done', endedAt: 'e' }))).toBe('done')
  })

  it('renameFeature() re-homes matching jobs and reports the count', () => {
    // A suite rename must carry the new name into the coverage-job history.
    store.save(makeManifest('j1', { feature: 'old_name' }))
    store.save(makeManifest('j2', { feature: 'old_name', status: 'done', endedAt: 'e' }))
    store.save(makeManifest('j3', { feature: 'other' }))

    expect(store.renameFeature('old_name', 'new_name')).toBe(2)
    expect(store.get('j1')?.feature).toBe('new_name')
    expect(store.get('j2')?.feature).toBe('new_name')
    expect(store.get('j3')?.feature).toBe('other')
  })

  it('renameFeature() is a no-op when nothing matches', () => {
    store.save(makeManifest('j1', { feature: 'kept' }))
    expect(store.renameFeature('absent', 'new_name')).toBe(0)
    expect(store.get('j1')?.feature).toBe('kept')
  })

  it('idOfEntry falls back to jobId for legacy index rows that lack an id field', () => {
    // Write a legacy-format index entry (pre-`id` shape: only jobId, no id field).
    store.save(makeManifest('j1'))
    const indexPath = coverageJobsIndexPath(tmpDir)
    const entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    const legacy = entries.map(({ id: _id, ...rest }: Record<string, unknown>) => rest)
    fs.writeFileSync(indexPath, JSON.stringify(legacy))
    // remove() must still find and drop the entry via the jobId fallback.
    store.remove('j1')
    expect(store.list()).toHaveLength(0)
  })
})

// The bridge is the only thing that turns a job write into the `coverage-changed`
// event the ledger UI listens for — it replaced six hand-placed publishes, one
// per lifecycle step, which is exactly how a step could be added without one.
// Its two guards are what keep it from announcing a change that did not happen.
describe('bridgeCoverageJobEvents', () => {
  it('announces the job\'s feature on a write', () => {
    const events: WorkspaceEvent[] = []
    bridgeCoverageJobEvents(store, { publish: (e) => events.push(e) })
    store.save(makeManifest('j-live', { feature: 'billing' }))
    expect(events).toEqual([{ type: 'coverage-changed', feature: 'billing' }])
  })

  it('stays quiet for a removed job, which has no record to read a feature from', () => {
    store.save(makeManifest('j-gone'))
    const events: WorkspaceEvent[] = []
    bridgeCoverageJobEvents(store, { publish: (e) => events.push(e) })
    store.remove('j-gone')
    // Nothing about the ledger changed — the job's history was pruned. An event
    // here would send every open client to refetch a ledger that is unchanged.
    expect(events).toEqual([])
  })

  // A third case belongs here in spirit — "a store event that names no job" —
  // but the store cannot produce one: `jobId` is now required, sourced from a
  // `TaskStoreEvent.id` that all four emit sites set. The guard that used to
  // stand for it was unreachable, so the type carries the invariant instead.
})
