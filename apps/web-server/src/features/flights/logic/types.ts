// Flight background jobs — the conducted onboarding pipeline behind
// `canary-lab flight`. The manifest shapes are shared (UI pill/detail view + MCP
// read the same JSON), so the model lives in `shared/flights/types` and this
// module just re-exports it for feature-local imports.

export {
  CHECKPOINT_OPTIONS,
  FLIGHT_EXECUTION_ORDER,
  FLIGHT_STAGE_KEYS,
  STAGE_DEPENDS_ON,
  ACTIVE_FLIGHT_STATUSES,
  isActiveFlightStatus,
  isTerminalFlightStatus,
} from '../../../../../../shared/flights/types'

export type {
  AgentActivity,
  FlightStageKey,
  FlightStageStatus,
  FlightCheckpointKind,
  FlightCheckpoint,
  FlightCheckpointResponse,
  ExternalWorkCheckpointData,
  FlightStage,
  FlightStageAgentSession,
  FlightStageErrorDetail,
  FlightStatus,
  FlightOptions,
  FlightManifest,
  FlightIndexEntry,
  FlightStageEntryOption,
  FlightEntryOptions,
  PrdSourceAttempt,
  PrdSourceCheckpointData,
} from '../../../../../../shared/flights/types'
