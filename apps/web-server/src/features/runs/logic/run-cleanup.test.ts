import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRegistry, listRuns, dirSizeBytes } from './run-store'
import { listCleanupEntries, reapStaleRuns, removeRunFromHistory } from './run-cleanup'
import { readManifest, writeManifest, writeRunsIndex } from './runtime/manifest'
import { runDirFor } from './runtime/run-paths'
import { HEARTBEAT_STALE_MS } from '../../../../../../shared/run-state'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rs-')))
})

describe('dirSizeBytes', () => {
  it('returns 0 for a directory that cannot be read', () => {
    expect(dirSizeBytes(path.join(tmpDir, 'does-not-exist'))).toBe(0)
  })

  it('sums file sizes recursively, skipping symlinks', () => {
    const dir = path.join(tmpDir, 'sized')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello') // 5 bytes
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'world!') // 6 bytes
    fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'link'))
    expect(dirSizeBytes(dir)).toBe(11)
  })

  it('tolerates a file that vanishes between readdir and stat', () => {
    const dir = path.join(tmpDir, 'vanish-guard')
    const doomed = path.join(dir, 'doomed.txt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(doomed, 'data')
    const originalStatSync = fs.statSync
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((candidate) => {
      if (candidate === doomed) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return originalStatSync(candidate as fs.PathLike)
    })
    try {
      expect(dirSizeBytes(dir)).toBe(0)
    } finally {
      statSpy.mockRestore()
    }
  })
})

describe('listCleanupEntries', () => {
  it('returns empty listing when nothing exists', () => {
    const listing = listCleanupEntries(tmpDir)
    expect(listing.runs).toEqual([])
    expect(listing.orphans).toEqual([])
    expect(listing.totals).toEqual({ totalBytes: 0, reclaimableTrimBytes: 0, reclaimableDeleteBytes: 0 })
  })

  it('annotates indexed runs with disk usage + active flag and finds orphans', () => {
    const dir = runDirFor(tmpDir, 'r1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}') // some bytes
    writeRunsIndex(tmpDir, [
      { runId: 'r1', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed', endedAt: '2026-01-01T00:05:00Z', executionType: 'boot' },
    ])
    // An on-disk run dir not present in the index → orphan.
    fs.mkdirSync(path.join(runDirFor(tmpDir, 'orphan-x')), { recursive: true })
    fs.writeFileSync(path.join(runDirFor(tmpDir, 'orphan-x'), 'junk.log'), 'xyz')

    // Default isActive: a 'passed' run is not active → reclaimable.
    const listing = listCleanupEntries(tmpDir)
    expect(listing.runs.map((r) => r.runId)).toEqual(['r1'])
    expect(listing.runs[0].active).toBe(false)
    expect(listing.runs[0].endedAt).toBe('2026-01-01T00:05:00Z')
    expect(listing.runs[0].executionType).toBe('boot')
    expect(listing.orphans.map((o) => o.runId)).toEqual(['orphan-x'])
    expect(listing.totals.totalBytes).toBeGreaterThan(0)
    expect(listing.totals.reclaimableDeleteBytes).toBeGreaterThan(0)
  })

  it('honors the injected isActive overlay so a live run is non-reclaimable', () => {
    const dir = runDirFor(tmpDir, 'live')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}')
    writeRunsIndex(tmpDir, [
      { runId: 'live', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
    ])
    const listing = listCleanupEntries(tmpDir, (runId) => runId === 'live')
    expect(listing.runs[0].active).toBe(true)
    expect(listing.totals.reclaimableDeleteBytes).toBe(0)
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
      heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1).toISOString(),
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
      heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1).toISOString(),
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

  it('reaps an active entry with no manifest when no orchestrator is registered', async () => {
    // Index entry exists but no manifest file on disk (e.g. a boot run killed
    // mid-teardown). A live run always writes its manifest before its index
    // entry, so an active index row with no manifest is an orphan — reap it to
    // aborted instead of leaving it stuck running forever.
    writeRunsIndex(tmpDir, [
      { runId: 'no-manifest', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    await reapStaleRuns(tmpDir)
    const indexed = listRuns(tmpDir)[0]
    expect(indexed.status).toBe('aborted')
    expect(indexed.endedAt).toBeDefined()
  })

  it('leaves a no-manifest active entry alone while its orchestrator is still registered', async () => {
    // A registered orchestrator means the run is genuinely live and its
    // manifest read merely glitched — don't reap it out from under itself.
    const reg = createRegistry()
    reg.set('live-no-manifest', {
      runId: 'live-no-manifest',
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    })
    writeRunsIndex(tmpDir, [
      { runId: 'live-no-manifest', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])
    await reapStaleRuns(tmpDir, reg)
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
      heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1).toISOString(),
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
