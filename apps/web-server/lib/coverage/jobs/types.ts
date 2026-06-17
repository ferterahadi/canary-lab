// Async background jobs for the Verified Coverage workflow (R4). Coverage +
// PRD-summary generation are non-blocking, persistent, re-openable jobs modeled
// on the Portify subsystem (file-backed manifest + index + event emitter). A
// server-side single-flight guard rejects a second job of the same kind for the
// same feature while one is already running — the UI disable is cosmetic only.
//
// The manifest shapes are shared (UI dialog/pill + MCP read the same JSON).

export type {
  CoverageJobKind,
  CoverageJobStatus,
  CoverageJobResult,
  CoverageJobManifest,
  CoverageJobIndexEntry,
} from '../../../../../shared/coverage/types'
