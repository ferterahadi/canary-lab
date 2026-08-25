// Public surface of the `runs` feature.
//
// Other features import from here, never from a path inside this directory —
// tools/check-feature-boundaries.mjs enforces it. Adding a re-export widens
// this feature's contract, so add one deliberately.

export { DirtyReviewDialog } from './components/DirtyReviewDialog'
export { DirtyTestsPill } from './components/DirtyTestsPill'
export { ExternalDraftAgentPanel } from './components/ExternalDraftAgentPanel'
export { RunDetailColumn } from './components/RunDetailColumn'
export { RunRow } from './components/RunRow'
export { ServicesDialog } from './components/ServicesDialog'
export {
  useActiveBootSessions,
  useActiveRuns,
  useActiveVerifyRuns,
  useRun,
  useRunDetails,
  useRuns,
} from './state/RunsContext'
export { sourceLineForBodyLine } from './utils/editor-location'
export {
  activeBodyLineForTest,
  colorClassForStatus,
  runningTestForSummaryName,
  statusForTest,
  statusLabel,
  statusPillClassForStatus,
  summaryEntryName,
} from './utils/test-step-status'
export type { StepStatus } from './utils/test-step-status'
