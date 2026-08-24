// Public surface of the `flights` feature.
//
// Other features import from here, never from a path inside this directory —
// tools/check-feature-boundaries.mjs enforces it. Adding a re-export widens
// this feature's contract, so add one deliberately.

export {
  FeatureChipBadge,
  FlightStatusChip,
  FlightsPill,
  flightAwaitsUser,
  isExternalWorkPark,
  isExternallyDriven,
  presentedIndexStages,
  resolveFeatureFlightAction,
} from './components/FlightsPill'
export type { FeatureFlightAction } from './components/FlightsPill'
export {
  StageStatusChip,
  stageLabel,
  stageRowKey,
} from './components/stage-meta'
export type { DerivedStage } from './lib/derived-stages'
export { derivedFlightToken } from './lib/derived-stages'
export {
  readGroupOpen,
  writeGroupOpen,
} from './lib/group-open-state'
export { useFlightsStream } from './state/use-flights-stream'
export type { FlightsStreamState } from './state/flights-stream-state'
export { ACTIVITY_STAGE } from './state/feature-activity'
export type { FeatureActivity } from './state/feature-activity'
