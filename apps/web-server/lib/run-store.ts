import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import {
  readManifest,
  readRunsIndex,
  updateManifest,
  upsertRunsIndexEntry,
  writeManifest,
  writeRunsIndex,
  type RunIndexEntry,
  type RunManifest,
  type ServiceStatus,
} from './runtime/manifest'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import { FileRunStateSink, type RunStateSink } from './runtime/run-state-sink'

// `RunStore` is the single mutator for everything the runs feature persists:
// `logs/<runId>/manifest.json`, `logs/runs-index.json`, the per-run dirs, and
// the `logs/current` symlink. Routes and the orchestrator both go through it
// so:
//   1. invariants (e.g. "writes drop on a stopped orchestrator") live in one
//      place,
//   2. every mutation emits a `change` event the WebSocket layer (Phase 2)
//      forwards to subscribed browsers — no polling needed.
// The standalone helpers (`listRuns`, `getRunDetail`, `removeRunFromHistory`,
// `reapStaleRuns`, `readRunSummary`) remain exported so legacy callers and the
// existing tests keep working; the class wraps them and emits events.

/** A run is considered stale if its heartbeat is older than this (ms). */
const HEARTBEAT_STALE_MS = 15_000

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
  /** Currently-running Playwright test, emitted by the reporter on
   *  onTestBegin. Cleared when the matching onTestEnd lands. */
  running?: { name: string; location: string; step?: RunSummaryRunningStep }
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
  const artifactsDir = buildRunPaths(runDir).playwrightArtifactsDir
  if (!fs.existsSync(artifactsDir)) return undefined

  const groups = new Map<string, PlaywrightArtifactGroup>()
  const seen = new Set<string>()
  const seenRel = new Set<string>()
  const titleByName = new Map<string, string>()
  const testNameByArtifactDir = new Map<string, string>()
  for (const event of events ?? []) {
    if ('test' in event && event.test?.title) titleByName.set(event.test.name, event.test.title)
  }

  const add = (testName: string, filePath: string, name?: string, contentType?: string): void => {
    const resolved = path.resolve(filePath)
    const rel = path.relative(artifactsDir, resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return
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

  for (const filePath of listFiles(artifactsDir)) {
    const rel = path.relative(artifactsDir, filePath)
    const firstSegment = rel.split(path.sep)[0]
    if (!seenRel.has(rel)) add(testNameByArtifactDir.get(firstSegment) ?? firstSegment, filePath)
  }

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
  return {
    runId,
    manifest: m,
    ...(summary ? { summary } : {}),
    ...(playbackEvents?.length ? { playbackEvents } : {}),
    ...(playwrightArtifacts?.length ? { playwrightArtifacts } : {}),
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
   *   - `index-changed` — list-level (e.g. reaper) */
  kind: 'bootstrap' | 'changed' | 'finalized' | 'removed' | 'index-changed'
  runId?: string
}

export type RunStoreEventListener = (e: RunStoreEvent) => void

export interface DeleteResult {
  ok: boolean
  reason?: 'active' | 'not-found' | 'stale'
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
      const result = await this.abort(orch.runId)
      if (result.ok) aborted.add(orch.runId)
    }
    for (const entry of this.list()) {
      if (entry.status !== 'running' && entry.status !== 'healing') continue
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
    if (!detail) return { ok: false, reason: 'not-found' }
    const status = detail.manifest.status
    if (status === 'running' || status === 'healing') {
      return { ok: false, reason: 'stale' }
    }
    const removed = removeRunFromHistory(this.logsDir, runId)
    if (removed) this.emitEvent({ kind: 'removed', runId })
    return { ok: true }
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
    if (!detail) return false
    const status = detail.manifest.status
    if (status !== 'running' && status !== 'healing') return false
    this.finalize(
      runId,
      'aborted',
      new Date().toISOString(),
      detail.manifest.healCycles,
    )
    return true
  }
}

// Re-export the manifest types most callers will want alongside RunStore so
// they don't need a second import.
export type { RunIndexEntry, RunManifest, ServiceManifestEntry } from './runtime/manifest'
