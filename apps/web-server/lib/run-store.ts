import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import type { PathType } from '../../../shared/coverage/types'
import {
  readManifest,
  readRunsIndex,
  updateManifest,
  upsertRunsIndexEntry,
  writeManifest,
  writeRunsIndex,
  type RunLifecycleEvent,
  type RunIndexEntry,
  type RunManifest,
  type ServiceStatus,
} from './runtime/manifest'
import { buildRunPaths, runDirFor, runsRoot } from './runtime/run-paths'
import { FileRunStateSink, type RunStateSink } from './runtime/run-state-sink'
import type { ExecutionType } from '../../../shared/verification'
import {
  HEARTBEAT_STALE_MS,
  isActiveRunStatus,
  isStaleHeartbeat,
} from '../../../shared/run-state'

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

export interface ListRunsOptions {
  feature?: string
}

// Standalone helper kept for backwards compatibility (existing tests + the
// reapStaleRuns export below). Production code should prefer
// `RunStore.list()`.
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
    if (!isActiveRunStatus(entry.status)) continue
    const manifestPath = path.join(runDirFor(logsDir, entry.runId), 'manifest.json')
    const manifest = readManifest(manifestPath)
    if (!manifest) {
      // Active index entry with no readable manifest. A live run always writes
      // its manifest before its index entry (FileRunStateSink.bootstrap), so
      // this is an orphan left by a process that died mid-teardown (e.g. a
      // boot/manual-services run) — UNLESS an orchestrator is still registered
      // for it, in which case the run is genuinely live and the manifest read
      // merely glitched: leave it alone. Reap the orphan straight from the
      // index so it can't stay stuck active forever.
      if (registry?.get(entry.runId)) continue
      upsertRunsIndexEntry(logsDir, {
        ...entry,
        status: 'aborted',
        endedAt: entry.endedAt ?? new Date(now).toISOString(),
      })
      continue
    }
    if (!manifest.heartbeatAt) continue
    if (!isStaleHeartbeat(manifest.heartbeatAt, now, HEARTBEAT_STALE_MS)) continue

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

/** Recursively sum the byte size of every regular file under `dir`. Returns 0
 *  when the directory is absent or unreadable — callers treat missing artifacts
 *  as "nothing to reclaim". Symlinks are not followed (lstat). */
export function dirSizeBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += dirSizeBytes(full)
    } else if (entry.isFile()) {
      try { total += fs.statSync(full).size } catch { /* vanished mid-walk */ }
    }
  }
  return total
}

/** Byte size of the heavy Playwright artifact directories (videos / traces /
 *  screenshots) for a run — the two dirs `trimRunArtifacts` removes. */
export function runArtifactBytes(logsDir: string, runId: string): number {
  const paths = buildRunPaths(runDirFor(logsDir, runId))
  return dirSizeBytes(paths.playwrightArtifactsDir) + dirSizeBytes(paths.playwrightArtifactsKeepDir)
}

/** Delete ONLY a run's Playwright artifact directories (`playwright-artifacts`
 *  + `playwright-artifacts-keep`), reclaiming the bulk of its disk while
 *  leaving the manifest, summary, logs, and run-index entry intact — the run
 *  stays listed and inspectable, just without video/trace playback. Returns the
 *  number of bytes freed. Caller is responsible for verifying the run is
 *  terminal; this does not stop a running orchestrator. */
