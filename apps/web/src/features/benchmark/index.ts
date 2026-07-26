// Public surface of the `benchmark` feature.
//
// Other features import from here, never from a path inside this directory —
// tools/check-feature-boundaries.mjs enforces it. Adding a re-export widens
// this feature's contract, so add one deliberately.

export type {
  BenchmarkIndexEntry,
  BenchmarkManifest,
  SabotageLevel,
  SabotageSkillSummary,
} from './api/benchmark-types'
export { BenchmarkPill } from './components/BenchmarkPill'
export { BenchmarkWindow } from './components/BenchmarkWindow'
export { useBenchmarks } from './state/BenchmarkContext'
