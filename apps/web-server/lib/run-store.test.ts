import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createRegistry,
  listRuns,
  reapStaleRuns,
  getRunDetail,
  readRunSummary,
} from './run-store'
import { readManifest, writeManifest, writeRunsIndex } from '../../../shared/e2e-runner/manifest'
import { runDirFor } from '../../../shared/e2e-runner/run-paths'

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

  it('does not stop orchestrator from registry when heartbeat is fresh', async () => {
    const reg = createRegistry()
    let stopped = false
    const stub = {
      runId: 'alive-1',
      stop: async () => { stopped = true },
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
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
