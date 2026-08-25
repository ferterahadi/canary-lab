import { type RunManifest } from './runtime/manifest'
import { reapStaleRuns, removeRunFromHistory } from './run-cleanup'
import { getRunDetail, readRunSummary } from './run-detail'
import { RunStore, listRuns } from './run-store'

// `RunStore` is the single mutator for everything the runs feature persists:
// `logs/runs/<runId>/manifest.json`, `logs/runs/index.json`, and the per-run
// dirs. Routes and the orchestrator both go through it
// so:
//   1. invariants (e.g. "writes drop on a stopped orchestrator") live in one
//      place,
//   2. every mutation emits a `change` event the WebSocket layer (Phase 2)
//      forwards to subscribed browsers — no polling needed.
// The standalone helpers (`listRuns`, `getRunDetail`, `removeRunFromHistory`,
// `reapStaleRuns`, `readRunSummary`) remain exported so legacy callers and the
// existing tests keep working; the class wraps them and emits events.

// PauseResult is structurally compatible with RunOrchestrator.PauseResult —
// duplicated here so the route layer doesn't need to import the orchestrator
// concrete class.
export type OrchestratorPauseResult =
  | { ok: true; failureCount: number }
  | { ok: false; reason: 'already-healing' | 'no-playwright-running' | 'no-failures-yet' }

export type OrchestratorCancelHealResult =
  | { ok: true }
  | { ok: false; reason: 'not-healing' | 'no-agent-running' }

export type OrchestratorInterjectResult =
  | { ok: true }
  | { ok: false; reason: 'no-agent-running' }

export type RestartHealResult =
  | { ok: true }
  | { ok: false; reason: 'run-not-found' | 'not-restartable' | 'manual-mode' | 'spawn-failed' }

export type RestartRunResult =
  | { ok: true; mode: 'remaining' }
  | { ok: false; reason: 'run-not-found' | 'not-restartable' | 'already-active' | 'spawn-failed' }

export interface OrchestratorLike {
  runId: string
  stop(finalStatus?: RunManifest['status']): Promise<void>
  pauseAndHeal(): Promise<OrchestratorPauseResult>
  cancelHeal(): Promise<OrchestratorCancelHealResult>
  /** Interject — drop the user's text into the live REPL's stdin (Esc-then-
   *  text-then-Enter). Used by the HTTP fallback route. The bidirectional
   *  pane bypasses this and goes through `writeToHealAgent` instead. */
  interjectHealAgent?(text: string): Promise<OrchestratorInterjectResult>
  /** Raw pty-stdin write for the heal agent. Used by the WS pane handler to
   *  forward keystrokes from xterm.js straight into the running REPL. No-op
   *  when no pty is attached. */
  writeToHealAgent?(chunk: string): void
  /** Push xterm dimensions into the heal agent pty so claude's TUI renders
   *  at the actual pane width. No-op when no pty is attached or when
   *  cols/rows aren't sane positive integers. */
  resizeHealAgent?(cols: number, rows: number): void
}

export interface OrchestratorRegistry {
  get(runId: string): OrchestratorLike | undefined
  set(runId: string, orch: OrchestratorLike): void
  delete(runId: string): boolean
  list(): OrchestratorLike[]
}

/**
 * Result of a start-run request under concurrency. A run either starts now,
 * is queued (resource budget full, or it declined worktree isolation on a
 * same-repo collision), or the caller must choose how to handle a same-repo
 * collision (isolate in a worktree vs queue) before anything starts.
 */
export type StartRunOutcome =
  | { kind: 'started'; orch: OrchestratorLike }
  | { kind: 'queued'; runId: string; reason: 'resources' | 'repo-collision' }
  | { kind: 'collision'; conflictingRunId: string; conflictingFeature: string; repoPaths: string[] }

export function createRegistry(): OrchestratorRegistry {
  const map = new Map<string, OrchestratorLike>()
  return {
    get: (id) => map.get(id),
    set: (id, o) => { map.set(id, o) },
    delete: (id) => map.delete(id),
    list: () => [...map.values()],
  }
}
