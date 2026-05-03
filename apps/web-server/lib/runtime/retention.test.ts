import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DEFAULT_RETENTION,
  listRunDirs,
  pruneRuns,
  resolveRetention,
} from './retention'
import { runDirFor, runsRoot } from './run-paths'
import { writeRunsIndex } from './manifest'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rt-')))
})

function makeRun(id: string): void {
  const dir = runDirFor(tmpDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}')
}

describe('resolveRetention', () => {
  it('returns default when env var unset', () => {
    expect(resolveRetention({})).toBe(DEFAULT_RETENTION)
  })

  it('parses positive integer', () => {
    expect(resolveRetention({ CANARY_LAB_RUN_RETENTION: '5' })).toBe(5)
  })

  it('falls back to default on non-numeric or non-positive', () => {
    expect(resolveRetention({ CANARY_LAB_RUN_RETENTION: 'abc' })).toBe(DEFAULT_RETENTION)
    expect(resolveRetention({ CANARY_LAB_RUN_RETENTION: '0' })).toBe(DEFAULT_RETENTION)
    expect(resolveRetention({ CANARY_LAB_RUN_RETENTION: '-3' })).toBe(DEFAULT_RETENTION)
  })
})

describe('listRunDirs', () => {
  it('returns [] when runs dir is missing', () => {
    expect(listRunDirs(tmpDir)).toEqual([])
  })

  it('lists only directories with valid run IDs, sorted', () => {
    makeRun('2026-04-28T1015-aaaa')
    makeRun('2026-04-28T1014-bbbb')
    fs.mkdirSync(path.join(runsRoot(tmpDir), 'not-a-run-id'), { recursive: true })
    fs.writeFileSync(path.join(runsRoot(tmpDir), 'index.json'), '[]')
    expect(listRunDirs(tmpDir)).toEqual([
      '2026-04-28T1014-bbbb',
      '2026-04-28T1015-aaaa',
    ])
  })
})

describe('pruneRuns', () => {
  it('keeps everything when below retention', () => {
    makeRun('2026-04-28T1010-aaaa')
    makeRun('2026-04-28T1011-aaaa')
    const r = pruneRuns(tmpDir, 5)
    expect(r.removed).toEqual([])
    expect(r.kept).toHaveLength(2)
  })

  it('returns empty kept/removed for zero or negative retention', () => {
    makeRun('2026-04-28T1010-aaaa')
    expect(pruneRuns(tmpDir, 0)).toEqual({ kept: [], removed: [] })
    expect(pruneRuns(tmpDir, -1)).toEqual({ kept: [], removed: [] })
  })

  it('deletes oldest dirs and updates index when over retention', () => {
    const ids = ['1', '2', '3', '4', '5'].map(
      (n) => `2026-04-28T101${n}-aaaa`,
    )
    for (const id of ids) makeRun(id)

    writeRunsIndex(tmpDir, ids.map((runId) => ({
      runId, feature: 'demo', startedAt: 't', status: 'passed' as const,
    })))

    const result = pruneRuns(tmpDir, 2)
    expect(result.removed).toEqual(ids.slice(0, 3))
    expect(result.kept).toEqual(ids.slice(3))

    for (const removedId of result.removed) {
      expect(fs.existsSync(runDirFor(tmpDir, removedId))).toBe(false)
    }
    for (const keptId of result.kept) {
      expect(fs.existsSync(runDirFor(tmpDir, keptId))).toBe(true)
    }

    const indexRaw = JSON.parse(
      fs.readFileSync(path.join(runsRoot(tmpDir), 'index.json'), 'utf-8'),
    ) as { runId: string }[]
    expect(indexRaw.map((e) => e.runId).sort()).toEqual(result.kept)
  })

  it('uses env-based retention when none passed', () => {
    process.env.CANARY_LAB_RUN_RETENTION = '1'
    try {
      makeRun('2026-04-28T1010-aaaa')
      makeRun('2026-04-28T1011-aaaa')
      const result = pruneRuns(tmpDir)
      expect(result.kept).toEqual(['2026-04-28T1011-aaaa'])
    } finally {
      delete process.env.CANARY_LAB_RUN_RETENTION
    }
  })
})
