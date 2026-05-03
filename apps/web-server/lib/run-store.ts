import fs from 'fs'
import path from 'path'
import { readManifest, readRunsIndex, updateManifest, upsertRunsIndexEntry, writeRunsIndex, type RunIndexEntry, type RunManifest } from '../../../shared/e2e-runner/manifest'
import { runDirFor } from '../../../shared/e2e-runner/run-paths'

/** A run is considered stale if its heartbeat is older than this (ms). */
const HEARTBEAT_STALE_MS = 15_000

// Read-side helpers for the run history. The in-memory orchestrator map is
// kept in `OrchestratorRegistry` (defined here as an interface so the route
// layer takes any compatible implementation — production uses the real one,
// tests pass a stub).

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
  | { ok: false; reason: 'no-agent-running' | 'no-session-id' | 'spawn-failed' }

export interface OrchestratorLike {
  runId: string
  stop(finalStatus?: RunManifest['status']): Promise<void>
  pauseAndHeal(): Promise<OrchestratorPauseResult>
  cancelHeal(): Promise<OrchestratorCancelHealResult>
  /** Interject — kill the running heal agent and resume it with a new prompt
   *  built from `text`. Returns a structured failure when there's no agent or
   *  the agent's session id hasn't been captured yet. */
  interjectHealAgent?(text: string): Promise<OrchestratorInterjectResult>
}

export interface OrchestratorRegistry {
  get(runId: string): OrchestratorLike | undefined
  set(runId: string, orch: OrchestratorLike): void
  delete(runId: string): boolean
  list(): OrchestratorLike[]
}

export function createRegistry(): OrchestratorRegistry {
  const map = new Map<string, OrchestratorLike>()
  return {
    get: (id) => map.get(id),
    set: (id, o) => { map.set(id, o) },
    delete: (id) => map.delete(id),
    list: () => [...map.values()],
  }
}

export interface ListRunsOptions {
  feature?: string
}

export function listRuns(logsDir: string, opts: ListRunsOptions = {}): RunIndexEntry[] {
  const all = readRunsIndex(logsDir)
  const filtered = opts.feature ? all.filter((e) => e.feature === opts.feature) : all
  return [...filtered].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
}

/**
 * One-shot cleanup for runs left in `running`/`healing` state by a previous
 * server process that crashed without writing a final status. Intended to run
 * once at server boot — never on a hot read path. A run is reaped only when
 * its manifest carries a `heartbeatAt` older than `HEARTBEAT_STALE_MS`; runs
 * with no `heartbeatAt` (legacy manifests written before the field existed)
 * are left untouched.
 */
export async function reapStaleRuns(
  logsDir: string,
  registry?: OrchestratorRegistry,
): Promise<void> {
  const all = readRunsIndex(logsDir)
  const now = Date.now()

  for (const entry of all) {
    if (entry.status !== 'running' && entry.status !== 'healing') continue
    const manifestPath = path.join(runDirFor(logsDir, entry.runId), 'manifest.json')
    const manifest = readManifest(manifestPath)
    if (!manifest) continue
    if (!manifest.heartbeatAt) continue
    const heartbeat = new Date(manifest.heartbeatAt).getTime()
    if (Number.isNaN(heartbeat) || now - heartbeat <= HEARTBEAT_STALE_MS) continue

    const orch = registry?.get(entry.runId)
    if (orch) {
      await orch.stop('aborted').catch(() => {})
      registry!.delete(entry.runId)
    }

    const endedAt = manifest.heartbeatAt
    updateManifest(manifestPath, { status: 'aborted', endedAt })
    upsertRunsIndexEntry(logsDir, { ...entry, status: 'aborted', endedAt })
  }
}

/**
 * Remove a run from history: drop its entry from `runs/index.json` and
 * recursively delete the run directory. Returns `true` when something was
 * actually removed (entry existed or directory existed), `false` when
 * neither did. Caller is responsible for verifying the run is in a terminal
 * state — this does NOT stop a running orchestrator.
 */
export function removeRunFromHistory(logsDir: string, runId: string): boolean {
  let changed = false
  const entries = readRunsIndex(logsDir)
  const next = entries.filter((e) => e.runId !== runId)
  if (next.length !== entries.length) {
    writeRunsIndex(logsDir, next)
    changed = true
  }
  const dir = runDirFor(logsDir, runId)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    changed = true
  }
  return changed
}

export interface RunSummaryFailedEntry {
  name: string
  error?: { message: string; snippet?: string }
  durationMs?: number
  location?: string
  retry?: number
  logFiles?: string[]
}

export interface RunSummary {
  complete: boolean
  total: number
  passed: number
  /** Names of tests that have actually passed. Distinct from `passed` (count)
   *  so the UI can mark only-run tests as passed without falsely turning
   *  unrun tests green when the suite stops early (pause / max-failures). */
  passedNames?: string[]
  failed: RunSummaryFailedEntry[]
}

export interface RunDetail {
  runId: string
  manifest: RunManifest
  summary?: RunSummary
}

// Read e2e-summary.json if present. Returns undefined when absent or
// unreadable — the caller should treat that as "no per-test results yet".
export function readRunSummary(runDir: string): RunSummary | undefined {
  const p = path.join(runDir, 'e2e-summary.json')
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf-8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as RunSummary
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function getRunDetail(logsDir: string, runId: string): RunDetail | null {
  const dir = runDirFor(logsDir, runId)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  const m = readManifest(manifestPath)
  if (!m) return null
  const summary = readRunSummary(dir)
  return summary ? { runId, manifest: m, summary } : { runId, manifest: m }
}
