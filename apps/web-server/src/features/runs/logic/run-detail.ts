import fs from 'fs'
import path from 'path'
import type { PathType } from '../../../../../../shared/coverage/types'
import { readManifest, type RunLifecycleEvent, type RunManifest } from './runtime/manifest'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import { PlaywrightArtifactGroup, indexPlaywrightArtifacts } from './run-artifacts'

export interface RunSummaryFailedEntry {
  id?: string
  name: string
  error?: { message: string; snippet?: string }
  durationMs?: number
  location?: string
  retry?: number
  logFiles?: string[]
  /** Repo-relative path to `failed/<slug>/error.txt` — the full, untruncated
   *  error message + code-frame written by log enrichment. Persisted in the
   *  summary JSON; surfaced as `errorPath` in the heal pointer bundle. */
  errorFile?: string
}

export interface RunSummaryRunningStep {
  title: string
  category: string
  location?: string
  locations?: string[]
}

export interface RunSummary {
  complete: boolean
  total: number
  passed: number
  /** Names of tests that have actually passed. Distinct from `passed` (count)
   *  so the UI can mark only-run tests as passed without falsely turning
   *  unrun tests green when the suite stops early (pause / max-failures). */
  passedNames?: string[]
  passedIds?: string[]
  /** Names of tests Playwright reported as skipped. Kept separate from
   *  `failed` so the UI and heal loop do not treat skipped tests as failures. */
  skipped?: number
  skippedNames?: string[]
  skippedIds?: string[]
  knownTests?: Array<{
    id?: string
    name: string
    title?: string
    titlePath?: string[]
    location?: string
    // Verified-coverage linkage. Optional / forward-compat: the Playwright
    // reporter (a subprocess) builds knownTests from TestCase objects and does
    // not parse comment annotations, so these are normally resolved at coverage-
    // computation time by joining test identity (name + location) against the
    // current spec's `@requirement`/`@path` annotations. Kept on the type so the
    // join result can be attached and a future reporter could stamp them.
    requirements?: string[]
    pathTypes?: PathType[]
  }>
  /** Currently-running Playwright test, emitted by the reporter on
   *  onTestBegin. Cleared when the matching onTestEnd lands. */
  running?: { id?: string; name: string; location: string; step?: RunSummaryRunningStep }
  /** All currently-running Playwright tests. Present when Playwright workers
   *  run multiple test cases concurrently. */
  runningTests?: Array<{ id?: string; name: string; location: string; step?: RunSummaryRunningStep }>
  failed: RunSummaryFailedEntry[]
}

export type PlaywrightPlaybackEvent =
  | {
      type: 'test-begin'
      time: string
      test: { name: string; title: string; location: string }
    }
  | {
      type: 'step-begin' | 'step-end'
      time: string
      test: { name: string; title: string }
      step: RunSummaryRunningStep
    }
  | {
      type: 'test-end'
      time: string
      test: { name: string; title: string; location: string }
      status: string
      passed: boolean
      durationMs: number
      retry: number
      error?: { message: string; snippet?: string }
      attachments?: Array<{ name: string; contentType?: string; path?: string }>
    }

export interface RunDetail {
  runId: string
  manifest: RunManifest
  summary?: RunSummary
  playbackEvents?: PlaywrightPlaybackEvent[]
  playwrightArtifacts?: PlaywrightArtifactGroup[]
  lifecycleEvents?: RunLifecycleEvent[]
}

export function readRunLifecycleEvents(runDir: string): RunLifecycleEvent[] | undefined {
  const p = buildRunPaths(runDir).lifecycleEventsPath
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf-8')
  } catch {
    return undefined
  }
  const out: RunLifecycleEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as RunLifecycleEvent
      if (parsed && typeof parsed === 'object' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      // Ignore corrupt partial lines; the manifest snapshot remains usable.
    }
  }
  return out.length > 0 ? out : undefined
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
    return normalizeRunSummary(parsed)
  } catch {
    return undefined
  }
}

