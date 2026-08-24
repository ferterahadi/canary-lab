// Public surface of the `evaluation` feature.
//
// Other features import from here, never from a path inside this directory —
// tools/check-feature-boundaries.mjs enforces it. Adding a re-export widens
// this feature's contract, so add one deliberately.

export { useEvaluationExports } from './state/EvaluationExportContext'
// One export task in place (status line, output pane, download) — the flight's
// Evaluation Report stage mounts it for a live external export.
export { EvaluationTaskPanel } from './components/EvaluationTaskPanel'
