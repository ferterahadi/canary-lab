import fs from 'fs'
import path from 'path'
import { runDirFor, runsIndexPath, runsRoot } from './run-paths'

// Per-run manifest written at start and updated at finish. Kept narrow and
// JSON-shaped so the future server can read it without parsing logs.

export interface ServiceManifestEntry {
  name: string
  safeName: string
  command: string
  cwd: string
  logPath: string
  healthUrl?: string
}

export type RunStatus = 'running' | 'passed' | 'failed' | 'healing' | 'aborted'

export interface RunManifest {
  runId: string
  feature: string
  featureDir?: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  healCycles: number
  services: ServiceManifestEntry[]
  repoPaths?: string[]
}

function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

export function writeManifest(manifestPath: string, manifest: RunManifest): void {
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

export function readManifest(manifestPath: string): RunManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RunManifest
  } catch {
    return null
  }
}

export function updateManifest(
  manifestPath: string,
  patch: Partial<RunManifest>,
): RunManifest | null {
  const current = readManifest(manifestPath)
  if (!current) return null
  const next = { ...current, ...patch }
  writeManifest(manifestPath, next)
  return next
}

// runs/index.json — array of {runId, feature, startedAt, status, endedAt?}.
// Atomically rewritten on every change. Tiny file, dozens of entries max.

export interface RunIndexEntry {
  runId: string
  feature: string
  startedAt: string
  status: RunStatus
  endedAt?: string
}

export function readRunsIndex(logsDir: string): RunIndexEntry[] {
  try {
    const raw = fs.readFileSync(runsIndexPath(logsDir), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeRunsIndex(logsDir: string, entries: RunIndexEntry[]): void {
  atomicWrite(runsIndexPath(logsDir), JSON.stringify(entries, null, 2) + '\n')
}

export function upsertRunsIndexEntry(
  logsDir: string,
  entry: RunIndexEntry,
): RunIndexEntry[] {
  const entries = readRunsIndex(logsDir)
  const idx = entries.findIndex((e) => e.runId === entry.runId)
  if (idx === -1) {
    entries.push(entry)
  } else {
    entries[idx] = { ...entries[idx], ...entry }
  }
  writeRunsIndex(logsDir, entries)
  return entries
}

// Update or remove the `logs/current` symlink so legacy heal-index path
// expectations (which read `logs/current/heal-index.md`) keep working.
export function setCurrentRunSymlink(logsDir: string, runId: string | null): void {
  const link = path.join(logsDir, 'current')
  try {
    fs.rmSync(link, { recursive: true, force: true })
  } catch {
    /* no existing link — fine */
  }
  if (runId === null) return
  fs.mkdirSync(runsRoot(logsDir), { recursive: true })
  const target = path.relative(logsDir, runDirFor(logsDir, runId))
  try {
    fs.symlinkSync(target, link, 'dir')
  } catch {
    // Symlinks may fail on some filesystems (e.g. Windows without admin). Fall
    // back to a tiny pointer file so callers can still resolve the path.
    try {
      fs.writeFileSync(link, target)
    } catch {
      /* best-effort */
    }
  }
}
