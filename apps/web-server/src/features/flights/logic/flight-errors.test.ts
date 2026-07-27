import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FlightRunStore, type FlightStore } from './store'
import {
  startFlight,
  resumeFlight,
  setFlightAutopilot,
  respondToFlightCheckpoint,
  abortFlight,
  pauseFlight,
  redoFlight,
  deleteFlight,
  removeFlightRecordsForFeature,
  enqueueFlight,
  drainQueuedFlights,
  reopenStages,
  stampSystemLine,
  FlightConflictError,
  FlightExistsError,
  FlightFrozenError,
  FlightStageEntryError,
  type FlightConductorDeps,
  type StageAdapter,
  type StageAdapters,
  type StageOutcome,
} from './conductor'

let tmpDir: string

let store: FlightRunStore

let n: number

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flights-')))
  store = new FlightRunStore(tmpDir)
  n = 0
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('stampSystemLine', () => {
  const iso = '2026-07-22T20:35:24.000Z'

  it('stamps a tagged conductor line inside its tag', () => {
    expect(stampSystemLine('[docs] collecting repo docs…\n', iso))
      .toBe(`[docs@${iso}] collecting repo docs…\n`)
  })

  it('leaves mirrored agent output alone — it is untagged and arrives in partial chunks', () => {
    expect(stampSystemLine('The agent found nothing relevant', iso))
      .toBe('The agent found nothing relevant')
    // A bracket mid-chunk is prose, not a tag opening the line.
    expect(stampSystemLine('see [docs] above', iso)).toBe('see [docs] above')
  })

  it('does not double-stamp a line that already carries a time', () => {
    const once = stampSystemLine('[docs] a\n', iso)
    expect(stampSystemLine(once, '2026-07-22T21:00:00.000Z')).toBe(once)
  })
})
