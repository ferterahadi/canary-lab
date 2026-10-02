import type { RunIndexEntry } from '../../../../../../../shared/run-index'
import { normalizeFixCaptureNames } from '../fix-capture-names'
import fs from 'fs'
import path from 'path'
import { runsIndexPath } from './run-paths'
import type { ServiceStatus } from '../../../../../../../shared/run-state'
import { atomicWriteJson } from '../../../../../../../shared/lib/atomic-write'
import type { ServiceManifestEntry, RunManifest } from '../../../../../../../shared/run-manifest'

/** The directory a READER of this run should take the suite's content from: the
 *  run-start copy while it exists (the verdict executed it — D9), else the live
 *  feature dir. One resolver for every after-the-fact reader (the evaluation
 *  report, the certificate) so none of them renders live source against a
 *  verdict that ran the copy. `undefined` when the run recorded no feature dir. */
export function suiteDirForReading(manifest: Pick<RunManifest, 'featureDir' | 'suiteSnapshot'>): string | undefined {
  const snapshot = manifest.suiteSnapshot
  if (snapshot?.kind === 'taken' && fs.existsSync(snapshot.dir)) return snapshot.dir
  return manifest.featureDir
}

/** Older Lab runs cannot be replayed after the perturbation runtime is retired. */
export function hasRetiredPerturbation(manifest: RunManifest): boolean {
  return Object.prototype.hasOwnProperty.call(manifest, 'perturbation')
}

export function writeManifest(manifestPath: string, manifest: RunManifest): void {
  atomicWriteJson(manifestPath, manifest)
}

export function readManifest(manifestPath: string): RunManifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RunManifest
    if (manifest.fixCapture) {
      manifest.fixCapture.repos = manifest.fixCapture.repos.map(normalizeFixCaptureNames)
    }
    return manifest
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

export function updateServiceStatus(
  manifestPath: string,
  safeName: string,
  status: ServiceStatus,
): RunManifest | null {
  const current = readManifest(manifestPath)
  if (!current) return null
  const services = current.services.map((s) =>
    s.safeName === safeName ? { ...s, status, ...serviceStatusStamp(s, status) } : s,
  )
  const next = { ...current, services }
  writeManifest(manifestPath, next)
  return next
}

/** Timestamp for the two transitions worth measuring. Only ever stamps the
 *  FIRST arrival: a service that goes ready → stopped → ready (a heal restart)
 *  keeps its original boot timing rather than reporting the restart's. */
function serviceStatusStamp(
  service: ServiceManifestEntry,
  status: ServiceStatus,
): Partial<ServiceManifestEntry> {
  if (status === 'starting' && !service.startingAt) return { startingAt: new Date().toISOString() }
  if (status === 'ready' && !service.readyAt) return { readyAt: new Date().toISOString() }
  return {}
}

export function updateAllServicesStatus(
  manifestPath: string,
  status: ServiceStatus,
): RunManifest | null {
  const current = readManifest(manifestPath)
  if (!current) return null
  const services = current.services.map((s) => ({ ...s, status }))
  const next = { ...current, services }
  writeManifest(manifestPath, next)
  return next
}

// runs/index.json — array of {runId, feature, startedAt, status, endedAt?}.
// Atomically rewritten on every change. Tiny file, dozens of entries max.

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
  atomicWriteJson(runsIndexPath(logsDir), entries)
}

/** Merge `entry` over the run's existing row (a caller rarely knows every
 *  field). Merging keeps a key the new entry omits, which is right for
 *  `endedAt` and wrong for a count that legitimately went to nothing — name
 *  those in `clear` and they are dropped before the merge, so an absent key
 *  means absent. */
export function upsertRunsIndexEntry(
  logsDir: string,
  entry: RunIndexEntry,
  opts: { clear?: Array<keyof RunIndexEntry> } = {},
): RunIndexEntry[] {
  const entries = readRunsIndex(logsDir)
  const idx = entries.findIndex((e) => e.runId === entry.runId)
  if (idx === -1) {
    entries.push(entry)
  } else {
    const existing = { ...entries[idx] }
    for (const key of opts.clear ?? []) delete existing[key]
    entries[idx] = { ...existing, ...entry }
  }
  writeRunsIndex(logsDir, entries)
  return entries
}
