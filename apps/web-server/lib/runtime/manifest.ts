import fs from 'fs'
import path from 'path'
import { runDirFor, runsIndexPath, runsRoot } from './run-paths'
import type {
  RunLifecycleSnapshot,
  RunStatus,
  ServiceStatus,
} from '../../../../shared/run-state'
import type {
  ExecutionType,
  VerificationRunMetadata,
} from '../../../../shared/verification'
export type {
  RunLifecycleAbortReason,
  RunLifecycleEvent,
  RunLifecyclePhase,
  RunLifecycleRestartPlan,
  RunLifecycleSeverity,
  RunLifecycleSignal,
  RunLifecycleSignalStatus,
  RunLifecycleSnapshot,
  RunLifecycleTargetedRerun,
  RunStatus,
  ServiceStatus,
} from '../../../../shared/run-state'

// Per-run manifest written at start and updated at finish. Kept narrow and
// JSON-shaped so the future server can read it without parsing logs.

export interface ServiceManifestEntry {
  /** Repo identity from feature.config repos[].name. Older manifests omit it. */
  repoName?: string
  name: string
  safeName: string
  command: string
  cwd: string
  logPath: string
  healthUrl?: string
  status?: ServiceStatus
}

export interface RepoBranchSnapshot {
  name: string
  path: string
  branch: string | null
  expectedBranch?: string
  detached: boolean
  dirty: boolean
}

export type PlaywrightScreenshotMode = 'off' | 'on' | 'only-on-failure'
export type PlaywrightRetainedArtifactMode = 'off' | 'on' | 'on-first-retry' | 'retain-on-failure'

export interface PlaywrightArtifactPolicy {
  screenshot: PlaywrightScreenshotMode
  video: PlaywrightRetainedArtifactMode
  trace: PlaywrightRetainedArtifactMode
}

// Mid-Run Heal: populated when Playwright was halted before completing the
// suite — either by `--max-failures=<N>` (auto-fast-fail) or by an explicit
// user-invoked Pause & Heal. Heal-index rendering uses this so the agent
// doesn't assume the suite size from the partial summary.
export type StoppedEarlyReason = 'max-failures' | 'user-pause' | 'user-cancel-heal'

export interface StoppedEarlyInfo {
  reason: StoppedEarlyReason
  failuresAtStop: number
  suiteTotal: number
}

export type ExternalHealClientKind =
  | 'claude-cli'
  | 'claude-desktop'
  | 'codex-cli'
  | 'codex-desktop'
  | 'other'

export type ExternalHealSessionStatus =
  | 'connected'
  | 'waiting'
  | 'healing'
  | 'running-tests'
  | 'paused'
  | 'disconnected'

/**
 * Identity + liveness record for an external AI client (Claude Desktop, Codex
 * CLI, etc.) that has claimed heal duty for this run via MCP. Populated only
 * when `healMode === 'external'`. The orchestrator no longer spawns a heal
 * agent PTY in that mode — it parks at `waiting-for-signal` and lets the
 * external client write signals through `POST /api/runs/:runId/signal`.
 */
export interface ExternalHealSession {
  sessionId: string
  clientKind: ExternalHealClientKind
  clientVersion?: string
  conversationName?: string
  claimedAt: string
  lastHeartbeatAt: string
  status: ExternalHealSessionStatus
  cycleCount: number
}

export interface RunManifest {
  runId: string
  executionType?: ExecutionType
  feature: string
  featureDir?: string
  env?: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  healCycles: number
  services: ServiceManifestEntry[]
  repoPaths?: string[]
  repoBranches?: RepoBranchSnapshot[]
  playwrightArtifacts?: PlaywrightArtifactPolicy
  stoppedEarly?: StoppedEarlyInfo
  /**
   * Per heal-cycle record of which services were restarted vs kept warm.
   * Populated when the orchestrator processes a `.restart` signal whose body
   * carries a non-empty `filesChanged`. The heal-index footer surfaces the
   * most recent entry to the next agent invocation.
   */
  healCycleHistory?: Array<{ cycle: number; restarted: string[]; kept: string[] }>
  /** ISO timestamp updated every few seconds while the orchestrator is alive.
   *  Consumers compare against `Date.now()` to detect stale/orphaned runs. */
  heartbeatAt?: string
  /** Per-run signal file paths surfaced to the UI so the manual heal banner
   *  can show the user exactly where to write `.rerun` / `.restart`. */
  signalPaths?: { rerun: string; restart: string }
  /** When the run is heal-paused under manual mode, the UI renders a banner
   *  pointing the user at the signal paths above. Only set during the heal
   *  phase of a manual run; cleared when the run leaves the heal state.
   *
   *  `'external'` means an external AI client (Claude/Codex CLI or Desktop,
   *  connected via MCP) owns the heal loop for this run. See
   *  `externalHealSession` below for identity + heartbeat state. */
  healMode?: 'auto' | 'manual' | 'external'
  /** Populated when `healMode === 'external'`. Tracks the single external
   *  client that holds the heal claim for this run. */
  externalHealSession?: ExternalHealSession
  /** Latest structured lifecycle state. This is the UI source of truth for
   *  recovery flow narration; runner.log remains the human-readable audit. */
  lifecycle?: RunLifecycleSnapshot
  verification?: VerificationRunMetadata
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

export function updateServiceStatus(
  manifestPath: string,
  safeName: string,
  status: ServiceStatus,
): RunManifest | null {
  const current = readManifest(manifestPath)
  if (!current) return null
  const services = current.services.map((s) =>
    s.safeName === safeName ? { ...s, status } : s,
  )
  const next = { ...current, services }
  writeManifest(manifestPath, next)
  return next
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

export interface RunIndexEntry {
  runId: string
  executionType?: ExecutionType
  feature: string
  startedAt: string
  status: RunStatus
  endedAt?: string
  verificationConfigName?: string
  verificationPlaywrightEnvsetId?: string
  verificationTargetUrls?: Record<string, string>
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
