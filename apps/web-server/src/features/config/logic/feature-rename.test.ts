import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { renameFeatureRecords, type RenamableRecordStore } from './feature-rename'
import { writeRunsIndex, readRunsIndex } from '../../runs/logic/runtime/manifest'

function fakeStore(counts: Record<string, number>, key: string): RenamableRecordStore & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = []
  return {
    calls,
    renameFeature(from, to) {
      calls.push([from, to])
      return counts[key] ?? 0
    },
  }
}

describe('renameFeatureRecords', () => {
  let logsDir: string
  beforeEach(() => { logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rename-')) })
  afterEach(() => { fs.rmSync(logsDir, { recursive: true, force: true }) })

  it('carries the rename into every store and sums what moved', () => {
    const flights = fakeStore({ f: 1 }, 'f')
    const coverage = fakeStore({ c: 2 }, 'c')
    writeRunsIndex(logsDir, [
      { runId: 'r1', feature: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
    ])

    const result = renameFeatureRecords('old', 'new', { logsDir, stores: [flights, coverage] })

    expect(result).toEqual({ moved: 4 })
    expect(flights.calls).toEqual([['old', 'new']])
    expect(coverage.calls).toEqual([['old', 'new']])
    expect(readRunsIndex(logsDir)[0].feature).toBe('new')
  })

  it('refuses while live work still holds the old name, writing nothing', () => {
    const flights = fakeStore({ f: 1 }, 'f')
    writeRunsIndex(logsDir, [
      { runId: 'r1', feature: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    const result = renameFeatureRecords('old', 'new', {
      logsDir,
      stores: [flights],
      activeWork: () => 'run r1 is running — stop it before renaming the suite',
    })

    expect(result.error).toContain('r1 is running')
    expect(result.moved).toBe(0)
    expect(flights.calls).toEqual([])
    expect(readRunsIndex(logsDir)[0].feature).toBe('old')
  })

  it('is a no-op when the name did not change', () => {
    const flights = fakeStore({ f: 3 }, 'f')
    expect(renameFeatureRecords('same', 'same', { logsDir, stores: [flights] })).toEqual({ moved: 0 })
    expect(flights.calls).toEqual([])
  })
})