export function trimRunArtifacts(logsDir: string, runId: string): number {
  const paths = buildRunPaths(runDirFor(logsDir, runId))
  let freed = 0
  for (const dir of [paths.playwrightArtifactsDir, paths.playwrightArtifactsKeepDir]) {
    if (!fs.existsSync(dir)) continue
    freed += dirSizeBytes(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return freed
}

export interface RunSummaryFailedEntry {
  id?: string
  name: string
  error?: { message: string; snippet?: string }
  durationMs?: number
  location?: string
  retry?: number
  logFiles?: string[]
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

export type PlaywrightArtifactKind = 'screenshot' | 'trace' | 'video' | 'other'

export interface PlaywrightArtifact {
  name: string
  kind: PlaywrightArtifactKind
  path: string
  url: string
  contentType?: string
  sizeBytes: number
  mtimeMs: number
}

export interface PlaywrightArtifactGroup {
  testName: string
  testTitle?: string
  artifacts: PlaywrightArtifact[]
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

function normalizeRunSummary(summary: RunSummary): RunSummary {
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

function knownTestLogicalKey(entry: NonNullable<RunSummary['knownTests']>[number]): string | undefined {
  return entry.titlePath?.length ? [...entry.titlePath, entry.title ?? ''].join('\u001f') : undefined
}

function remapIds(ids: string[], idRemap: Map<string, string>): string[] {
  return [...new Set(ids.map((id) => idRemap.get(id) ?? id))]
}

function remapSummaryEntryId<T extends { id?: string }>(entry: T, idRemap: Map<string, string>): T {
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

export function indexPlaywrightArtifacts(
  runId: string,
  runDir: string,
  events: PlaywrightPlaybackEvent[] | undefined,
): PlaywrightArtifactGroup[] | undefined {
  const paths = buildRunPaths(runDir)
  const currentDir = paths.playwrightArtifactsDir
  const keepDir = paths.playwrightArtifactsKeepDir
  const hasCurrent = fs.existsSync(currentDir)
  const hasKeep = fs.existsSync(keepDir)
  if (!hasCurrent && !hasKeep) return undefined

  const groups = new Map<string, PlaywrightArtifactGroup>()
  const seen = new Set<string>()
  const seenRel = new Set<string>()
  const titleByName = new Map<string, string>()
  const testNameByArtifactDir = new Map<string, string>()
  for (const event of events ?? []) {
    if ('test' in event && event.test?.title) titleByName.set(event.test.name, event.test.title)
  }

  // Resolve a filePath against the current dir first, falling back to the
  // keep dir when current has been wiped by the next Playwright invocation.
  // The returned `rel` is always relative to `currentDir` so URL generation
  // and dedup keys stay stable regardless of which physical directory the
  // file currently lives in (the artifact-serving route looks in both).
  const resolveFile = (filePath: string): { resolved: string; rel: string } | null => {
    const abs = path.resolve(filePath)
    const relCurrent = path.relative(currentDir, abs)
    if (!relCurrent.startsWith('..') && !path.isAbsolute(relCurrent)) {
      if (hasCurrent && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return { resolved: abs, rel: relCurrent }
      }
      if (hasKeep) {
        const keepCandidate = path.join(keepDir, relCurrent)
        if (fs.existsSync(keepCandidate) && fs.statSync(keepCandidate).isFile()) {
          return { resolved: keepCandidate, rel: relCurrent }
        }
      }
    }
    return null
  }

  const add = (testName: string, filePath: string, name?: string, contentType?: string): void => {
    const found = resolveFile(filePath)
    if (!found) return
    const { resolved, rel } = found
    const key = `${testName}:${rel}`
    if (seen.has(key) || seenRel.has(rel)) return
    const firstSegment = rel.split(path.sep)[0]
    testNameByArtifactDir.set(firstSegment, testName)
    seen.add(key)
    seenRel.add(rel)
    const group = groups.get(testName) ?? {
      testName,
      ...(titleByName.has(testName) ? { testTitle: titleByName.get(testName) } : {}),
      artifacts: [],
    }
    const stat = fs.statSync(resolved)
    group.artifacts.push({
      name: name || path.basename(resolved),
      kind: classifyArtifact(resolved, name, contentType),
      path: rel,
      url: artifactUrl(runId, rel),
      ...(contentType ? { contentType } : {}),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    })
    groups.set(testName, group)
  }

  for (const event of events ?? []) {
    if (event.type !== 'test-end') continue
    for (const attachment of event.attachments ?? []) {
      if (attachment.path) add(event.test.name, attachment.path, attachment.name, attachment.contentType)
    }
  }

  // Walk current first, then keep. Each file is keyed by its rel-against-
  // currentDir so a file present in both dirs is added once with the current
  // copy preferred.
  const walkDir = (dir: string): void => {
    if (!fs.existsSync(dir)) return
    for (const filePath of listFiles(dir)) {
      const rel = path.relative(dir, filePath)
      if (seenRel.has(rel)) continue
      const firstSegment = rel.split(path.sep)[0]
      // Synthesize a path rooted at currentDir so resolveFile picks whichever
      // dir actually contains the file and the rel-path → URL mapping stays
      // consistent.
      add(testNameByArtifactDir.get(firstSegment) ?? firstSegment, path.join(currentDir, rel))
    }
  }
  walkDir(currentDir)
  walkDir(keepDir)

  const indexed = [...groups.values()]
    .map((g) => ({
      ...g,
      artifacts: g.artifacts.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.testName.localeCompare(b.testName))
  return indexed.length > 0 ? indexed : undefined
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

function classifyArtifact(filePath: string, name?: string, contentType?: string): PlaywrightArtifactKind {
  const label = `${name ?? ''} ${contentType ?? ''} ${path.basename(filePath)}`.toLowerCase()
  if (label.includes('image/') || /\.(png|jpe?g|webp)$/.test(label)) return 'screenshot'
  if (label.includes('trace') || label.includes('application/zip') || /\.zip$/.test(label)) return 'trace'
  if (label.includes('video') || label.includes('video/') || /\.(webm|mp4)$/.test(label)) return 'video'
  return 'other'
}

function artifactUrl(runId: string, relPath: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${relPath.split(path.sep).map(encodeURIComponent).join('/')}`
}

function listFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  visit(root)
  return out
}

// ─── RunStore ────────────────────────────────────────────────────────────

export interface RunStoreEvent {
  /** What kind of mutation happened. Subscribers can use this to decide
   *  whether to refetch a single run or the whole list:
   *   - `bootstrap` / `changed` / `finalized` — single-run change
   *   - `removed` — single-run history removal
   *   - `index-changed` — list-level (e.g. reaper)
   *   - `external-heal-task` — a run held by an external client just entered
   *     `waiting-for-signal` and the client should fetch heal context.
   *   - `external-claim-changed` — claim / release / heartbeat-stale
   *     transitions for the external session that owns this run. */
  kind:
    | 'bootstrap'
    | 'changed'
    | 'finalized'
    | 'removed'
    | 'index-changed'
    | 'external-heal-task'
    | 'external-claim-changed'
  runId?: string
}

export type RunStoreEventListener = (e: RunStoreEvent) => void

export interface DeleteResult {
  ok: boolean
  reason?: 'active' | 'not-found' | 'stale'
}

export interface TrimResult {
  ok: boolean
  reason?: 'active' | 'not-found' | 'stale'
  /** Bytes reclaimed by removing the artifact dirs. Present when `ok`. */
  freedBytes?: number
}

/** One indexed run, annotated with disk usage for the cleanup view. */
export interface CleanupRunEntry {
  runId: string
  feature: string
  executionType: ExecutionType
  status: RunManifest['status']
  startedAt: string
  endedAt?: string
  /** Total bytes of the whole run directory. */
  folderBytes: number
  /** Bytes held by the trimmable Playwright artifact dirs (subset of folder). */
  artifactBytes: number
  /** True when the run is still live (registered orchestrator or active status).
   *  Active runs cannot be trimmed or deleted. */
  active: boolean
}

/** A directory under `logs/runs/` with no entry in `index.json` — an
 *  interrupted/never-finalized run. Delete-only; it has no manifest. */
export interface CleanupOrphan {
  runId: string
  folderBytes: number
}

export interface CleanupListing {
  runs: CleanupRunEntry[]
  orphans: CleanupOrphan[]
  totals: {
    /** Every run folder + every orphan folder. */
    totalBytes: number
    /** Artifact bytes reclaimable by trimming non-active runs. */
    reclaimableTrimBytes: number
    /** Folder bytes reclaimable by deleting non-active runs + all orphans. */
    reclaimableDeleteBytes: number
  }
}

/** Build the cleanup view: every indexed run annotated with disk usage and an
 *  `active` flag, plus orphan directories not present in the index, plus
 *  reclaimable totals. `isActive(runId, status)` lets the RunStore overlay the
 *  live orchestrator registry on top of the persisted status. */
export function listCleanupEntries(
  logsDir: string,
  isActive: (runId: string, status: RunManifest['status']) => boolean = (_id, status) => isActiveRunStatus(status),
): CleanupListing {
  const index = readRunsIndex(logsDir)
  const indexed = new Set(index.map((e) => e.runId))

  const runs: CleanupRunEntry[] = index.map((entry) => {
    const folderBytes = dirSizeBytes(runDirFor(logsDir, entry.runId))
    const artifactBytes = runArtifactBytes(logsDir, entry.runId)
    return {
      runId: entry.runId,
      feature: entry.feature,
      executionType: entry.executionType ?? 'run',
      status: entry.status,
      startedAt: entry.startedAt,
      ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
      folderBytes,
      artifactBytes,
      active: isActive(entry.runId, entry.status),
    }
  })

  const orphans: CleanupOrphan[] = []
  const root = runsRoot(logsDir)
  let rootEntries: fs.Dirent[] = []
  try {
    rootEntries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    rootEntries = []
  }
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue
    if (indexed.has(entry.name)) continue
    orphans.push({ runId: entry.name, folderBytes: dirSizeBytes(path.join(root, entry.name)) })
  }

  const totalBytes =
    runs.reduce((sum, r) => sum + r.folderBytes, 0) +
    orphans.reduce((sum, o) => sum + o.folderBytes, 0)
  const reclaimableTrimBytes = runs
    .filter((r) => !r.active)
    .reduce((sum, r) => sum + r.artifactBytes, 0)
  const reclaimableDeleteBytes =
    runs.filter((r) => !r.active).reduce((sum, r) => sum + r.folderBytes, 0) +
    orphans.reduce((sum, o) => sum + o.folderBytes, 0)

  return { runs, orphans, totals: { totalBytes, reclaimableTrimBytes, reclaimableDeleteBytes } }
}

export interface AbortResult {
  ok: boolean
  reason?: 'not-active'
}

export interface AbortAllResult {
  aborted: string[]
}

/**
 * Single owner of `logs/` mutations. Routes and the orchestrator both go
 * through this class — no other code should call `updateManifest` /
 * `upsertRunsIndexEntry` / `removeRunFromHistory` directly. Every mutation
 * emits an `event` so subscribers (the WS endpoint) can push updates without
 * polling.
 *
 * The class is composed of a `FileRunStateSink` (the actual file writes,
 * defined in lib/runtime/) plus an EventEmitter and the operational
 * methods (abort/delete/reapStale) that need access to the orchestrator
 * registry. It satisfies the `RunStateSink` interface so it can be passed
 * directly into the orchestrator constructor.
 */
export class RunStore extends EventEmitter implements RunStateSink {
  private readonly sink: FileRunStateSink

  constructor(
    public readonly logsDir: string,
    public readonly registry: OrchestratorRegistry,
  ) {
    super()
    this.sink = new FileRunStateSink(logsDir)
  }

  /** Typed `on`/`off` for the single `event` channel we publish.
   *  Inheriting `EventEmitter`'s loose `(...args: any[])` signature would
   *  accept the listener but lose the `RunStoreEvent` type at call sites
   *  — these wrappers preserve it. */
  onEvent(listener: RunStoreEventListener): this {
    super.on('event', listener)
    return this
  }

  offEvent(listener: RunStoreEventListener): this {
    super.off('event', listener)
    return this
  }

  // ─── reads ──────────────────────────────────────────────────────────

  list(opts: ListRunsOptions = {}): RunIndexEntry[] {
    return listRuns(this.logsDir, opts)
  }

  get(runId: string): RunDetail | null {
    return getRunDetail(this.logsDir, runId)
  }

  // ─── path helpers ───────────────────────────────────────────────────

  manifestPath(runId: string): string {
    return this.sink.manifestPath(runId)
  }

  // ─── writes (RunStateSink + emit) ───────────────────────────────────

  bootstrap(manifest: RunManifest): void {
    fs.mkdirSync(path.dirname(this.manifestPath(manifest.runId)), { recursive: true })
    this.sink.bootstrap(manifest)
    this.emitEvent({ kind: 'bootstrap', runId: manifest.runId })
  }

  patchManifest(runId: string, patch: Partial<RunManifest>): void {
    this.sink.patchManifest(runId, patch)
    this.emitEvent({ kind: 'changed', runId })
  }

  recordLifecycleEvent(runId: string, event: RunLifecycleEvent): void {
    this.sink.recordLifecycleEvent(runId, event)
    this.emitEvent({ kind: 'changed', runId })
    if (event.phase === 'waiting-for-signal') {
      const detail = this.get(runId)
      if (detail?.manifest.healMode === 'external') {
        this.emitEvent({ kind: 'external-heal-task', runId })
      }
    }
  }

  setStatus(runId: string, status: RunManifest['status'], healCycles?: number): void {
    this.sink.setStatus(runId, status, healCycles)
    this.emitEvent({ kind: 'changed', runId })
  }

  finalize(
    runId: string,
    status: RunManifest['status'],
    endedAt: string,
    healCycles: number,
  ): void {
    this.sink.finalize(runId, status, endedAt, healCycles)
    this.emitEvent({ kind: 'finalized', runId })
  }

  setServiceStatus(runId: string, safeName: string, status: ServiceStatus): void {
    this.sink.setServiceStatus(runId, safeName, status)
    this.emitEvent({ kind: 'changed', runId })
  }

  /** Append a heartbeat. Intentionally does NOT emit — heartbeats fire every
   *  5 s and would flood subscribers with no useful information. The next
   *  real status change carries the up-to-date heartbeat anyway. */
  recordHeartbeat(runId: string): void {
    this.sink.recordHeartbeat(runId)
  }

  // ─── operations ─────────────────────────────────────────────────────

  /** Abort an active or orphaned-active run. Registered orchestrators get the
   *  normal stop path; persisted running/healing rows without a registry entry
   *  are finalized directly so the UI can recover from a dead server process. */
  async abort(runId: string): Promise<AbortResult> {
    const orch = this.registry.get(runId)
    if (orch) {
      try { await orch.stop('aborted') } catch { /* best-effort */ }
      this.registry.delete(runId)
      // Test doubles and failed stop paths may not write terminal state. If
      // the persisted row still claims active, finalize it here.
      this.finalizePersistedActiveRun(runId)
      return { ok: true }
    }
    return this.finalizePersistedActiveRun(runId)
      ? { ok: true }
      : { ok: false, reason: 'not-active' }
  }

  /** Abort every active orchestrator, then repair any remaining persisted
   *  running/healing rows. Used by `canary-lab ui` SIGINT/SIGTERM cleanup. */
  async abortAllActiveOrStale(): Promise<AbortAllResult> {
    const aborted = new Set<string>()
    for (const orch of this.registry.list()) {
      // Registered orchestrators are always abortable through `abort()`.
      await this.abort(orch.runId)
      aborted.add(orch.runId)
    }
    for (const entry of this.list()) {
      if (!isActiveRunStatus(entry.status)) continue
      const result = await this.abort(entry.runId)
      if (result.ok) aborted.add(entry.runId)
    }
    return { aborted: [...aborted] }
  }

  /** Hard-delete a terminal run from history. Refuses (`reason: 'active'`)
   *  if an orchestrator is still registered, refuses (`reason: 'stale'`) if
   *  the manifest still claims active without a registered orchestrator. */
  delete(runId: string): DeleteResult {
    if (this.registry.get(runId)) return { ok: false, reason: 'active' }
    const detail = this.get(runId)
    if (!detail) {
      // No manifest. If a directory still exists it's an orphan (an
      // interrupted run that never finalized) — safe to reap since it isn't
      // registered and has no active status to honor. `removeRunFromHistory`
      // returns false when neither a dir nor an index entry exists.
      if (removeRunFromHistory(this.logsDir, runId)) {
        this.emitEvent({ kind: 'removed', runId })
        return { ok: true }
      }
      return { ok: false, reason: 'not-found' }
    }
    const status = detail.manifest.status
    if (isActiveRunStatus(status)) {
      return { ok: false, reason: 'stale' }
    }
    removeRunFromHistory(this.logsDir, runId)
    this.emitEvent({ kind: 'removed', runId })
    return { ok: true }
  }

  /** Reclaim disk by deleting a terminal run's Playwright artifact dirs while
   *  keeping the run in history. Same active/stale guards as `delete`. Emits
   *  `changed` so subscribers refresh the (now lighter) run. */
  trimArtifacts(runId: string): TrimResult {
    if (this.registry.get(runId)) return { ok: false, reason: 'active' }
    const detail = this.get(runId)
    if (!detail) return { ok: false, reason: 'not-found' }
    if (isActiveRunStatus(detail.manifest.status)) return { ok: false, reason: 'stale' }
    const freedBytes = trimRunArtifacts(this.logsDir, runId)
    this.emitEvent({ kind: 'changed', runId })
    return { ok: true, freedBytes }
  }

  /** Disk-usage view for the Log Cleanup page. Overlays the live orchestrator
   *  registry on top of persisted status so a run that just started (status
   *  not yet flipped) still reports `active`. */
  cleanupListing(): CleanupListing {
    return listCleanupEntries(
      this.logsDir,
      (runId, status) => Boolean(this.registry.get(runId)) || isActiveRunStatus(status),
    )
  }

  /** Remove a run from history without policy checks. The reaper uses this
   *  on stale entries; production callers should prefer `delete()`. */
  removeFromHistory(runId: string): boolean {
    const ok = removeRunFromHistory(this.logsDir, runId)
    if (ok) this.emitEvent({ kind: 'removed', runId })
    return ok
  }

  /** Boot-time cleanup. Mirrors the standalone `reapStaleRuns` but routes
   *  every write through this store so subscribers see the resulting state
   *  flips. Only emits `index-changed` once at the end (per-run emits would
   *  fire before the WS endpoint is subscribed at boot, so they'd be
   *  invisible anyway). */
  async reapStale(): Promise<void> {
    const before = readRunsIndex(this.logsDir).map((e) => `${e.runId}:${e.status}`).join('|')
    await reapStaleRuns(this.logsDir, this.registry)
    const after = readRunsIndex(this.logsDir).map((e) => `${e.runId}:${e.status}`).join('|')
    if (before !== after) this.emitEvent({ kind: 'index-changed' })
  }

  private emitEvent(event: RunStoreEvent): void {
    this.emit('event', event)
  }

  private finalizePersistedActiveRun(runId: string): boolean {
    const detail = this.get(runId)
    if (detail) {
      if (!isActiveRunStatus(detail.manifest.status)) return false
      this.finalize(runId, 'aborted', new Date().toISOString(), detail.manifest.healCycles)
      return true
    }
    // No manifest, but the run may still be listed as active in the index (an
    // interrupted boot run that never finalized). `finalize` writes the index
    // even without a manifest, so we can recover it from the index entry alone
    // — otherwise the UI Stop button would be a silent no-op against a zombie.
    const entry = this.list().find((e) => e.runId === runId)
    if (!entry || !isActiveRunStatus(entry.status)) return false
    this.finalize(runId, 'aborted', new Date().toISOString(), 0)
    return true
  }
}

// Re-export the manifest types most callers will want alongside RunStore so
// they don't need a second import.
export type { RunIndexEntry, RunManifest, ServiceManifestEntry } from './runtime/manifest'
