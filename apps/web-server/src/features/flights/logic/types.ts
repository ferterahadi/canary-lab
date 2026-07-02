// First Flight background jobs — the conducted onboarding pipeline behind
// `canary-lab fly`. The manifest shapes are shared (UI pill/detail view + MCP
// read the same JSON), so the model lives in `shared/flights/types` and this
// module just re-exports it for feature-local imports.

export {
  FLIGHT_STAGE_KEYS,
  ACTIVE_FLIGHT_STATUSES,
  isActiveFlightStatus,
  isTerminalFlightStatus,
} from '../../../../../../shared/flights/types'

export type {
  FlightStageKey,
  FlightStageStatus,
  FlightCheckpointKind,
  FlightCheckpoint,
  FlightCheckpointResponse,
  FlightStage,
  FlightStatus,
  FlightOptions,
  FlightManifest,
  FlightIndexEntry,
} from '../../../../../../shared/flights/types'
