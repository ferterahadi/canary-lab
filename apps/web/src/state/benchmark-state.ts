import type { BenchmarkManifest, BenchmarkIndexEntry } from '../api/benchmark-types'

// Pure reducer driving BenchmarkContext. Mirrors runs-state.ts so it unit-tests
// in the node vitest config (no jsdom). The server pushes the full manifest on
// every change (status, currentIteration, appended results, report) — the UI
// derives the scoreboard from `manifest.results` + `manifest.currentIteration`,
// so a single `update` frame covers arm-update / iteration-complete /
// report-ready without bespoke frame types.

export type BenchmarkStreamFrame =
  | {
      type: 'snapshot'
      benchmarks: BenchmarkIndexEntry[]
      details: Record<string, BenchmarkManifest>
    }
  | { type: 'update'; benchmarkId: string; manifest: BenchmarkManifest }
  | { type: 'removed'; benchmarkId: string }

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'disconnected'

export interface BenchmarkState {
  benchmarks: BenchmarkIndexEntry[]
  details: Record<string, BenchmarkManifest>
  connection: ConnectionState
}

export const initialBenchmarkState: BenchmarkState = {
  benchmarks: [],
  details: {},
  connection: 'connecting',
}

export type BenchmarkAction =
  | {
      type: 'snapshot'
      benchmarks: BenchmarkIndexEntry[]
      details: Record<string, BenchmarkManifest>
    }
  | { type: 'update'; benchmarkId: string; manifest: BenchmarkManifest }
  | { type: 'removed'; benchmarkId: string }
  | { type: 'connection'; status: ConnectionState }

function indexEntryFromManifest(m: BenchmarkManifest): BenchmarkIndexEntry {
  return {
    benchmarkId: m.benchmarkId,
    feature: m.feature,
    level: m.level,
    status: m.status,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  }
}

function byStartedDesc(a: BenchmarkIndexEntry, b: BenchmarkIndexEntry): number {
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
}

export function benchmarkReducer(
  state: BenchmarkState,
  action: BenchmarkAction,
): BenchmarkState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, benchmarks: action.benchmarks, details: action.details }
    case 'update': {
      const entry = indexEntryFromManifest(action.manifest)
      const others = state.benchmarks.filter((b) => b.benchmarkId !== action.benchmarkId)
      return {
        ...state,
        benchmarks: [entry, ...others].sort(byStartedDesc),
        details: { ...state.details, [action.benchmarkId]: action.manifest },
      }
    }
    case 'removed': {
      const { [action.benchmarkId]: _dropped, ...details } = state.details
      return {
        ...state,
        benchmarks: state.benchmarks.filter((b) => b.benchmarkId !== action.benchmarkId),
        details,
      }
    }
    case 'connection':
      return { ...state, connection: action.status }
  }
}

/** Translate a WS frame into a reducer action; unknown frame types → null. */
export function frameToAction(frame: BenchmarkStreamFrame): BenchmarkAction | null {
  switch (frame.type) {
    case 'snapshot':
      return { type: 'snapshot', benchmarks: frame.benchmarks, details: frame.details }
    case 'update':
      return { type: 'update', benchmarkId: frame.benchmarkId, manifest: frame.manifest }
    case 'removed':
      return { type: 'removed', benchmarkId: frame.benchmarkId }
    default:
      return null
  }
}
