// Public surface of the `flights` feature.
//
// Other features import from here, never from a path inside this directory —
// tools/check-feature-boundaries.mjs enforces it. Adding a re-export widens
// this feature's contract, so add one deliberately.

export {
  FlightStatusChip,
  FlightsPill,
  resolveFeatureFlightAction,
} from './components/FlightsPill'
export type { FeatureFlightAction } from './components/FlightsPill'
export {
  StageStatusChip,
  stageLabel,
} from './components/stage-meta'
export type { DerivedStage } from './lib/derived-stages'
export {
  readGroupOpen,
  writeGroupOpen,
} from './lib/group-open-state'
export type { FeatureActivity } from './state/feature-activity'
