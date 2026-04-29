import fs from 'fs'
import path from 'path'
import { readManifest, readRunsIndex, type RunIndexEntry, type RunManifest } from '../../../shared/e2e-runner/manifest'
import { runDirFor } from '../../../shared/e2e-runner/run-paths'

// Read-side helpers for the run history. The in-memory orchestrator map is
// kept in `OrchestratorRegistry` (defined here as an interface so the route
// layer takes any compatible implementation — production uses the real one,
// tests pass a stub).

export interface OrchestratorLike {
  runId: string
  stop(finalStatus?: RunManifest['status']): Promise<void>
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
  // Newest first by startedAt (ISO strings sort lexicographically).
  return [...filtered].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
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
