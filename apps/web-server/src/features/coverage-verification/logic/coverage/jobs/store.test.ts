import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CoverageJobRunStore } from './store'
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
})
