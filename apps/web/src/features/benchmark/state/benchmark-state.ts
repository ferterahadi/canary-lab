import { benchmarkIndexEntry, type BenchmarkIndexEntry, type BenchmarkManifest } from '@shared/benchmark-index'
import {
  createRecordIndex,
  byStartedDesc,
  type RecordIndexAction,
  type RecordIndexState,
} from '@/shared/state/record-index-store'

// Pure reducer driving BenchmarkContext, built by the shared record-index store
// so it unit-tests in the node vitest config (no jsdom). The server pushes the
// full manifest on every change (status, currentIteration, appended results,
// report) — the UI derives the scoreboard from `manifest.results` +
// `manifest.currentIteration`, so a single `update` frame covers arm-update /
// iteration-complete / report-ready without bespoke frame types.

export const benchmarkIndex = createRecordIndex<BenchmarkIndexEntry, BenchmarkManifest, 'benchmarks', 'benchmarkId'>({
  keys: { list: 'benchmarks', id: 'benchmarkId' },
  entryOf: benchmarkIndexEntry,
  compareEntries: byStartedDesc,
})

export type BenchmarkAction = RecordIndexAction<BenchmarkIndexEntry, BenchmarkManifest, 'benchmarks', 'benchmarkId'>
export type BenchmarkState = RecordIndexState<BenchmarkIndexEntry, BenchmarkManifest, 'benchmarks'>
