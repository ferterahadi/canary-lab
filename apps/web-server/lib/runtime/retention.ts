import fs from 'fs'
import path from 'path'
import { isValidRunId } from './run-id'
import { runsRoot, runsIndexPath } from './run-paths'
import { readRunsIndex, writeRunsIndex } from './manifest'

// Keeps the most recent N run dirs on disk and prunes the rest. Diagnosis
// journal lives at the repo root and is intentionally untouched.

export const DEFAULT_RETENTION = 20

export function resolveRetention(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CANARY_LAB_RUN_RETENTION
  if (!raw) return DEFAULT_RETENTION
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION
  return parsed
}

export function listRunDirs(logsDir: string): string[] {
  const root = runsRoot(logsDir)
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && isValidRunId(e.name))
    .map((e) => e.name)
    // Run IDs sort lexicographically because the timestamp prefix is fixed-width.
    .sort()
}

export interface PruneResult {
  kept: string[]
  removed: string[]
}

export function pruneRuns(
  logsDir: string,
  retention: number = resolveRetention(),
): PruneResult {
  if (retention <= 0) return { kept: [], removed: [] }
  const all = listRunDirs(logsDir)
  if (all.length <= retention) return { kept: all, removed: [] }
  const removed = all.slice(0, all.length - retention)
  const kept = all.slice(all.length - retention)

  for (const id of removed) {
    try {
      fs.rmSync(path.join(runsRoot(logsDir), id), { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }

  // Also drop pruned entries from the runs index so the future server's listing
  // matches what's on disk.
  try {
    if (fs.existsSync(runsIndexPath(logsDir))) {
      const removedSet = new Set(removed)
      const filtered = readRunsIndex(logsDir).filter((e) => !removedSet.has(e.runId))
      writeRunsIndex(logsDir, filtered)
    }
  } catch {
    /* best-effort */
  }

  return { kept, removed }
}
