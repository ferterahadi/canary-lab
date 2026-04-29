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

export interface RunDetail {
  runId: string
  manifest: RunManifest
}

export function getRunDetail(logsDir: string, runId: string): RunDetail | null {
  const dir = runDirFor(logsDir, runId)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  const m = readManifest(manifestPath)
  if (!m) return null
  return { runId, manifest: m }
}
