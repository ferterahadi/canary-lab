import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readManifest,
  readRunsIndex,
  setCurrentRunSymlink,
  updateManifest,
  updateServiceStatus,
  upsertRunsIndexEntry,
  writeManifest,
  writeRunsIndex,
  type RunManifest,
} from './manifest'
import { runDirFor, runsIndexPath } from './run-paths'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mf-')))
})

function makeManifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: '2026-04-28T1015-abc1',
    feature: 'demo',
    startedAt: '2026-04-28T10:15:00.000Z',
    status: 'running',
    healCycles: 0,
    services: [],
    ...over,
  }
}

describe('writeManifest / readManifest', () => {
  it('round-trips through atomic write', () => {
    const file = path.join(tmpDir, 'manifest.json')
    const m = makeManifest({ services: [{ name: 'api', safeName: 'api', command: 'go run', cwd: '/x', logPath: '/x/api.log' }] })
    writeManifest(file, m)
    expect(readManifest(file)).toEqual(m)
  })

  it('readManifest returns null on missing/invalid file', () => {
    expect(readManifest(path.join(tmpDir, 'missing.json'))).toBeNull()
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), '{not valid')
    expect(readManifest(path.join(tmpDir, 'bad.json'))).toBeNull()
  })

  it('updateManifest merges and returns null when missing', () => {
    const file = path.join(tmpDir, 'manifest.json')
    expect(updateManifest(file, { status: 'passed' })).toBeNull()
    writeManifest(file, makeManifest())
    const updated = updateManifest(file, {
      status: 'passed',
      endedAt: '2026-04-28T10:16:00.000Z',
      healCycles: 2,
    })
    expect(updated?.status).toBe('passed')
    expect(updated?.endedAt).toBe('2026-04-28T10:16:00.000Z')
    expect(updated?.healCycles).toBe(2)
    expect(readManifest(file)?.status).toBe('passed')
  })
})

describe('runs index', () => {
  it('readRunsIndex returns [] when missing or invalid', () => {
    expect(readRunsIndex(tmpDir)).toEqual([])
    fs.mkdirSync(path.dirname(runsIndexPath(tmpDir)), { recursive: true })
    fs.writeFileSync(runsIndexPath(tmpDir), 'not json')
    expect(readRunsIndex(tmpDir)).toEqual([])
    fs.writeFileSync(runsIndexPath(tmpDir), '{"not":"array"}')
    expect(readRunsIndex(tmpDir)).toEqual([])
  })

  it('writeRunsIndex + readRunsIndex round-trip', () => {
    writeRunsIndex(tmpDir, [
      { runId: 'a', feature: 'f', startedAt: 't', status: 'running' },
    ])
    expect(readRunsIndex(tmpDir)).toHaveLength(1)
  })

  it('upsertRunsIndexEntry inserts new and merges existing', () => {
    upsertRunsIndexEntry(tmpDir, {
      runId: 'a', feature: 'demo', startedAt: 't1', status: 'running',
    })
    upsertRunsIndexEntry(tmpDir, {
      runId: 'b', feature: 'demo', startedAt: 't2', status: 'running',
    })
    upsertRunsIndexEntry(tmpDir, {
      runId: 'a', feature: 'demo', startedAt: 't1', status: 'passed', endedAt: 't1b',
    })
    const entries = readRunsIndex(tmpDir)
    expect(entries).toHaveLength(2)
    const a = entries.find((e) => e.runId === 'a')!
    expect(a.status).toBe('passed')
    expect(a.endedAt).toBe('t1b')
  })
})

describe('setCurrentRunSymlink', () => {
  it('points logs/current at the requested run dir', () => {
    fs.mkdirSync(runDirFor(tmpDir, 'abc'), { recursive: true })
    fs.writeFileSync(path.join(runDirFor(tmpDir, 'abc'), 'marker'), 'hi')

    setCurrentRunSymlink(tmpDir, 'abc')
    expect(fs.readFileSync(path.join(tmpDir, 'current', 'marker'), 'utf-8')).toBe('hi')
  })

  it('replaces an existing link when called again', () => {
    fs.mkdirSync(runDirFor(tmpDir, 'one'), { recursive: true })
    fs.writeFileSync(path.join(runDirFor(tmpDir, 'one'), 'who'), 'one')
    fs.mkdirSync(runDirFor(tmpDir, 'two'), { recursive: true })
    fs.writeFileSync(path.join(runDirFor(tmpDir, 'two'), 'who'), 'two')

    setCurrentRunSymlink(tmpDir, 'one')
    setCurrentRunSymlink(tmpDir, 'two')
    expect(fs.readFileSync(path.join(tmpDir, 'current', 'who'), 'utf-8')).toBe('two')
  })

  it('removes the symlink when runId is null', () => {
    fs.mkdirSync(runDirFor(tmpDir, 'one'), { recursive: true })
    setCurrentRunSymlink(tmpDir, 'one')
    setCurrentRunSymlink(tmpDir, null)
    expect(fs.existsSync(path.join(tmpDir, 'current'))).toBe(false)
  })

  it('replaces an existing regular file at the link path', () => {
    fs.mkdirSync(runDirFor(tmpDir, 'one'), { recursive: true })
    fs.writeFileSync(path.join(runDirFor(tmpDir, 'one'), 'who'), 'one')
    fs.writeFileSync(path.join(tmpDir, 'current'), 'stale-pointer')
    setCurrentRunSymlink(tmpDir, 'one')
    expect(fs.readFileSync(path.join(tmpDir, 'current', 'who'), 'utf-8')).toBe('one')
  })

  it('updateServiceStatus updates the matching service and persists', () => {
    const manifestPath = path.join(tmpDir, 'manifest.json')
    writeManifest(
      manifestPath,
      makeManifest({
        services: [
          { name: 'api', safeName: 'api', status: 'starting' },
          { name: 'web', safeName: 'web', status: 'starting' },
        ],
      }),
    )
    const next = updateServiceStatus(manifestPath, 'api', 'healthy')
    expect(next?.services.find((s) => s.safeName === 'api')?.status).toBe('healthy')
    expect(next?.services.find((s) => s.safeName === 'web')?.status).toBe('starting')
    expect(readManifest(manifestPath)?.services.find((s) => s.safeName === 'api')?.status).toBe(
      'healthy',
    )
  })

  it('updateServiceStatus returns null when manifest is missing', () => {
    expect(updateServiceStatus(path.join(tmpDir, 'nope.json'), 'api', 'healthy')).toBeNull()
  })

  it('falls back to writing a pointer file when symlinkSync throws', () => {
    fs.mkdirSync(runDirFor(tmpDir, 'two'), { recursive: true })
    const origSymlink = fs.symlinkSync
    const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('symlink not supported')
    })
    try {
      setCurrentRunSymlink(tmpDir, 'two')
    } finally {
      spy.mockRestore()
    }
    void origSymlink
    const linkPath = path.join(tmpDir, 'current')
    expect(fs.existsSync(linkPath)).toBe(true)
    // It's a regular file in this fallback, not a directory.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false)
  })
})