/** The run's score, straight off the summary artifact — `passed` and `total` are
 *  read, never derived (a test absent from every result list is NOT RUN, so
 *  `total - failed` would silently count it as passed). `failed` is the length of
 *  the failed list, which is what a stage sentence and a flight's evidence
 *  report. Absent summary (older run, never listed) → no count keys at all
 *  rather than zeros that would read as "nothing failed".
 *  Lives here rather than in the run stage because the read-time evidence probe
 *  (workspace-evidence.ts) must report the SAME score the conducted stage wrote. */
export function runCounts(summary: RunSummary | undefined): { passed: number; total: number; failed: number } | undefined {
  if (!summary || typeof summary.total !== 'number' || typeof summary.passed !== 'number') return undefined
  return { passed: summary.passed, total: summary.total, failed: summary.failed?.length ?? 0 }
}

export function normalizeRunSummary(summary: RunSummary): RunSummary {
  if (!Array.isArray(summary.knownTests) || summary.knownTests.length === 0) return summary

  const knownTests: NonNullable<RunSummary['knownTests']> = []
  const indexByLogicalKey = new Map<string, number>()
  const idRemap = new Map<string, string>()
  for (const entry of summary.knownTests) {
    const logicalKey = knownTestLogicalKey(entry)
    if (!logicalKey) {
      knownTests.push(entry)
      continue
    }
    const existingIndex = indexByLogicalKey.get(logicalKey)
    if (existingIndex === undefined) {
      indexByLogicalKey.set(logicalKey, knownTests.length)
      knownTests.push(entry)
      continue
    }
    const previous = knownTests[existingIndex]
    if (previous.id && entry.id && previous.id !== entry.id) idRemap.set(previous.id, entry.id)
    knownTests[existingIndex] = entry
  }
  if (knownTests.length === summary.knownTests.length && idRemap.size === 0) return summary

  return {
    ...summary,
    total: knownTests.length,
    knownTests,
    ...(summary.passedIds ? { passedIds: remapIds(summary.passedIds, idRemap) } : {}),
    ...(summary.skippedIds ? { skippedIds: remapIds(summary.skippedIds, idRemap) } : {}),
    failed: summary.failed.map((entry) => remapSummaryEntryId(entry, idRemap)),
    ...(summary.running ? { running: remapSummaryEntryId(summary.running, idRemap) } : {}),
    ...(summary.runningTests ? { runningTests: summary.runningTests.map((entry) => remapSummaryEntryId(entry, idRemap)) } : {}),
  }
}

export function knownTestLogicalKey(entry: NonNullable<RunSummary['knownTests']>[number]): string | undefined {
  return entry.titlePath?.length ? [...entry.titlePath, entry.title ?? ''].join('\u001f') : undefined
}

export function remapIds(ids: string[], idRemap: Map<string, string>): string[] {
  return [...new Set(ids.map((id) => idRemap.get(id) ?? id))]
}

export function remapSummaryEntryId<T extends { id?: string }>(entry: T, idRemap: Map<string, string>): T {
  if (!entry.id) return entry
  const mapped = idRemap.get(entry.id)
  return mapped ? { ...entry, id: mapped } : entry
}

export function readPlaywrightPlaybackEvents(runDir: string): PlaywrightPlaybackEvent[] | undefined {
  const p = buildRunPaths(runDir).playwrightEventsPath
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf-8')
  } catch {
    return undefined
  }
  const out: PlaywrightPlaybackEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as PlaywrightPlaybackEvent
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') out.push(parsed)
    } catch {
      // Ignore corrupt partial lines; the terminal log remains authoritative.
    }
  }
  return out
}

export function getRunDetail(logsDir: string, runId: string): RunDetail | null {
  const dir = runDirFor(logsDir, runId)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  const m = readManifest(manifestPath)
  if (!m) return null
  const summary = readRunSummary(dir)
  const playbackEvents = readPlaywrightPlaybackEvents(dir)
  const playwrightArtifacts = indexPlaywrightArtifacts(runId, dir, playbackEvents)
  const lifecycleEvents = readRunLifecycleEvents(dir)
  return {
    runId,
    manifest: m,
    ...(summary ? { summary } : {}),
    ...(playbackEvents?.length ? { playbackEvents } : {}),
    ...(playwrightArtifacts?.length ? { playwrightArtifacts } : {}),
    ...(lifecycleEvents?.length ? { lifecycleEvents } : {}),
  }
}
