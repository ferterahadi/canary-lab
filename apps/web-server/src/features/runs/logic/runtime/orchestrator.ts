import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type { FeatureConfig, HealthProbe, HttpProbe, PortSlot, TcpProbe } from '../../../../../../../shared/launcher/types'
import type { ExecutionType, VerificationRunMetadata } from '../../../../../../../shared/verification'
import {
  HealSignalGate,
  createRunLifecycleEvent,
  type HealSignal,
  type HealSignalKind,
} from '../../../../../../../shared/run-state'
import {
  enabledForEnv,
  isHealthy,
  isTcpListening,
  normalizeStartCommand,
  resolveHealthProbe,
  resolvePath,
} from './launcher/startup'
import {
  buildRunPaths,
  type RunPaths,
} from './run-paths'
import {
  type ExternalHealSession,
  type RunBootFailure,
  type RunLifecycleAbortReason,
  type RunLifecycleEvent,
  type RunLifecyclePhase,
  type RunLifecycleRestartPlan,
  type RunLifecycleSeverity,
  type RunLifecycleTargetedRerun,
  type RepoBranchSnapshot,
  type RunManifest,
  type ServiceManifestEntry,
  type StoppedEarlyReason,
} from './manifest'
import { FileRunStateSink, type RunStateSink } from './run-state-sink'
import type { PtyFactory, PtyHandle } from './pty-spawner'
import { HealCycleState, AUTO_HEAL_MAX_CYCLES } from './heal-cycle'
import {
  readPriorSessionId,
  readPriorSessionIdFromValue,
  type BuildHealCyclePrompt,
  type BuildHealCyclePromptArgs,
} from './auto-heal'
import { appendJournalIteration } from './log-enrichment'
import {
  locateClaudeSessionLog,
  locateCodexSessionLog,
  locateLatestSessionLogForAgent,
  parseAgentSessionRefFile,
  renderAgentSessionContext,
  type AgentSessionRef,
  type AgentSessionRefFile,
} from '../../../agent-sessions/logic/agent-session-log'
import type { RunnerLog } from './runner-log'
import {
  resolveMcpOutputDir,
  ensureMcpOutputDir,
  capArtifacts,
} from './playwright-mcp-artifacts'
import { planRestart } from './restart-planner'
import { interpolateConfigTokens, makeTokenCache } from './launcher/interpolate'
import { releasePorts } from './port-allocator'
import { removeWorktree, type WorktreeHandle } from './repo-worktree'
import { overlayExists, readOverlay, checkStaleness, overlayDir } from '../../../portify/logic/runtime/overlay'
import { applyOverlay, reverseOverlay } from '../../../portify/logic/runtime/git-ops'
import { readPlaywrightArtifactPolicy } from './playwright-artifact-policy'
import { slugify } from './summary-reporter'
import { listSpecFiles, loadFeatures } from '../../../config/logic/feature-loader'
import { extractTestsFromSource } from '../../../config/logic/ast-extractor'
import {
  diffContentSinceSnapshot,
  diffNamesSinceSnapshot,
  getGitRoot,
  resolveRepoPath,
  snapshotWorkingTree,
  type DiffPathspec,
} from '../../../../shared/git-repo'

// Headless event-emitting orchestrator for a single feature run. Wraps the
// existing health-check / signal-file semantics behind a clean API the future
// Fastify server can drive without inheriting any readline / iTerm cruft.

export interface ServiceSpec {
  repoName: string
  name: string
  safeName: string
  command: string
  cwd: string
  /** Resolved per-env readiness probe (single transport). */
  healthProbe?: HealthProbe
  /** Extra env injected at spawn — e.g. the allocated `PORT` for each declared
   *  port slot whose `env` is set. */
  env?: Record<string, string>
  /** Per-run allocated ports keyed by declared slot name (for the manifest). */
  allocatedPorts?: Record<string, number>
}

export interface OrchestratorOptions {
  feature: FeatureConfig
  runId: string
  runDir: string
  // Repo root where the diagnosis journal lives (independent of the run dir).
  projectRoot?: string
  // Injected pty factory — production code passes the real one; tests pass a
  // fake. Required so unit tests can run without a TTY or node-pty native.
  ptyFactory: PtyFactory
  // Health-check function — defaulted to the real HTTP poller, but injectable
  // for tests.
  healthCheck?: (url: string, timeoutMs?: number) => Promise<boolean>
  // Default polling cadence; overridable for tests to keep them fast.
  healthPollIntervalMs?: number
  // Default deadline for an entire health-check phase (per service).
  healthDeadlineMs?: number
  // Override for `setTimeout`-based delays in tests.
  delay?: (ms: number) => Promise<void>
  // Builds the Playwright invocation. The orchestrator spawns it via
  // ptyFactory so tests can inject a fake. Defaults to the standard
  // `npx playwright test` command rooted at the feature dir.
  playwrightSpawner?: PlaywrightSpawner
  // Auto-heal configuration. Omit to disable the heal loop.
  autoHeal?: AutoHealConfig
  // Manual heal mode: when true and `autoHeal` is omitted, a failing run
  // transitions to 'healing' and waits for the user to write the signal
  // file by hand (no agent process spawned). When false (default), failing
  // tests with no autoHeal short-circuit to 'failed' immediately.
  manualHeal?: boolean
  // External heal mode: identical operational behavior to `manualHeal` (no
  // agent CLI is spawned, the orchestrator parks at waiting-for-signal until
  // a signal file appears in `<runDir>/signals/`). The only difference is
  // that the manifest's `healMode` is written as `'external'` so the UI can
  // render the dedicated `ExternalHealPanel` instead of the manual-heal
  // banner, and so external clients (Claude/Codex via MCP) can recognise
  // ownership. Mutually exclusive with `autoHeal`; takes precedence over
  // `manualHeal` for the manifest tag when both are true.
  externalHeal?: boolean
  /** When `externalHeal` is true, the route layer auto-claims the broker for
   *  the request's session. Passing the resulting `ExternalHealSession` here
   *  lets the orchestrator include it in the initial manifest write so the UI
   *  sees the "Healing via Claude Desktop" badge from the very first frame
   *  instead of after a follow-up patch round-trip. */
  externalHealSession?: ExternalHealSession
  // Polling interval for the heal-cycle signal-wait loop. Defaults to
  // healthPollIntervalMs.
  healSignalPollMs?: number
  // Hard ceiling on a single heal cycle (signal-wait). Defaults to 60 min.
  // When the agent is actively producing output, this is the absolute upper
  // bound on how long one cycle can run; quieter checks live in
  // `healAgentIdleTimeoutMs` below.
  healAgentTimeoutMs?: number
  // Idle window — max time the agent can go without emitting any output
  // before the cycle is given up on. Resets every time a chunk arrives on
  // the agent pty. Defaults to 3 min, which is generous for normal claude
  // pacing but catches a wedged REPL.
  healAgentIdleTimeoutMs?: number
  // Optional runner-log sink. When present, the orchestrator subscribes to its
  // own lifecycle events on construction and tees a human-readable line for
  // each into `runner.log`. Both CLI and web entrypoints provide one.
  runnerLog?: RunnerLog
  // Selected env (e.g. 'local', 'production'). Used to filter
  // repos/startCommands whose `envs` whitelist excludes it — letting a feature
  // skip booting local services when running tests against a remote URL.
  env?: string
  // Single mutator for manifest.json + runs-index.json. Defaults to a
  // file-only sink that writes the same files directly; production wires
  // the web-server's `RunStore` here so mutations also emit events that
  // drive the WS push channel.
  runStateSink?: RunStateSink
  repoBranchSnapshots?: RepoBranchSnapshot[]
  initialHealCycles?: number
  executionType?: ExecutionType
  verification?: VerificationRunMetadata
  playwrightEnv?: Record<string, string>
  /** Per-run allocated ports keyed by slot name (allocated by the start flow
   *  before construction). Resolves `${port.<slot>}` tokens and is injected as
   *  each service's declared `env`. Released on stop. */
  portMap?: Map<string, number>
  /** Per-run git worktrees created (opt-in) after a same-repo collision. The
   *  orchestrator redirects affected services' cwd into the worktree, records
   *  them in the manifest, and removes them on stop. */
  worktrees?: WorktreeHandle[]
  /** Relocate the heal-signal directory away from `<runDir>/signals`. The
   *  benchmark baseline arm points this at the agent's own worktree so the
   *  agent can signal completion without being handed a path into the run dir
   *  (where harness-only artifacts live). Omit for the default location. */
  signalsDir?: string
}

export type PauseResult =
  | { ok: true; failureCount: number }
  | { ok: false; reason: 'already-healing' | 'no-playwright-running' | 'no-failures-yet' }

export type CancelHealResult =
  | { ok: true }
  | { ok: false; reason: 'not-healing' | 'no-agent-running' }

export type InterjectResult =
  | { ok: true }
  | { ok: false; reason: 'no-agent-running' }

export type OrchestratorEventMap = {
  'service-started': { service: ServiceSpec; pid: number }
  'service-output': { service: ServiceSpec; chunk: string }
  'service-exit': { service: ServiceSpec; exitCode: number; signal?: number }
  'service-restart-skipped': { service: ServiceSpec; reason: 'no-files-changed-here' }
  'restart-planned': { toRestart: string[]; toKeep: string[]; noMatch: boolean }
  'health-check': { service: ServiceSpec; healthy: boolean; transport?: 'http' | 'tcp' }
  'playwright-output': { chunk: string }
  'playwright-started': { command: string }
  'playwright-exit': { exitCode: number }
  'agent-started': { cycle: number; command: string; redirect?: boolean }
  'agent-output': { chunk: string }
  'agent-exit': { exitCode: number }
  'heal-cycle-started': { cycle: number; failureSignature: string }
  'signal-detected': {
    kind: 'restart' | 'rerun' | 'heal'
    body: Record<string, unknown>
  }
  'signal-accepted': {
    kind: 'restart' | 'rerun' | 'heal'
    body: Record<string, unknown>
  }
  'signal-ignored': {
    kind: 'restart' | 'rerun' | 'heal'
    reason: string
  }
  'run-status': { status: RunManifest['status'] }
  'run-complete': { status: RunManifest['status'] }
  'paused-by-user': { failureCount: number }
}

interface LifecycleRecordOptions {
  detail?: string
  severity?: RunLifecycleSeverity
  activeCycle?: number
  lastSignal?: RunLifecycleEvent['lastSignal']
  restartPlan?: RunLifecycleRestartPlan
  targetedRerun?: RunLifecycleTargetedRerun
  abortReason?: RunLifecycleAbortReason
}

// One snapshot entry per edit surface tracked across a heal cycle. Service
// repos populate this with `gitRoot === resolveRepoPath(localPath)` and no
// pathspecs. The feature dir populates it with `gitRoot` = the workspace
// repo root (resolved via `git rev-parse --show-toplevel`) and pathspecs
// that scope the diff to the feature subtree while excluding any service
// repo nested inside.
interface FeatureRepoSnapshot {
  ref: string
  gitRoot: string
  pathspecs?: readonly DiffPathspec[]
}

// True when `child` is a descendant of `parent` (or identical). Used by the
// snapshot helper to decide whether a service repo lives inside the feature
// dir and therefore needs to be excluded from the feature-dir diff scope.
function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export type AutoHealAgent = 'claude' | 'codex'

export interface AutoHealConfig {
  agent: AutoHealAgent
  // Optional 1-based cap on heal cycles. Omit for the production default:
  // keep healing until all tests pass, the human stops it, or a cycle cannot
  // produce a signal/change to apply.
  maxCycles?: number
  // Returns the spawn command for the long-lived REPL — just the binary +
  // flags. Production wires `buildAgentSpawnCommand` from auto-heal.ts; tests
  // pass a no-op script that stays alive (e.g. `cat`). The orchestrator
  // either reuses the prior session id from `<runDir>/agent-session-id.txt`
  // (setting `resume: true`) or, for claude, generates a fresh UUID, computes
  // `mcpOutputDir`, and passes the path to the cycle-1 prompt file
  // (`<runDir>/heal-prompt.md`); the production builder appends
  // `"@<promptFile>"` as a positional arg so claude reads the file at
  // startup and processes its content as the first user message —
  // bypassing the REPL's input editor.
  buildSpawnCommand?: (args: {
    sessionId?: string
    resume?: boolean
    mcpOutputDir?: string
    promptFile?: string
  }) => string
  // Returns the prompt text to write to the REPL's stdin for cycle N.
  // Production wires `buildOrchestratorHealPrompt`; tests pass a stub that
  // returns a deterministic string. The orchestrator pty.write()s the result
  // followed by a newline.
  buildCyclePrompt?: BuildHealCyclePrompt
}

export interface PlaywrightInvocation {
  command: string
  cwd: string
}

export type PlaywrightRerunSelection =
  | {
      kind: 'targets'
      targets: readonly string[]
      selected: number
      total: number
      mode: RunLifecycleTargetedRerun['mode']
      reason: string
    }
  | {
      kind: 'grep'
      grep: string
      selected: number
      total: number
      mode: RunLifecycleTargetedRerun['mode']
      reason: string
    }

export type PlaywrightSpawner = (args: {
  feature: FeatureConfig
  paths: RunPaths
  rerunTargets?: readonly string[]
  rerunGrep?: string
  rerunSelection?: PlaywrightRerunSelection
}) => PlaywrightInvocation

export interface BuildServiceSpecsOptions {
  /** Per-run allocated ports keyed by slot name. Resolves `${port.<slot>}`
   *  tokens and is injected as each declared slot's `env` var. */
  portMap?: Map<string, number>
  /** Per-run repo localPath overrides keyed by repo name. Set when a repo is
   *  isolated in a worktree so the service `cwd` points at the worktree. */
  repoPathOverrides?: Record<string, string>
}

function resolvePortEnv(
  ports: PortSlot[] | undefined,
  portMap: Map<string, number> | undefined,
): { env: Record<string, string>; allocatedPorts: Record<string, number> } {
  const env: Record<string, string> = {}
  const allocatedPorts: Record<string, number> = {}
  for (const slot of ports ?? []) {
    const port = portMap?.get(slot.name)
    if (port == null) continue
    allocatedPorts[slot.name] = port
    if (slot.env) env[slot.env] = String(port)
  }
  return { env, allocatedPorts }
}

/** Gather the unique port slots a feature declares for the given env. The
 *  start flow allocates one free port per slot before constructing the
 *  orchestrator (buildServiceSpecs runs synchronously in the constructor). */
export function collectPortSlots(feature: FeatureConfig, env?: string): PortSlot[] {
  const slots = new Map<string, PortSlot>()
  for (const repo of feature.repos ?? []) {
    if (!enabledForEnv(repo.envs, env)) continue
    const commands = repo.startCommands ?? []
    for (let i = 0; i < commands.length; i++) {
      const normalized = normalizeStartCommand(commands[i], `${repo.name}-cmd-${i + 1}`)
      if (!enabledForEnv(normalized.envs, env)) continue
      for (const slot of normalized.ports ?? []) {
        if (!slots.has(slot.name)) slots.set(slot.name, slot)
      }
    }
  }
  return [...slots.values()]
}

export function buildServiceSpecs(
  feature: FeatureConfig,
  runDir: string,
  env?: string,
  opts: BuildServiceSpecsOptions = {},
): ServiceSpec[] {
  const out: ServiceSpec[] = []
  // ${slot.key} tokens in feature.config values resolve from the chosen env's
  // envset slot files at boot time, and the reserved ${port.<slot>} namespace
  // from the per-run port map. The cache shares parsed slot files across every
  // value in this build pass.
  const tokenCtx = {
    envName: env,
    envsetsDir: path.join(feature.featureDir, 'envsets'),
    ports: opts.portMap,
  }
  const tokenCache = makeTokenCache()
  const interp = <T,>(node: T): T => interpolateConfigTokens(node, tokenCtx, tokenCache)
  for (const repo of feature.repos ?? []) {
    if (!enabledForEnv(repo.envs, env)) continue
    const dir = opts.repoPathOverrides?.[repo.name] ?? resolvePath(repo.localPath)
    const commands = repo.startCommands ?? []
    for (let i = 0; i < commands.length; i++) {
      const normalized = normalizeStartCommand(commands[i], `${repo.name}-cmd-${i + 1}`)
      if (!enabledForEnv(normalized.envs, env)) continue
      const safeName = normalized.name!.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      const probe = resolveHealthProbe(normalized.healthCheck, env)
      const { env: portEnv, allocatedPorts } = resolvePortEnv(normalized.ports, opts.portMap)
      out.push({
        repoName: repo.name,
        name: normalized.name!,
        safeName,
        command: interp(normalized.command),
        cwd: dir,
        healthProbe: probe ? interp(probe) : undefined,
        ...(Object.keys(portEnv).length > 0 ? { env: portEnv } : {}),
        ...(Object.keys(allocatedPorts).length > 0 ? { allocatedPorts } : {}),
        // Service log path is implied by runDir; consumers can derive via buildRunPaths.
      })
    }
  }
  return out
}

/**
 * Manifest service entries for a *queued* run — built from the feature config
 * before any process spawns, so the queued run's Overview lists the services
 * that will boot once it leaves the queue (instead of "No services configured").
 * Ports aren't allocated until promotion, so `allocatedPorts` and the
 * port-templated `healthUrl` are intentionally omitted; status is 'queued'.
 * Promotion later overwrites this with the real running manifest.
 */
export function buildQueuedServiceEntries(
  feature: FeatureConfig,
  runDir: string,
  env?: string,
): ServiceManifestEntry[] {
  const paths = buildRunPaths(runDir)
  return buildServiceSpecs(feature, runDir, env).map((s) => ({
    repoName: s.repoName,
    name: s.name,
    safeName: s.safeName,
    command: s.command,
    cwd: s.cwd,
    logPath: paths.serviceLog(s.safeName),
    status: 'queued',
  }))
}

export class RunOrchestrator extends EventEmitter {
  readonly runId: string
  readonly runDir: string
  readonly feature: FeatureConfig
  readonly env?: string
  readonly paths: RunPaths
  readonly services: ServiceSpec[]

  private readonly ptyFactory: PtyFactory
  private readonly healthCheck: (url: string, timeoutMs?: number) => Promise<boolean>
  private readonly healthPollIntervalMs: number
  private readonly healthDeadlineMs: number
  private readonly delay: (ms: number) => Promise<void>
  private readonly logsRoot: string
  private readonly playwrightSpawner: PlaywrightSpawner
  private readonly autoHeal?: AutoHealConfig
  private readonly manualHeal: boolean
  private readonly externalHeal: boolean
  private readonly externalHealSession: ExternalHealSession | undefined
  private readonly healSignalPollMs: number
  private readonly healAgentTimeoutMs: number
  private readonly healAgentIdleTimeoutMs: number
  // Wall-clock of the most recent chunk emitted by the live heal-agent pty.
  // Reset at the start of each `waitForHealSignal` call. Used to detect a
  // wedged REPL (no output for `healAgentIdleTimeoutMs`) while still
  // allowing legitimate long-running cycles to keep going as long as the
  // agent is producing text.
  private lastAgentDataAt = 0
  private readonly runnerLog?: RunnerLog
  private readonly stateSink: RunStateSink
  private readonly repoBranchSnapshots?: RepoBranchSnapshot[]
  private readonly executionType: ExecutionType
  private readonly verification?: VerificationRunMetadata
  private readonly playwrightEnv: Record<string, string>
  private readonly portMap?: Map<string, number>
  private readonly worktreeHandles: WorktreeHandle[]
  private readonly repoPathOverrides: Record<string, string>
  // Ephemeral port overlay: when the feature has a saved overlay, its captured
  // patch is `git apply`-ed into each per-run worktree before boot and
  // reverse-applied at teardown — the target repo is never permanently changed.
  private readonly portified: boolean
  // Overlays applied this run, recorded so stop() can reverse exactly what it
  // applied (and so a failed partial apply reverses only what landed).
  private appliedOverlays: { repoName: string; worktreeRoot: string; patchPath: string }[] = []
  private readonly signalGate = new HealSignalGate()
  private healCycleHistory: Array<{ cycle: number; restarted: string[]; kept: string[] }> = []

  private status: RunManifest['status'] = 'running'
  private healCycles = 0
  private startedAt = ''
  private servicePtys = new Map<string, PtyHandle>()
  private logFiles = new Set<string>()
  private signalWatcher: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private stopped = false
  // Mid-Run Heal: tracked while a Playwright pty is in flight so
  // pauseAndHeal() can SIGTERM it. Cleared on exit.
  private playwrightPty: PtyHandle | null = null
  private playwrightExitWaiter: ((value: { exitCode: number; signal?: number }) => void) | null = null
  // Tracked while a heal-agent pty is in flight so cancelHeal() can SIGTERM it.
  // The REPL is spawned ONCE per heal session and persists across cycles —
  // the orchestrator drives cycle handoffs by writing to its stdin instead
  // of respawning. Cleared on cleanup.
  private healAgentPty: PtyHandle | null = null
  // MCP artifact dir for the live REPL. Pinned at spawn time from cycle-1's
  // failed slugs and held until the heal loop exits, since claude's
  // `--mcp-config` is set once at process boot. Read by the bidirectional
  // pane handler when it needs to associate input with a heal session.
  private healAgentMcpOutputDir: string | undefined
  // Pinned at spawn time via `--session-id <uuid>` for claude (codex has no
  // equivalent flag and leaves this null). Persisted to
  // `paths.agentSessionIdPath` so external tools can correlate the run with
  // the conversation log under `~/.claude/projects/`.
  private healAgentSessionId: string | null = null
  // ISO timestamp captured at heal-agent spawn so the codex session-log
  // locator can find this run's `~/.codex/sessions/.../<rollout>.jsonl`
  // (codex has no `--session-id` flag, so we discover the session by
  // matching `cwd === runDir` and `session_meta.timestamp >= here`).
  private healAgentStartedAt: string | null = null
  // Last dimensions reported by the browser's agent pane. The pane can mount
  // before auto-heal spawns the REPL, so keep the size and apply it at spawn.
  private healAgentTerminalSize: { cols: number; rows: number } | null = null
  // In-memory mirror of `paths.agentSessionRefPath`. `undefined` means we
  // haven't read disk yet; `null` means we read and the file is missing or
  // invalid. The orchestrator is the only writer, so once seeded we trust the
  // cache and update it in lockstep with writeAgentSessionRef.
  private cachedRefFile: AgentSessionRefFile | null | undefined = undefined
  // Set by cancelHeal() so the heal loop in runFullCycle bails out instead of
  // racing toward another Playwright rerun.
  private healCancelled = false
  private stoppedEarlyReason: StoppedEarlyReason | undefined
  private pendingAbortReason: RunLifecycleAbortReason | undefined
  // Set by waitForHealth (via pollUntilReady) when a service fails to come up on
  // a normal run: the suite can't run, so runFullCycle / the heal loops treat
  // the run as `failed` and route it into heal instead of aborting. Cleared at
  // the top of every ensureServicesRunning so a stale failure from a prior
  // cycle doesn't survive a successful reboot.
  private bootFailure: RunBootFailure | undefined
  private lastLifecycleEvent: { phase: RunLifecyclePhase; headline: string } | null = null

  constructor(opts: OrchestratorOptions) {
    super()
    this.feature = opts.feature
    this.env = opts.env
    this.runId = opts.runId
    this.runDir = opts.runDir
    this.paths = buildRunPaths(opts.runDir, opts.signalsDir ? { signalsDir: opts.signalsDir } : undefined)
    this.portMap = opts.portMap
    this.worktreeHandles = opts.worktrees ?? []
    this.repoPathOverrides = {}
    for (const handle of this.worktreeHandles) {
      this.repoPathOverrides[handle.repoName] = handle.localPath
    }
    this.portified = overlayExists(opts.feature.featureDir)
    this.services = buildServiceSpecs(opts.feature, opts.runDir, opts.env, {
      portMap: this.portMap,
      repoPathOverrides: this.repoPathOverrides,
    })
    this.ptyFactory = opts.ptyFactory
    this.healthCheck = opts.healthCheck ?? isHealthy
    this.healthPollIntervalMs = opts.healthPollIntervalMs ?? 1000
    this.healthDeadlineMs = opts.healthDeadlineMs ?? 60_000
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.logsRoot = path.dirname(path.dirname(opts.runDir))
    this.playwrightSpawner = opts.playwrightSpawner ?? defaultPlaywrightSpawner
    this.autoHeal = opts.autoHeal
    this.manualHeal = opts.manualHeal ?? false
    this.externalHeal = opts.externalHeal ?? false
    this.externalHealSession = opts.externalHealSession
    this.healSignalPollMs = opts.healSignalPollMs ?? this.healthPollIntervalMs
    // Hard ceiling per cycle. Generous (2h) so a single heal cycle isn't cut
    // off mid-work for a hard, agent-blind reason — the idle timeout below
    // is the primary safety net.
    this.healAgentTimeoutMs = opts.healAgentTimeoutMs ?? 120 * 60 * 1000
    this.healAgentIdleTimeoutMs = opts.healAgentIdleTimeoutMs ?? 5 * 60 * 1000
    this.runnerLog = opts.runnerLog
    // Default to a file-only sink so unit tests + the CLI shim don't have
    // to know about `RunStore`. Production wires RunStore in via opts.
    this.stateSink = opts.runStateSink ?? new FileRunStateSink(this.logsRoot)
    this.repoBranchSnapshots = opts.repoBranchSnapshots
    this.healCycles = opts.initialHealCycles ?? 0
    this.executionType = opts.executionType ?? 'run'
    this.verification = opts.verification
    this.playwrightEnv = opts.playwrightEnv ?? {}
    if (this.runnerLog) this.attachRunnerLog(this.runnerLog)
  }

  // Subscribe the runner-log to every lifecycle event it cares about. Done
  // once at construction so neither caller (CLI shim, web-server) has to wire
  // listeners themselves.
  private attachRunnerLog(log: RunnerLog): void {
    const events: (keyof OrchestratorEventMap)[] = [
      'service-started',
      'service-exit',
      'health-check',
      'playwright-started',
      'playwright-exit',
      'agent-started',
      'agent-exit',
      'heal-cycle-started',
      'signal-detected',
      'signal-accepted',
      'signal-ignored',
      'run-status',
      'run-complete',
    ]
    for (const ev of events) {
      this.on(ev, (payload) => log.recordEvent(ev, payload as never))
    }
  }

  emit<K extends keyof OrchestratorEventMap>(
    event: K,
    payload: OrchestratorEventMap[K],
  ): boolean {
    return super.emit(event, payload)
  }

  on<K extends keyof OrchestratorEventMap>(
    event: K,
    listener: (payload: OrchestratorEventMap[K]) => void,
  ): this {
    return super.on(event, listener)
  }

  // Top-level entry point. Spawns services + waits for health + streams
  // signals to the consumer. Does NOT block on Playwright by itself — the
  // caller drives Playwright via runPlaywright(), which lets the future
  // server show "services up" before tests start.
  async start(): Promise<void> {
    this.prepareRun('starting')
    // Apply the ephemeral port overlay BEFORE any service spawns. A failure
    // here throws out of start() so the caller's `.catch` runs stop('aborted')
    // — we must never boot a portified feature un-portified (the second
    // concurrent boot would EADDRINUSE on the un-injected port).
    await this.applyPortifyOverlay()
    await this.ensureServicesRunning()
  }

  /**
   * Apply the feature's saved port overlay into each per-run worktree. No-op
   * unless the feature is portified. Checks staleness first (the user's repo
   * may have moved since the overlay was captured) and fails loud — with an
   * actionable "re-run Portify" message — on staleness, a missing worktree, or
   * a patch that won't apply. Records what it applied for reverse at teardown.
   */
  private async applyPortifyOverlay(): Promise<void> {
    if (!this.portified) return
    const featureDir = this.feature.featureDir
    const overlay = readOverlay(featureDir)
    if (!overlay) {
      // overlayExists was true at construction but the overlay is now
      // unreadable (e.g. a patch file vanished) — refuse rather than boot bare.
      throw new Error(
        `saved port overlay for "${this.feature.name}" is missing or corrupt — re-run Portify to refresh it`,
      )
    }
    // Worktree must cover every overlay repo; otherwise a service would boot
    // from un-patched source. Map repo name → its per-run worktree root.
    const worktreeByRepo: Record<string, string> = {}
    for (const handle of this.worktreeHandles) worktreeByRepo[handle.repoName] = handle.worktreeRoot
    const sourceByRepo: Record<string, string> = {}
    for (const repo of overlay.meta.repos) {
      const handle = this.worktreeHandles.find((h) => h.repoName === repo.name)
      if (!handle) {
        throw new Error(
          `portified run requires a per-run worktree for repo "${repo.name}" but none was created — this run cannot apply its port overlay safely`,
        )
      }
      sourceByRepo[repo.name] = handle.sourceRoot
    }

    // Staleness: did the user's repo move under the captured patch?
    const staleness = await checkStaleness(featureDir, sourceByRepo)
    if (staleness.stale) {
      const files = staleness.changedFiles.map((c) => `${c.repo}:${c.path}`).join(', ')
      throw new Error(
        `saved port overlay no longer applies (${files} changed since capture) — re-run Portify to refresh it`,
      )
    }

    const dir = overlayDir(featureDir)
    for (const repo of overlay.meta.repos) {
      const worktreeRoot = worktreeByRepo[repo.name]
      const patchPath = path.join(dir, repo.patch)
      const outcome = await applyOverlay(worktreeRoot, patchPath)
      if (outcome.kind === 'ok') {
        this.appliedOverlays.push({ repoName: repo.name, worktreeRoot, patchPath })
        this.runnerLog?.info(`Applied port overlay for "${repo.name}".`)
        continue
      }
      // Apply failed — reverse whatever already landed, then abort loud.
      await this.reversePortifyOverlay()
      const detail = outcome.kind === 'conflict' ? `conflicts in ${outcome.files.join(', ')}` : outcome.detail
      throw new Error(
        `failed to apply the saved port overlay for "${repo.name}" (${detail}) — re-run Portify to refresh it`,
      )
    }
  }

  /**
   * Reverse every overlay this run applied (`git apply -R`), keeping the
   * worktree intact — it holds the heal agent's repair edits. Reverse is atomic
   * per repo: a conflict (a heal edit on the same lines) leaves that file
   * untouched and is surfaced as a warning, not a throw.
   */
  private async reversePortifyOverlay(): Promise<void> {
    for (const applied of this.appliedOverlays.splice(0)) {
      const outcome = await reverseOverlay(applied.worktreeRoot, applied.patchPath)
      if (outcome.kind === 'ok') {
        this.runnerLog?.info(`Reverted port overlay for "${applied.repoName}".`)
      } else {
        const detail = outcome.kind === 'conflict' ? outcome.files.join(', ') : outcome.detail
        this.runnerLog?.warn(
          `port overlay for "${applied.repoName}" could not be reverted (${detail}) — heal edits preserved; the worktree keeps the injected ports`,
        )
      }
    }
  }

  private prepareRun(serviceStatus: ServiceManifestEntry['status']): void {
    this.startedAt = new Date().toISOString()
    fs.mkdirSync(this.runDir, { recursive: true })
    fs.mkdirSync(this.paths.signalsDir, { recursive: true })

    this.writeInitialManifest(serviceStatus)
    this.recordLifecycle('starting-services', 'Starting services', {
      detail: startingServicesDetail(this.services.length),
    })
    this.startSignalWatcher()
    this.startHeartbeat()
  }

  private recordLifecycle(
    phase: RunLifecyclePhase,
    headline: string,
    opts: LifecycleRecordOptions = {},
  ): void {
    this.stateSink.recordLifecycleEvent(this.runId, createRunLifecycleEvent(phase, headline, {
      id: randomUUID(),
      ...opts,
    }))
    this.lastLifecycleEvent = { phase, headline }
  }

  private async ensureServicesRunning(): Promise<string[]> {
    // Fresh boot attempt — drop any health failure recorded by a prior cycle so
    // a service that comes up cleanly this time clears the failed state.
    this.bootFailure = undefined
    const toStart = this.services.filter((svc) => !this.servicePtys.has(svc.name))
    for (const svc of toStart) {
      this.stateSink.setServiceStatus(this.runId, svc.safeName, 'starting')
      this.spawnService(svc)
    }
    if (this.services.length > 0) await this.waitForHealth()
    return toStart.map((svc) => svc.safeName)
  }

  private writeInitialManifest(serviceStatus: ServiceManifestEntry['status'] = 'starting'): void {
    const services: ServiceManifestEntry[] = this.services.map((s) => ({
      repoName: s.repoName,
      name: s.name,
      safeName: s.safeName,
      command: s.command,
      cwd: s.cwd,
      logPath: this.paths.serviceLog(s.safeName),
      // Manifest carries the http URL only when the probe is http. tcp
      // probes don't have a URL; left undefined so older manifest readers
      // still work for the http case.
      healthUrl: s.healthProbe && 'http' in s.healthProbe ? s.healthProbe.http.url : undefined,
      status: serviceStatus,
      ...(s.allocatedPorts && Object.keys(s.allocatedPorts).length > 0 ? { allocatedPorts: s.allocatedPorts } : {}),
    }))
    const worktreeMap: Record<string, string> = {}
    for (const handle of this.worktreeHandles) worktreeMap[handle.repoName] = handle.worktreeRoot
    const manifest: RunManifest = {
      runId: this.runId,
      executionType: this.executionType,
      feature: this.feature.name,
      featureDir: this.feature.featureDir,
      env: this.env,
      startedAt: this.startedAt,
      status: this.status,
      healCycles: this.healCycles,
      services,
      // Reflect the actual paths this run occupies: worktree-isolated repos
      // point at their worktree so a later run can take the freed source in
      // place without a false collision.
      repoPaths: (this.feature.repos ?? [])
        .map((r) => this.repoPathOverrides[r.name] ?? resolvePath(r.localPath))
        .filter((p) => {
          try { return fs.existsSync(p) } catch { return false }
        }),
      ...(Object.keys(worktreeMap).length > 0 ? { worktrees: worktreeMap } : {}),
      repoBranches: this.repoBranchSnapshots,
      playwrightArtifacts: readPlaywrightArtifactPolicy(this.feature.featureDir),
      signalPaths: {
        rerun: this.paths.rerunSignal,
        restart: this.paths.restartSignal,
      },
      healMode: this.externalHeal
        ? 'external'
        : this.autoHeal
          ? 'auto'
          : this.manualHeal
            ? 'manual'
            : undefined,
      ...(this.autoHeal ? { healAgent: this.autoHeal.agent } : {}),
      ...(this.externalHealSession ? { externalHealSession: this.externalHealSession } : {}),
      lifecycle: {
        phase: 'starting-services',
        headline: 'Starting services',
        detail: startingServicesDetail(services.length),
        updatedAt: new Date().toISOString(),
      },
      heartbeatAt: new Date().toISOString(),
      ...(this.verification ? { verification: this.verification } : {}),
    }
    this.stateSink.bootstrap(manifest)
  }

  // Per-run allocated ports exposed to the Playwright process as
  // CANARY_PORT_<slot> so tests can resolve the dynamic target. Empty when the
  // feature declares no port slots (remote runs keep their static envset URL).
  private testPortEnv(): Record<string, string> {
    const out: Record<string, string> = {}
    if (this.portMap) {
      for (const [slot, port] of this.portMap) out[`CANARY_PORT_${slot}`] = String(port)
    }
    return out
  }

  private ensureLogFile(target: string): void {
    if (this.logFiles.has(target)) return
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (!fs.existsSync(target)) fs.writeFileSync(target, '')
    this.logFiles.add(target)
  }

  private spawnService(svc: ServiceSpec): void {
    const logPath = this.paths.serviceLog(svc.safeName)
    this.ensureLogFile(logPath)
    const pty = this.ptyFactory({
      command: `LOG_MODE=plain ${svc.command}`,
      cwd: svc.cwd,
      env: { LOG_MODE: 'plain', ...(svc.env ?? {}) },
    })
    this.servicePtys.set(svc.name, pty)
    this.emit('service-started', { service: svc, pid: pty.pid })

    pty.onData((chunk) => {
      try { fs.appendFileSync(logPath, chunk) } catch { /* ignore */ }
      this.emit('service-output', { service: svc, chunk })
    })
    pty.onExit(({ exitCode, signal }) => {
      if (this.servicePtys.get(svc.name) !== pty) return
      this.servicePtys.delete(svc.name)
      this.emit('service-exit', { service: svc, exitCode, signal })
    })
  }

  // Readiness probe — block until every spawned service is ready. Each
  // service has *one* probe with one transport (`http` or `tcp`); we
  // dispatch by transport. Services with no probe emit a loud warning and
  // are skipped (Playwright still races the boot, but the user knows why).
  private async waitForHealth(): Promise<void> {
    if (this.services.length === 0) return
    await Promise.all(this.services.map((svc) => this.waitForServiceReady(svc)))
  }

  private async waitForServiceReady(svc: ServiceSpec): Promise<void> {
    const probe = svc.healthProbe
    if (!probe) {
      const envHint = this.env ? ` for env "${this.env}"` : ''
      const msg = `Service "${svc.name}" has no readiness probe${envHint}; Playwright may race the boot. Add healthCheck.http or healthCheck.tcp.`
      this.runnerLog?.warn(msg)
      this.emit('agent-output', { chunk: `\n[warning] ${msg}\n` })
      this.stateSink.setServiceStatus(this.runId, svc.safeName, 'ready')
      this.emit('health-check', { service: svc, healthy: true })
      return
    }

    if ('http' in probe) {
      await this.pollUntilReady(svc, 'http', () => this.attemptHttp(probe.http))
      return
    }
    if ('tcp' in probe) {
      await this.pollUntilReady(svc, 'tcp', () => isTcpListening(
        probe.tcp.port,
        probe.tcp.host ?? '127.0.0.1',
        probe.tcp.timeoutMs,
      ))
      return
    }
    // Exhaustiveness: TS proves this is unreachable; the validator already
    // rejects malformed shapes at config-load time.
    throw new Error(`Unknown probe shape for ${svc.name}: ${JSON.stringify(probe)}`)
  }

  /** One HTTP attempt — wraps the existing `isHealthy` so tests can stub it. */
  private async attemptHttp(p: HttpProbe): Promise<boolean> {
    return this.healthCheck(p.url, p.timeoutMs)
  }

  /**
   * Poll a single async attempter until it returns true, or until the
   * probe-specific deadline elapses. The transport label is folded into
   * every emitted event and the timeout error so logs stay specific.
   */
  private async pollUntilReady(
    svc: ServiceSpec,
    transport: 'http' | 'tcp',
    attempt: () => Promise<boolean>,
  ): Promise<void> {
    const probe = svc.healthProbe!
    const deadlineMs = (transport === 'http'
      ? (probe as { http: HttpProbe }).http.deadlineMs
      : (probe as { tcp: TcpProbe }).tcp.deadlineMs) ?? this.healthDeadlineMs
    const deadline = Date.now() + deadlineMs

    // `health-timeout` unless we observe the process die first (below), in
    // which case there's no point polling a dead port until the deadline.
    let failureReason: RunBootFailure['reason'] = 'health-timeout'
    while (Date.now() < deadline) {
      if (this.stopped) return
      const ready = await attempt()
      if (this.stopped) return
      if (ready) {
        this.stateSink.setServiceStatus(this.runId, svc.safeName, 'ready')
        this.emit('health-check', { service: svc, healthy: true, transport })
        this.recordLifecycle(this.status === 'healing' ? 'agent-healing' : 'starting-services', `Health passed: ${svc.name}`, {
          detail: `${transport.toUpperCase()} readiness probe passed.`,
          severity: 'success',
        })
        return
      }
      // Fast-fail: the service process exited before it became healthy (e.g. a
      // crash or compile error). spawnService's onExit removed it from the pty
      // map, so a missing entry means the process is gone — fail now instead of
      // polling a dead port for the rest of the deadline.
      if (!this.servicePtys.has(svc.name)) {
        failureReason = 'process-exited'
        break
      }
      await this.delay(this.healthPollIntervalMs)
    }
    this.stateSink.setServiceStatus(this.runId, svc.safeName, 'timeout')
    this.emit('health-check', { service: svc, healthy: false, transport })
    const probeTarget = transport === 'http'
      ? `url=${(probe as { http: HttpProbe }).http.url}`
      : `port=${(probe as { tcp: TcpProbe }).tcp.port}`
    const detail = failureReason === 'process-exited'
      ? `Service process exited before ${transport.toUpperCase()} readiness (${probeTarget}).`
      : `Timed out waiting for ${transport.toUpperCase()} readiness (${probeTarget}).`
    // Boot-only sessions hold whatever came up. A service that fails its
    // readiness probe is marked `timeout` (red) and surfaced as a non-fatal
    // warning, but the session is NOT aborted — the user keeps the healthy
    // services up to exercise while they debug the failed one, and only
    // abort_run / Stop tears the session down.
    if (this.executionType === 'boot') {
      this.recordLifecycle('starting-services', `Health failed: ${svc.name} — kept up`, {
        detail: `${detail} Marked failed; boot session held — other services stay up. Stop with abort_run to tear down.`,
        severity: 'warning',
      })
      return
    }
    // Normal run: a missing service makes the Playwright suite meaningless, but
    // a broken service IS app code the heal agent can fix. Record the failure
    // (first one wins) and return — runFullCycle / the heal loops declare the
    // run `failed` and route it into heal with this service's log as context,
    // instead of throwing and aborting with no chance to repair.
    this.bootFailure ??= {
      service: svc.name,
      safeName: svc.safeName,
      reason: failureReason,
      detail,
      logPath: this.paths.serviceLog(svc.safeName),
    }
    this.stateSink.patchManifest(this.runId, { bootFailure: this.bootFailure })
    this.recordLifecycle('starting-services', `Service failed to start: ${svc.name}`, {
      detail: `${detail} The run will be marked failed; the heal agent should read the service log to fix why it won't serve.`,
      severity: 'error',
    })
  }

  // Polls the per-run signals dir. The future server (and externally-spawned
  // heal agents) write here; the orchestrator translates them into events the
  // consumer can react to (re-run Playwright, restart services, etc.).
  private startSignalWatcher(): void {
    if (this.signalWatcher) return
    this.signalWatcher = setInterval(() => {
      const tries: Array<{ kind: HealSignalKind; file: string }> = [
        { kind: 'restart', file: this.paths.restartSignal },
        { kind: 'rerun', file: this.paths.rerunSignal },
        { kind: 'heal', file: this.paths.healSignal },
      ]
      for (const t of tries) {
        if (!fs.existsSync(t.file)) continue
        let body: Record<string, unknown> = {}
        try {
          const raw = fs.readFileSync(t.file, 'utf-8').trim()
          if (raw) body = JSON.parse(raw) as Record<string, unknown>
        } catch { /* tolerate empty/non-JSON */ }
        try { fs.unlinkSync(t.file) } catch { /* race with caller is fine */ }
        const result = this.signalGate.observe(t.kind, body)
        if (!result.accepted) {
          this.recordLifecycle('applying-signal', `${signalLabel(t.kind)} signal ignored`, {
            detail: result.reason === 'signal-already-pending' && result.pendingKind
              ? `A .${result.pendingKind} signal is already pending.`
              : 'The runner was not waiting for a heal signal.',
            severity: 'warning',
            lastSignal: { kind: t.kind, status: 'ignored', reason: result.reason },
          })
          this.emit('signal-ignored', { kind: t.kind, reason: result.reason })
          continue
        }
        this.recordLifecycle('applying-signal', `${signalLabel(t.kind)} signal accepted`, {
          detail: `The runner accepted .${t.kind} and will apply it before verification.`,
          lastSignal: { kind: t.kind, status: 'accepted' },
        })
        this.emit('signal-detected', result.signal)
        this.emit('signal-accepted', result.signal)
      }
    }, this.healthPollIntervalMs)
  }

  // Manually fire a restart. When `filesChanged` is supplied and non-empty,
  // restart only the services whose `cwd` covers at least one changed file.
  // Empty / undefined → legacy "restart all" semantics. If no service matches
  // a non-empty `filesChanged` we emit `restart-planned` with `noMatch: true`
  // and skip the restart entirely (rather than restarting everything) — the
  // heal-agent's claim is wrong but losing warm services to that mistake is
  // costlier than the rerun seeing the same failure.
  async restart(filesChanged?: readonly string[]): Promise<{ restarted: string[]; kept: string[]; startedBecauseMissing: string[] }> {
    const plan = planRestart(filesChanged ?? [], this.services)
    const startedBecauseMissing = plan.toKeep.filter((safeName) => {
      const svc = this.services.find((candidate) => candidate.safeName === safeName)
      return Boolean(svc && !this.servicePtys.has(svc.name))
    })
    this.emit('restart-planned', {
      toRestart: plan.toRestart,
      toKeep: plan.toKeep,
      noMatch: plan.noMatch,
    })
    this.recordLifecycle('restarting-services', 'Restart plan ready', {
      detail: restartPlanDetail(plan.toRestart, plan.toKeep, startedBecauseMissing),
      restartPlan: {
        restarted: plan.toRestart,
        kept: plan.toKeep,
        startedBecauseMissing,
        noMatch: plan.noMatch,
      },
    })

    if (plan.noMatch) {
      // Non-empty filesChanged but nothing matched: keep all services warm.
      for (const svc of this.services) {
        this.emit('service-restart-skipped', { service: svc, reason: 'no-files-changed-here' })
      }
      return { restarted: [], kept: plan.toKeep, startedBecauseMissing }
    }

    const filesProvided = (filesChanged ?? []).length > 0
    const restartSet = new Set(plan.toRestart)
    const targets: ServiceSpec[] = []
    for (const svc of this.services) {
      if (!filesProvided || restartSet.has(svc.safeName)) {
        targets.push(svc)
      } else {
        this.emit('service-restart-skipped', { service: svc, reason: 'no-files-changed-here' })
      }
    }

    for (const svc of targets) {
      const pty = this.servicePtys.get(svc.name)
      if (pty) {
        try { pty.kill('SIGTERM') } catch { /* already dead */ }
        this.servicePtys.delete(svc.name)
      }
      this.logFiles.delete(this.paths.serviceLog(svc.safeName))
      const p = this.paths.serviceLog(svc.safeName)
      try { fs.writeFileSync(p, '') } catch { /* may not exist yet */ }
    }
    for (const svc of targets) {
      this.stateSink.setServiceStatus(this.runId, svc.safeName, 'starting')
      this.spawnService(svc)
    }
    if (targets.length > 0) await this.waitForHealth()
    return { restarted: plan.toRestart, kept: plan.toKeep, startedBecauseMissing }
  }

  // Re-run is a no-op at the orchestrator level beyond truncating logs — the
  // consumer reruns Playwright on top.
  async rerun(): Promise<void> {
    for (const svc of this.services) {
      const p = this.paths.serviceLog(svc.safeName)
      try { fs.writeFileSync(p, '') } catch { /* may not exist yet */ }
    }
  }

  // ─── Playwright + heal loop ────────────────────────────────────────────────
  //
  // Spawns Playwright through the same ptyFactory used for services so tests
  // inject a fake. Returns the exit code after the pty exits.
  async runPlaywright(rerun?: readonly string[] | PlaywrightRerunSelection): Promise<number> {
    const rerunSelection = normalizeRerunSelection(rerun)
    const rerunTargets = rerunSelection?.kind === 'targets' ? rerunSelection.targets : undefined
    const rerunGrep = rerunSelection?.kind === 'grep' ? rerunSelection.grep : undefined
    const feature = this.featureWithLatestHealThreshold()
    const inv = this.playwrightSpawner({
      feature,
      paths: this.paths,
      rerunTargets,
      rerunGrep,
      rerunSelection,
    })
    const targetCount = rerunSelection?.selected ?? 0
    const targetedRerun = rerunSelection
      ? {
          selected: rerunSelection.selected,
          total: rerunSelection.total,
          mode: rerunSelection.mode,
          reason: rerunSelection.reason,
        } satisfies RunLifecycleTargetedRerun
      : undefined
    this.emit('playwright-started', { command: inv.command })
    this.recordLifecycle(targetedRerun ? 'rerunning-tests' : 'running-tests', targetedRerun ? 'Rerunning Playwright tests' : 'Running Playwright tests', {
      detail: targetedRerun
        ? `Running ${targetCount} selected test target${targetCount === 1 ? '' : 's'}.`
        : 'Running the configured Playwright suite.',
      ...(targetedRerun ? { targetedRerun } : {}),
    })
    const pty = this.ptyFactory({
      command: inv.command,
      cwd: inv.cwd,
      env: {
        ...this.playwrightEnv,
        // Per-run allocated ports, so tests can target the same dynamic port
        // the local service bound (CANARY_PORT_<slot>). Empty when no ports
        // were allocated, preserving the static envset target for remote runs.
        ...this.testPortEnv(),
        CANARY_LAB_PROJECT_ROOT: this.feature.featureDir,
        CANARY_LAB_MANIFEST_PATH: this.paths.manifestPath,
        CANARY_LAB_SUMMARY_PATH: this.paths.summaryPath,
        ...(rerunSelection ? { CANARY_LAB_TARGETED_RERUN: '1' } : {}),
      },
    })
    this.playwrightPty = pty
    fs.mkdirSync(path.dirname(this.paths.playwrightStdoutPath), { recursive: true })
    fs.writeFileSync(this.paths.playwrightStdoutPath, '')
    pty.onData((chunk) => {
      try { fs.appendFileSync(this.paths.playwrightStdoutPath, chunk) } catch { /* ignore */ }
      this.emit('playwright-output', { chunk })
    })
    return new Promise<number>((resolve) => {
      pty.onExit(({ exitCode, signal }) => {
        this.playwrightPty = null
        this.persistPlaywrightArtifacts()
        this.emit('playwright-exit', { exitCode })
        this.recordLifecycle(exitCode === 0 ? 'completed' : 'failed', `Playwright exited with code ${exitCode}`, {
          detail: signal ? `Process signal: ${signal}` : undefined,
          severity: exitCode === 0 ? 'success' : 'warning',
        })
        const waiter = this.playwrightExitWaiter
        this.playwrightExitWaiter = null
        if (waiter) waiter({ exitCode, signal })
        resolve(exitCode)
      })
    })
  }

  private featureWithLatestHealThreshold(): FeatureConfig {
    const latestThreshold = readLatestHealOnFailureThreshold(this.feature)
    return latestThreshold === this.feature.healOnFailureThreshold
      ? this.feature
      : { ...this.feature, healOnFailureThreshold: latestThreshold }
  }

  // Copy each per-test subdir from `playwright-artifacts/` into the keep dir
  // so it survives the next Playwright invocation's `--output` wipe. New
  // artifacts for the same pw-slug overwrite the previous copy — heal-cycle
  // reruns of a single test thus replace that test's previous video/trace
  // while leaving the other tests' artifacts intact. Best-effort: failures
  // here are logged but do not fail the run.
  private persistPlaywrightArtifacts(): void {
    const src = this.paths.playwrightArtifactsDir
    const dst = this.paths.playwrightArtifactsKeepDir
    if (!fs.existsSync(src)) return
    try { fs.mkdirSync(dst, { recursive: true }) } catch { return }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(src, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const srcPath = path.join(src, entry.name)
      const dstPath = path.join(dst, entry.name)
      try {
        fs.rmSync(dstPath, { recursive: true, force: true })
        fs.cpSync(srcPath, dstPath, { recursive: true })
      } catch (err) {
        this.runnerLog?.warn(`persist playwright artifact ${entry.name} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private verificationPlanForSummary(summary: SummaryShape): VerificationPlan {
    const plan = computeVerificationPlan(this.feature.featureDir, summary)
    if (plan.kind === 'targeted') {
      this.runnerLog?.info(`Targeted re-run: ${plan.failedFirst.length} failed + ${plan.skipped.length} skipped + ${plan.pending.length} pending of ${plan.total} total tests`)
      this.recordLifecycle('rerunning-tests', 'Targeted rerun selected', {
        detail: plan.selection.reason,
        targetedRerun: {
          selected: plan.selection.selected,
          total: plan.selection.total,
          mode: plan.selection.mode,
          reason: plan.selection.reason,
        },
      })
      return plan
    }
    if (plan.kind === 'full-suite') {
      this.runnerLog?.warn(plan.reason)
      this.recordLifecycle('rerunning-tests', 'Full rerun selected', {
        detail: plan.reason,
        severity: 'warning',
        targetedRerun: {
          selected: plan.total,
          total: plan.total,
          mode: 'full-suite',
          reason: plan.reason,
        },
      })
      this.emit('playwright-output', { chunk: `\n[warning] ${plan.reason}\n` })
      return plan
    }
    return plan
  }

  private recordFullSuiteTerminalRestartFallback(reason: string, total: number): void {
    this.runnerLog?.warn(reason)
    this.recordLifecycle('rerunning-tests', 'Full restart rerun selected', {
      detail: reason,
      severity: 'warning',
      targetedRerun: {
        selected: total,
        total,
        mode: 'full-suite',
        reason,
      },
    })
    this.emit('playwright-output', { chunk: `\n[warning] ${reason}\n` })
  }

  // Wait for the in-flight Playwright pty to exit. Resolves immediately when
  // there is no Playwright running. Used by pauseAndHeal() after issuing
  // SIGTERM so we can fall back to SIGKILL on timeout.
  private waitForPlaywrightExit(timeoutMs: number): Promise<{ exitCode: number; signal?: number } | null> {
    if (!this.playwrightPty) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.playwrightExitWaiter) this.playwrightExitWaiter = null
        resolve(null)
      }, timeoutMs)
      this.playwrightExitWaiter = (info) => {
        clearTimeout(timer)
        resolve(info)
      }
    })
  }

  // Persist a `stoppedEarly` reason on the manifest. Surfaced to the heal-index
  // so the agent knows it's looking at a partial suite.
  markStoppedEarly(reason: StoppedEarlyReason, failuresAtStop: number, suiteTotal: number): void {
    this.stoppedEarlyReason = reason
    this.stateSink.patchManifest(this.runId, {
      stoppedEarly: { reason, failuresAtStop, suiteTotal },
    })
  }

  // Manual interruption: check the failure summary FIRST, and only kill the
  // in-flight Playwright pty when we're actually committing to a heal cycle.
  // This avoids the previous footgun where pressing Pause before any test had
  // failed would still SIGTERM Playwright, let it exit cleanly with code 0,
  // and then `runFullCycle` would mark the whole run "passed".
  //
  // Returns a discriminated result the route handler maps to 202 (committed)
  // or 409 (no-op — try again later). On success, the kill is graceful first
  // (SIGTERM, 5 s wait) then forced (SIGKILL).
  async pauseAndHeal(): Promise<PauseResult> {
    if (this.status === 'healing') {
      return { ok: false, reason: 'already-healing' }
    }
    if (!this.playwrightPty) {
      return { ok: false, reason: 'no-playwright-running' }
    }

    // Check failures BEFORE killing — no failures yet → no-op, Playwright
    // keeps running and the user can retry later when something has failed.
    const { failed, total } = summarizeFailures(this.paths.summaryPath)
    if (failed.length === 0) {
      return { ok: false, reason: 'no-failures-yet' }
    }

    // Commit: stamp the reason BEFORE killing so `runFullCycle` can treat
    // the impending Playwright exit as a heal trigger regardless of whether
    // Playwright exits cleanly (code 0) or via signal.
    this.markStoppedEarly('user-pause', failed.length, total)
    this.recordLifecycle('pausing-for-heal', 'Pause accepted', {
      detail: `Stopping Playwright after ${failed.length} failure${failed.length === 1 ? '' : 's'} so healing can start.`,
      severity: 'warning',
    })
    this.emit('paused-by-user', { failureCount: failed.length })

    const pty = this.playwrightPty
    try { pty.kill('SIGTERM') } catch { /* already dead */ }
    const exited = await this.waitForPlaywrightExit(5000)
    if (!exited && this.playwrightPty) {
      try { this.playwrightPty.kill('SIGKILL') } catch { /* already dead */ }
      await this.waitForPlaywrightExit(1000)
    }

    return { ok: true, failureCount: failed.length }
  }

  /**
   * Manually abort an in-flight heal session. Sets a cancellation flag so
   * `runAutoHealLoop` bails out (instead of spawning another Playwright
   * rerun or feeding another prompt to the REPL), appends a journal entry,
   * and SIGTERMs whichever pty is currently active (heal agent OR the
   * post-heal Playwright rerun).
   *
   * Accepted in two states:
   *   - `status === 'healing'`: the heal agent is processing.
   *   - `status === 'running' && healCycles > 0`: a post-heal Playwright
   *     rerun is in flight between cycles. Without this branch the user's
   *     click is silently 409'd until the cycle wraps back to 'healing'.
   *
   * Cancel succeeds even when no pty is attached — claude's REPL can exit
   * on its own (user typed `/exit`, crash) and leave the orchestrator
   * polling for a signal file that will never come. In that case the
   * cancel flag is what unwedges the loop.
   *
   * Returns `409 not-healing` only when the run isn't inside the heal loop
   * at all (initial Playwright phase, terminal status). Use Abort there.
   */
  async cancelHeal(): Promise<CancelHealResult> {
    const inHealLoop = this.status === 'healing'
      || (this.status === 'running' && this.healCycles > 0)
    if (!inHealLoop) return { ok: false, reason: 'not-healing' }

    this.healCancelled = true
    this.markStoppedEarly('user-cancel-heal', 0, 0)

    // Best-effort journal note BEFORE we tear down the pty so the entry
    // lands even if the user-cancel races a fast agent exit.
    try {
      appendJournalIteration({
        // Logged as a `.rerun`-shaped entry for journal-parser compatibility,
        // even though no rerun actually happens. Hypothesis text makes the
        // intent explicit for downstream readers (heal-index, future agent
        // contexts).
        signal: '.rerun',
        hypothesis: 'User cancelled the heal cycle mid-run. No fix applied.',
        fixDescription: 'Cancelled by user — no changes were made.',
        runId: this.runId,
        manifestPath: this.paths.manifestPath,
        summaryPath: this.paths.summaryPath,
        journalPath: this.paths.diagnosisJournalPath,
      })
    } catch { /* journal append is best-effort */ }

    // Kill whichever pty is currently in flight. The loop is awaiting either
    // `waitForHealSignal` (REPL alive, healCancelled check unwedges) or
    // `runPlaywright` (kills the pw pty so the await resolves, then the
    // post-Playwright healCancelled check breaks the loop).
    if (this.healAgentPty) {
      killTree(this.healAgentPty, 'SIGTERM')
      scheduleSigkillFallback(this.healAgentPty)
    }
    if (this.playwrightPty) {
      killTree(this.playwrightPty, 'SIGTERM')
      scheduleSigkillFallback(this.playwrightPty)
    }
    return { ok: true }
  }

  /**
   * Raw write to the heal-agent pty's stdin. Used by the bidirectional pane
   * (every keystroke from xterm.js becomes a chunk) so users can type
   * directly into the live claude/codex REPL — slash commands, Esc to
   * interrupt, etc. — without going through the higher-level interject path.
   *
   * No-op when no agent pty is in flight (between cycles, manual mode, or
   * after cancel).
   */
  writeToHealAgent(chunk: string): void {
    if (!chunk) return
    const pty = this.healAgentPty
    if (!pty) return
    try { pty.write(chunk) } catch { /* pty closed mid-frame */ }
  }

  /**
   * Push the user's xterm dimensions into the heal-agent pty so the agent TUI
   * redraws at the correct width. Without this, the pty stays at its spawn-time
   * defaults (120×30) and wraps box-drawing / status bars to whatever it thinks
   * the terminal is, not what the pane is.
   *
   * Invalid dimensions are ignored. Valid dimensions are remembered even when
   * no agent pty is in flight, because the pane can report its size before the
   * REPL spawns.
   */
  resizeHealAgent(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    if (cols < 1 || rows < 1) return
    // Cap at sane upper bounds — node-pty accepts huge values but agent
    // renderers can chew CPU on absurd sizes (e.g., 100k cols).
    const c = Math.min(Math.floor(cols), 1000)
    const r = Math.min(Math.floor(rows), 1000)
    this.healAgentTerminalSize = { cols: c, rows: r }
    const pty = this.healAgentPty
    if (!pty) return
    try { pty.resize(c, r) } catch { /* pty closed mid-frame */ }
  }

  /**
   * Interrupt & Redirect — drop the user's correction into the live REPL's
   * stdin. The agent absorbs it like any other typed message: Esc interrupts
   * any in-flight generation, then the text is sent followed by Enter. The
   * run stays in `healing` throughout; verification does not begin until the
   * agent writes a `.rerun` / `.restart` / `.heal` signal.
   *
   * No respawn, no session-id race — the REPL is alive across cycles, and
   * everything we'd previously rebuild from `--resume <sid>` is just the
   * existing conversation.
   *
   *   - `no-agent-running`: REPL hasn't spawned (cycle 0) or has exited
   *     (cancel, crash, manual mode).
   */
  async interjectHealAgent(text: string): Promise<InterjectResult> {
    const pty = this.healAgentPty
    if (!pty) return { ok: false, reason: 'no-agent-running' }

    this.echoUserInterject(text)

    // Best-effort journal note so the interject is part of run history.
    try {
      const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text
      appendJournalIteration({
        signal: '.rerun',
        hypothesis: `User interjected mid-heal: ${truncated}`,
        fixDescription: `Sent text to live REPL stdin.`,
        runId: this.runId,
        manifestPath: this.paths.manifestPath,
        summaryPath: this.paths.summaryPath,
        journalPath: this.paths.diagnosisJournalPath,
      })
    } catch { /* journal append is best-effort */ }

    // Esc first to interrupt any in-flight generation, then the text as a
    // bracketed paste followed by Enter. Bracketed paste keeps the REPL's
    // input editor from re-rendering the text word-by-word — same reason
    // `runHealAgent` uses it for cycle prompts. Esc is harmless when idle;
    // claude/codex treat it as "cancel current generation".
    try {
      pty.write('')
      pty.write(BRACKETED_PASTE_BEGIN + text + BRACKETED_PASTE_END + '\r')
    } catch {
      return { ok: false, reason: 'no-agent-running' }
    }
    this.emit('agent-started', { cycle: this.healCycles, command: '<repl-redirect>', redirect: true })
    return { ok: true }
  }

  // Forward raw REPL output (ANSI from xterm.js's perspective) into the
  // `agent-output` event — the pane broker pushes those chunks to live
  // xterm subscribers. Historical replay no longer reads from a raw
  // transcript file; the structured-view route reads the agent CLI's own
  // JSONL session log instead.
  //
  // Each chunk bumps `lastAgentDataAt` so `waitForHealSignal` can detect
  // an idle REPL (no output for `healAgentIdleTimeoutMs`) while not
  // killing an actively-thinking one.
  private attachAgentDataHandlers(pty: PtyHandle): void {
    pty.onData((chunk) => {
      this.lastAgentDataAt = Date.now()
      this.emit('agent-output', { chunk })
    })
  }

  private echoUserInterject(text: string): void {
    const block = formatUserInterjectBlock(text, this.startedAt)
    this.emit('agent-output', { chunk: block })
  }

  private emitAgentSystemMessage(message: string): void {
    this.emit('agent-output', { chunk: `\n[orchestrator] ${message}\n` })
  }

  private agentPtyEnv(): Record<string, string> {
    return {
      CANARY_LAB_PROJECT_ROOT: this.feature.featureDir,
      // Kept as a hint for tools or shell rc files that want to surface the
      // session id — the orchestrator writes the UUID to this path itself
      // (no formatter sidecar in REPL mode).
      CANARY_LAB_AGENT_SESSION_ID_FILE: this.paths.agentSessionIdPath,
    }
  }

  // Block until a signal lands or we give up. Returns a tagged result so the
  // caller can react to *why* the wait ended:
  //   - signal:       agent wrote `.restart` / `.rerun` / `.heal`
  //   - pty-died:     REPL exited (clean /exit, crash, or external kill),
  //                   plus a short grace window so a write-then-exit signal
  //                   isn't lost to the watcher race
  //   - idle-timeout: REPL is alive but hasn't emitted any output for
  //                   `healAgentIdleTimeoutMs` — usually a wedged REPL
  //   - hard-timeout: REPL is alive and producing output but has been
  //                   running for `healAgentTimeoutMs` (the absolute upper
  //                   bound on a single cycle)
  //   - stopped:      orchestrator aborted (full stop)
  //   - cancelled:    user clicked Stop Heal mid-cycle
  // The signal watcher feeds `signalGate`; this wait consumes one accepted
  // signal and lets the gate audit duplicates or late files.
  async waitForHealSignal(
    hardTimeoutMs: number = this.healAgentTimeoutMs,
    idleTimeoutMs: number = this.healAgentIdleTimeoutMs,
    requiresAgent: boolean = true,
  ): Promise<{
    signal: HealSignal | null
    reason: 'signal' | 'pty-died' | 'idle-timeout' | 'hard-timeout' | 'stopped' | 'cancelled'
  }> {
    const startedAt = Date.now()
    // Seed the idle clock at the start of the wait so the first chunk-less
    // poll doesn't insta-trip the idle timeout.
    this.lastAgentDataAt = startedAt
    this.signalGate.beginWaiting()
    this.recordLifecycle('waiting-for-signal', 'Waiting for heal signal', {
      detail: 'The runner is waiting for .restart, .rerun, or .heal.',
      activeCycle: this.healCycles,
    })
    const hardDeadline = startedAt + hardTimeoutMs
    // Always yield to the macrotask queue here — this loop runs concurrently
    // with the signal-watcher setInterval, and a microtask-only delay would
    // starve the timer queue.
    const yieldOnce = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms))
    // When the pty dies before we've seen a signal, give the signal-watcher
    // a short grace window to surface any `.heal`/`.rerun`/`.restart` file
    // the agent wrote just before exiting. Without this, the wait races the
    // watcher's polling and bails immediately, losing signals from agents
    // that write-then-exit. 1s is plenty — the watcher polls at
    // `healSignalPollMs` (≤1s in production).
    let postExitDeadline: number | null = null
    try {
      while (true) {
        if (this.stopped) return { signal: null, reason: 'stopped' }
        if (this.healCancelled) return { signal: null, reason: 'cancelled' }
        const sig = this.signalGate.consume()
        if (sig) {
          return { signal: sig, reason: 'signal' }
        }
        if (requiresAgent && !this.healAgentPty) {
          // Pty is dead: the `pty-died` grace owns the exit. Don't let the
          // hard/idle timeouts steal it — they describe a still-alive REPL,
          // which we no longer have.
          if (postExitDeadline === null) {
            postExitDeadline = Date.now() + 1000
          } else if (Date.now() >= postExitDeadline) {
            return { signal: null, reason: 'pty-died' }
          }
          await yieldOnce(Math.max(1, this.healSignalPollMs))
          continue
        }
        const now = Date.now()
        if (now >= hardDeadline) return { signal: null, reason: 'hard-timeout' }
        if (now - this.lastAgentDataAt >= idleTimeoutMs) {
          return { signal: null, reason: 'idle-timeout' }
        }
        await yieldOnce(Math.max(1, this.healSignalPollMs))
      }
    } finally {
      this.signalGate.endWaiting()
    }
  }

  /**
   * Run one heal cycle inside the persistent REPL.
   *
   * - On the first call (or after a cancel/crash), spawns the long-lived
   *   `claude` / `codex` REPL with `--session-id <uuid>` (claude) and the
   *   playwright MCP wired up.
   * - Renders the cycle prompt and writes it to the REPL's stdin —
   *   subsequent cycles all flow through the same conversation, so the
   *   agent retains context from prior cycles.
   * - Awaits a `.heal` / `.rerun` / `.restart` signal file (or cancel /
   *   timeout / full abort). Returns the signal the caller will interpret.
   *
   * `exitCode` in the return is 0 when the REPL is still alive when we
   * resolve, 1 when it died during the cycle (crash or kill). The auto-heal
   * loop uses it only to surface unexpected exits in the transcript.
   */
  async runHealAgent(args: {
    cycle: number
    failedSlugs: readonly string[]
    userGuidance?: string
    /**
     * Streak counter from `HealCycleState.snapshot().consecutiveSameFailures`,
     * captured by the caller right after `observeFailures`. Threaded through
     * to the cycle prompt builder so the stuck-cycle escalation block can
     * fire when the agent has had two failed attempts on the same set.
     */
    consecutiveSameFailures?: number
  }): Promise<{
    exitCode: number
    signal: { kind: 'restart' | 'rerun' | 'heal'; body: Record<string, unknown> } | null
    reason: 'signal' | 'pty-died' | 'idle-timeout' | 'hard-timeout' | 'stopped' | 'cancelled' | 'spawn-failed'
  }> {
    const cfg = this.autoHeal
    if (!cfg) throw new Error('autoHeal not configured')

    // Write the cycle prompt to `<runDir>/heal-prompt.md` BEFORE we spawn
    // (or before we ask the live REPL to re-read). The wired
    // `buildOrchestratorHealPrompt` writes the file as a side effect and
    // returns the rendered text; we keep the text only for transcript
    // echo bookkeeping — claude reads the file directly via `@<path>`.
    void (cfg.buildCyclePrompt ?? defaultHealPrompt)({
      cycle: args.cycle,
      outputDir: this.healAgentMcpOutputDir ?? this.runDir,
      userGuidance: args.userGuidance,
      consecutiveSameFailures: args.consecutiveSameFailures,
      priorAgentSessionContext: !this.healAgentPty
        ? this.readCrossAgentSessionContext(cfg.agent)
        : undefined,
    })

    const isFirstSpawn = !this.healAgentPty
    if (isFirstSpawn) {
      this.spawnHealAgentRepl(args.failedSlugs)
    }
    const pty = this.healAgentPty
    if (!pty) {
      // spawn failed; spawnHealAgentRepl already surfaced the error.
      return { exitCode: 1, signal: null, reason: 'spawn-failed' }
    }

    if (args.userGuidance) this.echoUserInterject(args.userGuidance)

    // `redirect: true` tells the server-side broker not to reset the pane.
    // Cycle 2+ continues in the *same* long-lived REPL, so wiping the
    // transcript at the cycle boundary would clear the running conversation
    // (visible as a blink). Only the first spawn is a fresh REPL that
    // warrants a clean canvas.
    this.emit('agent-started', {
      cycle: args.cycle,
      command: `<repl ${cfg.agent} cycle=${args.cycle}>`,
      redirect: !isFirstSpawn,
    })

    // Cycle 1 has the prompt already wired into the spawn command's argv
    // (`claude … "@<promptFile>"`), so the agent reads it at startup with no
    // stdin write. Cycle 2+ needs to re-prompt the alive REPL. Avoid `@<path>`
    // here: in Claude's input editor it can attach/read the file without
    // submitting the composer, leaving the run stuck until a human presses
    // Enter. Send a plain instruction with the prompt path instead.
    if (!isFirstSpawn) {
      try {
        const promptMessage = `Read ${this.healPromptFile} and continue the auto-heal cycle now.`
        pty.write(BRACKETED_PASTE_BEGIN + promptMessage + BRACKETED_PASTE_END + '\r')
      } catch {
        return { exitCode: 1, signal: null, reason: 'pty-died' }
      }
    }

    const { signal, reason } = await this.waitForHealSignal(
      this.healAgentTimeoutMs,
      this.healAgentIdleTimeoutMs,
    )
    const exitCode = this.healAgentPty ? 0 : 1
    return { exitCode, signal, reason }
  }

  /** Absolute path to the heal-prompt file written by `buildCyclePrompt`.
   *  Stable across cycles — each cycle overwrites it with that cycle's
   *  prompt body, then references it via claude's `@<path>` syntax. */
  private get healPromptFile(): string {
    return path.join(this.runDir, 'heal-prompt.md')
  }

  /**
   * Spawn the long-lived heal-agent REPL. Idempotent-ish — if a pty is
   * already attached, no-ops. The MCP output dir is pinned at this call
   * (from cycle-1's failed slugs) since claude reads `--mcp-config` once at
   * boot and we don't recompose it across cycles.
   */
  private spawnHealAgentRepl(failedSlugs: readonly string[]): void {
    if (this.healAgentPty) return
    const cfg = this.autoHeal
    if (!cfg) throw new Error('autoHeal not configured')

    const target = resolveMcpOutputDir({
      runDir: this.runDir,
      failedSlugs,
    })
    ensureMcpOutputDir(target.dir)
    this.healAgentMcpOutputDir = target.dir

    // claude can pin via `--session-id <uuid>` on first launch. codex has no
    // equivalent on first launch. For both agents, older/interrupted runs can
    // lack Canary's sidecar files; in that case we recover the latest native
    // CLI session log for this run directory and resume it.
    //
    // On Restart Heal the run dir already has a session id from the previous
    // (failed) heal session — reuse it so the agent continues the prior
    // conversation with full history. Without this, every restart would
    // orphan the previous turns and start the agent's investigation from
    // scratch.
    let sessionId: string | undefined = this.readPriorAgentSessionId(cfg.agent) ?? undefined
    let resume = sessionId !== undefined
    if (!sessionId && cfg.agent === 'claude') sessionId = randomUUID()
    this.healAgentSessionId = sessionId ?? null
    try {
      fs.mkdirSync(path.dirname(this.paths.agentSessionIdPath), { recursive: true })
      if (sessionId) fs.writeFileSync(this.paths.agentSessionIdPath, sessionId)
      else fs.rmSync(this.paths.agentSessionIdPath, { force: true })
    } catch { /* sidecar write is informational */ }

    let command: string
    try {
      command = (cfg.buildSpawnCommand ?? defaultSpawnCommand)({
        sessionId,
        resume,
        mcpOutputDir: target.dir,
        // The cycle-1 prompt was already written to this file by the
        // caller (`runHealAgent`); the wired spawn-command builder
        // appends `"@<promptFile>"` so claude reads it on startup.
        promptFile: this.healPromptFile,
      })
    } catch (err) {
      this.emitAgentSystemMessage(`Failed to build heal-agent spawn command: ${(err as Error).message}`)
      throw err
    }

    let pty: PtyHandle
    try {
      pty = this.ptyFactory({
        command,
        cwd: this.runDir,
        env: this.agentPtyEnv(),
        cols: this.healAgentTerminalSize?.cols,
        rows: this.healAgentTerminalSize?.rows,
      })
    } catch (err) {
      this.emitAgentSystemMessage(`Failed to spawn heal agent: ${(err as Error).message}`)
      throw err
    }
    this.healAgentPty = pty
    this.healAgentStartedAt = new Date().toISOString()
    this.attachAgentDataHandlers(pty)

    // When the REPL exits — either intentionally (cleanup writes /exit then
    // SIGTERM) or unexpectedly (crash) — drop the pty handle so the next
    // cycle's runHealAgent sees no PTY and can decide to bail. Skip if
    // cleanupHealAgentPty already cleared the field — it'll emit agent-exit
    // itself in that path.
    pty.onExit(({ exitCode }) => {
      if (this.healAgentPty !== pty) return
      this.healAgentPty = null
      this.persistAgentSessionRef()
      this.emit('agent-exit', { exitCode })
    })

    // Note: `agent-started` is emitted by runHealAgent per-cycle (with the
    // cycle number). The spawn itself is recorded via the manifest +
    // transcript; we don't fire a second agent-started here so consumers see
    // one event per cycle, matching the headless flow.
    void command
  }

  /**
   * Tear down the persistent REPL. Sends Esc + `/exit\r` first to give the
   * agent a chance to flush, then SIGTERMs the pty (with SIGKILL fallback).
   * Idempotent — no-op when no pty is attached.
   */
  private cleanupHealAgentPty(): void {
    const pty = this.healAgentPty
    // Persist the agent's CLI-native session-log pointer before clearing
    // bookkeeping. This runs once per heal session (the auto-heal loop's
    // finally), so the JSON reflects the final session, not per-cycle.
    this.persistAgentSessionRef()
    if (!pty) return
    // Clear the field first so the onExit handler in spawnHealAgentRepl
    // sees `this.healAgentPty !== pty` and skips re-emitting agent-exit.
    this.healAgentPty = null
    try {
      pty.write('')
      pty.write('/exit\r')
    } catch { /* already gone */ }
    killTree(pty, 'SIGTERM')
    scheduleSigkillFallback(pty)
    this.emit('agent-exit', { exitCode: 0 })
    if (this.healAgentMcpOutputDir) {
      try { capArtifacts(this.healAgentMcpOutputDir) } catch { /* best-effort */ }
    }
    this.healAgentMcpOutputDir = undefined
    this.healAgentSessionId = null
    this.healAgentStartedAt = null
  }

  // Write `<runDir>/agent-session.json` pointing at the agent CLI's own
  // JSONL session log. The UI's structured-view historical replay reads
  // from that JSONL — way more reliable than our PTY byte capture.
  //
  // - claude: log path is fully determined by runDir + sessionId, so we
  //   just verify the file exists at the predicted location.
  // - codex: first launch has no `--session-id` flag, so we discover by
  //   matching cwd + timestamp; locateCodexSessionLog does the directory
  //   scan. After discovery, persist the id for future `codex resume <id>`.
  //
  // Silently skips when the agent never spawned (manual mode, no failure)
  // or when the locator can't find the file (race, user moved it).
  private persistAgentSessionRef(): void {
    if (!this.autoHeal) return
    const agent = this.autoHeal.agent
    let ref: AgentSessionRef | null = null
    if (agent === 'claude' && this.healAgentSessionId) {
      const logPath = locateClaudeSessionLog(this.runDir, this.healAgentSessionId)
      if (logPath) ref = { agent: 'claude', sessionId: this.healAgentSessionId, logPath }
    } else if (agent === 'codex' && this.healAgentStartedAt) {
      const found = locateCodexSessionLog(this.runDir, this.healAgentStartedAt)
      if (found) ref = found
    }
    if (!ref) return
    this.writeAgentSessionRef(ref)
  }

  private readPriorAgentSessionId(agent: AutoHealAgent): string | null {
    const refFile = this.readAgentSessionRefFile()
    const typed = refFile?.sessions[agent]
    if (typed) return readPriorSessionIdFromValue(typed.sessionId)

    if (!refFile) {
      const direct = readPriorSessionId(this.paths.agentSessionIdPath)
      if (direct) return direct
    }

    const found = locateLatestSessionLogForAgent(agent, this.runDir)
    if (found) {
      this.writeAgentSessionRef(found)
      return found.sessionId
    }
    return null
  }

  private readCrossAgentSessionContext(targetAgent: AutoHealAgent): string | undefined {
    const previous = this.findPriorAgentSessionRef(targetAgent)
    if (!previous) return undefined
    const rendered = renderAgentSessionContext(previous)
    return rendered || undefined
  }

  private findPriorAgentSessionRef(targetAgent: AutoHealAgent): AgentSessionRef | null {
    const otherAgent: AutoHealAgent = targetAgent === 'claude' ? 'codex' : 'claude'
    const other = this.readAgentSessionRefFile()?.sessions[otherAgent]
    if (other) return other
    return locateLatestSessionLogForAgent(otherAgent, this.runDir)
  }

  private writeAgentSessionRef(ref: AgentSessionRef): void {
    const existing = this.readAgentSessionRefFile() ?? { sessions: {} }
    const next: AgentSessionRefFile = {
      activeAgent: ref.agent,
      sessions: { ...existing.sessions, [ref.agent]: ref },
    }
    try {
      fs.mkdirSync(path.dirname(this.paths.agentSessionRefPath), { recursive: true })
      fs.writeFileSync(this.paths.agentSessionRefPath, JSON.stringify(next, null, 2))
      fs.writeFileSync(this.paths.agentSessionIdPath, ref.sessionId)
      this.cachedRefFile = next
    } catch { /* best-effort */ }
  }

  private readAgentSessionRefFile(): AgentSessionRefFile | null {
    if (this.cachedRefFile !== undefined) return this.cachedRefFile
    try {
      this.cachedRefFile = parseAgentSessionRefFile(fs.readFileSync(this.paths.agentSessionRefPath, 'utf-8'))
    } catch {
      this.cachedRefFile = null
    }
    return this.cachedRefFile
  }

  // Snapshot every git-tracked edit surface in the feature just before the
  // agent has the floor. The returned map is the input to `diffFeatureRepos`,
  // which computes the list of files the agent actually edited during its
  // turn. Two kinds of entries:
  //
  //   1. **Service repo** (one per `feature.repos[]`): keyed by `localPath`,
  //      diffed in full. `localPath` is assumed to be a git working-tree
  //      root, so paths returned by `git diff --name-only` join directly.
  //
  //   2. **Feature directory** (`feature.featureDir`): keyed by `featureDir`,
  //      diffed via pathspec scoped to the feature subtree of whatever git
  //      repo owns it (typically the workspace repo). Service-repo subtrees
  //      nested under the feature dir are excluded so they aren't double-
  //      counted. Captures the agent's edits to `e2e/helpers/`, test specs,
  //      and feature docs — none of which live in any service repo.
  //
  // Entries that aren't git working trees are silently omitted — the diff
  // for them is empty, which yields a `restart([])` (restart everything)
  // fallback identical to the pre-change behavior when the agent didn't
  // declare files.
  private async snapshotFeatureRepos(): Promise<Map<string, FeatureRepoSnapshot>> {
    const snapshots = new Map<string, FeatureRepoSnapshot>()
    const serviceRepoRoots: string[] = []
    for (const repo of this.feature.repos ?? []) {
      const localPath = repo.localPath
      if (typeof localPath !== 'string') continue
      const ref = await snapshotWorkingTree(localPath)
      if (ref === null) continue
      const absRoot = resolveRepoPath(localPath)
      snapshots.set(localPath, { ref, gitRoot: absRoot })
      serviceRepoRoots.push(absRoot)
    }

    // Layer the feature dir on top: it lives inside a workspace-level git
    // repo (one .git for the whole workspace), so we snapshot from there and
    // scope the diff to `feature.featureDir` via pathspec. Excludes any
    // service-repo subtree that's nested under it.
    const featureDir = this.feature.featureDir
    if (typeof featureDir === 'string' && featureDir.length > 0) {
      const featureDirAbs = resolveRepoPath(featureDir)
      const gitRoot = await getGitRoot(featureDirAbs)
      const ref = await snapshotWorkingTree(featureDirAbs)
      if (gitRoot !== null && ref !== null && !snapshots.has(featureDir)) {
        const excludes = serviceRepoRoots
          .filter((root) => isPathInside(root, featureDirAbs))
          .map((root) => `:(exclude)${root}` satisfies DiffPathspec)
        const pathspecs: DiffPathspec[] = [featureDirAbs, ...excludes]
        snapshots.set(featureDir, { ref, gitRoot, pathspecs })
      }
    }

    return snapshots
  }

  // Diff each snapshotted tree and return absolute paths of the files the
  // agent touched between snapshot and now. Used as ground truth for both the
  // journal entry's `fix.file` line and the orchestrator's restart planning.
  private async diffFeatureRepos(snapshots: Map<string, FeatureRepoSnapshot>): Promise<string[]> {
    const out: string[] = []
    for (const [, snap] of snapshots) {
      const relPaths = await diffNamesSinceSnapshot(snap.gitRoot, snap.ref, snap.pathspecs)
      for (const rel of relPaths) {
        out.push(path.join(snap.gitRoot, rel))
      }
    }
    return out
  }

  // Full unified-diff content (not just names) for each snapshotted tree,
  // joined into one string. Multi-tree features get a `# repo: <key>` header
  // before each diff so the agent (and a human reviewer) can tell which tree
  // each hunk came from. Truncation to MAX_JOURNAL_DIFF_BYTES happens at the
  // journal-writer layer.
  private async diffContentForFeatureRepos(snapshots: Map<string, FeatureRepoSnapshot>): Promise<string> {
    const blocks: string[] = []
    const multiTree = snapshots.size > 1
    for (const [key, snap] of snapshots) {
      const content = await diffContentSinceSnapshot(snap.gitRoot, snap.ref, snap.pathspecs)
      if (!content.trim()) continue
      blocks.push(multiTree ? `# repo: ${key}\n${content}` : content)
    }
    return blocks.join('\n')
  }

  // Top-level "do the whole thing" entry. Boots services, runs Playwright,
  // and—if autoHeal is enabled—loops through heal cycles until one of:
  // tests pass, the cap is hit, the agent gives up without signaling, or the
  // failure set stops changing. Updates manifest status throughout.
  async runFullCycle(): Promise<RunManifest['status']> {
    await this.start()
    if (this.stopped) return this.status
    // A service never came up — the Playwright suite would be meaningless.
    // Declare the run failed and route it into heal (the agent fixes the
    // service) instead of running tests against a dead service.
    if (this.bootFailure) return await this.failRunForBootFailure()
    let exitCode = await this.runPlaywright()
    // If the user clicked Abort while Playwright was running, bail out
    // immediately — don't compute a finalStatus from the killed pty's
    // exit code, and don't fall through into the heal loop where a fresh
    // heal agent would otherwise be spawned. `stop()` has already written
    // 'aborted' to the manifest; honor it.
    if (this.stopped) return this.status
    // Status comes from decideRunStatus, not Playwright's exit byte alone.
    // The summary file is the authoritative record: PASSED requires every
    // AST-visible test to be in `passedNames`, so failed/skipped/pending all
    // block. This catches:
    //   - The pty.onExit→runPlaywright continuation firing BEFORE the user's
    //     pause-heal HTTP request reaches the server (otherwise a graceful
    //     exit-0 would mark "passed, healCycles: 0").
    //   - Playwright catching SIGTERM/SIGINT, partial-flushing, and exiting 0.
    //   - Targeted re-runs that complete cleanly while earlier failures or
    //     pending tests are still recorded in the summary.
    let finalStatus: RunManifest['status'] = decideRunStatus(
      this.feature.featureDir,
      this.paths.summaryPath,
      exitCode,
    )
    // If the user clicked Pause & Heal, Playwright was killed on purpose —
    // even a clean summary mustn't mark the run "passed". The
    // `markStoppedEarly('user-pause')` call inside `pauseAndHeal` is what
    // we key off here. Override so the heal-loop entry condition below fires.
    if (this.stoppedEarlyReason === 'user-pause') {
      finalStatus = 'failed'
    }
    this.setStatus(finalStatus)

    return await this.continueAfterTestRun(finalStatus)
  }

  async runVerification(): Promise<RunManifest['status']> {
    this.prepareRun('stopped')
    if (this.stopped) return this.status
    this.recordLifecycle('running-tests', 'Running verification tests', {
      detail: 'Verify is observational only: Canary Lab will not start services or heal code.',
    })
    const exitCode = await this.runPlaywright()
    if (this.stopped) return this.status
    const finalStatus = decideRunStatus(this.feature.featureDir, this.paths.summaryPath, exitCode)
    this.setStatus(finalStatus)
    return finalStatus
  }

  // Boot-only entry. The envset was applied before construction (by the server's
  // startRun factory). This boots the services + waits for health, then HOLDS
  // them — no Playwright, no heal loop. The run stays active (status 'running',
  // phase 'services-ready') until the user/agent stops it; `stop()` then tears
  // the services down and the server's run-complete handler reverts the envset.
  //
  // Unlike `runFullCycle`, the caller must NOT chain `.then(stop)` on this
  // promise: resolving here means "services are up and held", not "run done".
  // A health-check timeout still `throw`s out of `start()` so the caller's
  // `.catch` can stop()+revert; an abort mid-boot sets `this.stopped`.
  async bootOnly(): Promise<void> {
    await this.start()
    if (this.stopped) return
    this.recordLifecycle('services-ready', 'Services ready — boot-only session (tests skipped)', {
      detail: 'Services are up and held. Stop the run to tear them down and revert the envset.',
      severity: 'success',
    })
  }

  async restartTerminalRun(userGuidance?: string): Promise<RunManifest['status']> {
    await this.start()
    if (this.stopped) return this.status
    if (this.bootFailure) return await this.failRunForBootFailure()
    if (userGuidance) {
      this.runnerLog?.info(`Terminal run restart guidance: ${userGuidance}`)
    }
    const summary = readSummary(this.paths.summaryPath)
    const verificationPlan = this.verificationPlanForSummary(summary)
    let selection = selectionForPlan(verificationPlan)
    if (verificationPlan.kind === 'all-passed') {
      if (summaryHasPassingEvidence(summary)) {
        this.setStatus('passed')
        return 'passed'
      }
      this.recordFullSuiteTerminalRestartFallback(
        'Terminal restart could not find prior passing evidence or a safe remaining-test selector; running the full Playwright suite.',
        verificationPlan.total,
      )
      selection = undefined
    }
    this.setStatus('running')
    const exitCode = await this.runPlaywright(selection)
    if (this.stopped) return this.status
    const finalStatus = decideRunStatus(this.feature.featureDir, this.paths.summaryPath, exitCode)
    this.setStatus(finalStatus)
    return await this.continueAfterTestRun(finalStatus)
  }

  // A service failed to come up, so the suite can't run. Declare the run
  // `failed` and route it into heal exactly like a test failure:
  // heal-configured runs move to 'healing' (the agent reads the failed
  // service's log via the manifest's `bootFailure`); a run with no heal mode
  // ends terminal 'failed' — not 'aborted', because the app is broken, the user
  // didn't stop it.
  private async failRunForBootFailure(): Promise<RunManifest['status']> {
    this.setStatus('failed')
    return await this.continueAfterTestRun('failed')
  }

  // A heal rerun restarted the services but one still failed to come up.
  // Running Playwright against a dead service would only reproduce the same
  // failure, so the heal loops skip the rerun and re-wait for the next fix —
  // this records why, pointing the agent back at the service log.
  private recordBootFailureHealWait(): void {
    const bf = this.bootFailure
    if (!bf) return
    this.recordLifecycle('agent-healing', `Service still down: ${bf.service}`, {
      detail: `${bf.detail} Skipped the test run — fix the service (log: ${bf.logPath}) and signal again.`,
      severity: 'error',
      activeCycle: this.healCycles,
    })
  }

  private async continueAfterTestRun(finalStatus: RunManifest['status']): Promise<RunManifest['status']> {
    if (finalStatus === 'passed') return finalStatus

    // Manual / external heal mode: no agent CLI configured but the user
    // explicitly asked for hand- or external-driven mode. Transition to
    // 'healing' and wait for either the user (manual) or the external client
    // (external, via POST /api/runs/:runId/signal) to write the signal file.
    // Loops until tests pass, the user cancels, or the signal-poll timeout
    // (24h) is hit. Signal watcher (already running) feeds `signalGate` for
    // `waitForHealSignal` to consume.
    if (!this.autoHeal && (this.manualHeal || this.externalHeal)) {
      return await this.runManualExternalHealLoop(finalStatus)
    }

    if (!this.autoHeal) return finalStatus

    // Same abort guard as above: if the user aborted between Playwright
    // exiting and the heal-loop entry, never spawn a heal agent. Without
    // this, auto-heal would race past stop() and start a fresh heal pty
    // the user has no way to interrupt (the row is already 'aborted').
    if (this.stopped) return this.status

    return await this.runAutoHealLoop()
  }

  private async runManualExternalHealLoop(initialStatus: RunManifest['status']): Promise<RunManifest['status']> {
    const MANUAL_TIMEOUT_MS = 24 * 60 * 60 * 1000
    const modeLabel = this.externalHeal ? 'External' : 'Manual'
    const modeCommand = this.externalHeal ? '<external>' : '<manual>'
    const modeDetail = this.externalHeal
      ? 'Waiting for an external AI client (Claude/Codex via MCP) to write a per-run signal file.'
      : 'Waiting for a manual agent or user to write a per-run signal file.'
    let finalStatus = initialStatus
    while (true) {
      this.setStatus('healing')
      this.noteHealCycle()
      this.emit('agent-started', { cycle: this.healCycles, command: modeCommand })
      this.recordLifecycle('agent-healing', `${modeLabel} heal cycle ${this.healCycles} started`, {
        detail: modeDetail,
        activeCycle: this.healCycles,
      })
      // Same snapshot/diff pattern as auto-heal: capture working-tree state
      // before the user starts editing, then diff after the signal arrives
      // so the journal records only what the user changed during this turn.
      const snapshots = await this.snapshotFeatureRepos()
      // Manual heal: no live REPL emits output, so the idle timeout would
      // otherwise fire after 3 min. Set the idle window equal to the hard
      // ceiling so it can't dominate the manual flow.
      const { signal } = await this.waitForHealSignal(MANUAL_TIMEOUT_MS, MANUAL_TIMEOUT_MS, false)
      this.emit('agent-exit', { exitCode: 0 })
      if (this.healCancelled || this.stopped) {
        finalStatus = 'failed'
        this.setStatus(finalStatus)
        break
      }
      if (!signal) {
        finalStatus = 'failed'
        this.setStatus(finalStatus)
        break
      }
      const filesChanged = await this.diffFeatureRepos(snapshots)
      const diffContent = await this.diffContentForFeatureRepos(snapshots)
      try {
        if (signal.kind === 'restart' || signal.kind === 'rerun') {
          appendJournalIteration({
            signal: signal.kind === 'restart' ? '.restart' : '.rerun',
            hypothesis: typeof signal.body.hypothesis === 'string' ? signal.body.hypothesis : undefined,
            filesChanged,
            fixDescription: typeof signal.body.fixDescription === 'string' ? signal.body.fixDescription : undefined,
            diffContent,
            runId: this.runId,
            manifestPath: this.paths.manifestPath,
            summaryPath: this.paths.summaryPath,
            journalPath: this.paths.diagnosisJournalPath,
          })
        }
      } catch { /* journal is best-effort */ }
      const verificationPlan = this.verificationPlanForSummary(readSummary(this.paths.summaryPath))
      this.setStatus('running')
      if (signal.kind === 'restart') {
        await this.restart(filesChanged)
      } else {
        await this.rerun()
      }
      if (this.stopped) return this.status
      const startedBecauseMissing = await this.ensureServicesRunning()
      if (startedBecauseMissing.length > 0) {
        this.recordLifecycle('restarting-services', 'Started missing services', {
          detail: `Started ${startedBecauseMissing.join(', ')} before rerun.`,
          restartPlan: { restarted: [], kept: [], startedBecauseMissing },
        })
      }
      if (this.bootFailure) {
        this.recordBootFailureHealWait()
        continue
      }
      const exitCode = await this.runPlaywright(selectionForPlan(verificationPlan))
      // Manual-heal mirror of the auto-heal abort guard: the top of the
      // loop already checks `stopped`, but the killed Playwright pty's
      // exit code arrives after the abort flips the flag — don't
      // compute a finalStatus from it.
      if (this.stopped) return this.status
      finalStatus = decideRunStatus(this.feature.featureDir, this.paths.summaryPath, exitCode)
      this.setStatus(finalStatus)
      if (finalStatus === 'passed') break
    }
    return finalStatus
  }

  async restartHealFromFailure(userGuidance: string): Promise<RunManifest['status']> {
    if (!this.autoHeal) return 'failed'
    this.prepareRun('stopped')
    if (this.stopped) return this.status
    // The pane broker's in-memory ring buffer is cleared separately (see
    // `restartHeal` in server.ts) so reconnecting subscribers don't see the
    // previous session's bytes. There's no on-disk transcript to truncate.
    return await this.runAutoHealLoop(userGuidance)
  }

  private async runAutoHealLoop(initialUserGuidance?: string): Promise<RunManifest['status']> {
    if (!this.autoHeal) return 'failed'
    let finalStatus: RunManifest['status'] = 'failed'
    const heal = new HealCycleState({
      maxCycles: this.autoHeal.maxCycles ?? AUTO_HEAL_MAX_CYCLES,
    })

    const threshold = this.feature.healOnFailureThreshold
    if (typeof threshold === 'number' && threshold > 0 && !this.stoppedEarlyReason) {
      const { failed: failed0, total: total0 } = summarizeFailures(this.paths.summaryPath)
      if (failed0.length >= threshold) {
        this.markStoppedEarly('max-failures', failed0.length, total0)
      }
    }

    let userGuidance = initialUserGuidance
    try {
      while (true) {
        if (this.stopped) return this.status
        // Cancel observed at the loop top means the user clicked Stop Heal
        // between cycles (or just before the next cycle starts). Bail out
        // before incrementing the cycle counter.
        if (this.healCancelled) {
          finalStatus = 'failed'
          this.setStatus(finalStatus)
          break
        }
        const summary = readSummary(this.paths.summaryPath)
        const failedSlugs = extractFailedSlugs(summary)
        if (failedSlugs.length === 0) {
          const pendingPlan = this.verificationPlanForSummary(summary)
          if (pendingPlan.kind === 'all-passed') {
            if (summaryHasPassingEvidence(summary)) {
              finalStatus = 'passed'
              this.setStatus(finalStatus)
            }
            break
          }
          // This rerun spawns NO heal agent — it just re-executes the
          // not-yet-passed tests. That can only make progress on genuinely
          // not-run (pending) tests; a deterministically skipped test
          // (`test.skip(cond)`) re-runs to the same skipped result every time.
          // Capture the not-passed set before the rerun so a no-progress cycle
          // terminates the run instead of re-running the identical summary
          // forever (the skipped-test infinite-rerun bug).
          const beforeSignature = nonPassedSignatureFromPlan(pendingPlan)
          this.setStatus('running')
          const exitCode = await this.runPlaywright(selectionForPlan(pendingPlan))
          if (this.stopped) return this.status
          if (this.healCancelled) {
            finalStatus = 'failed'
            this.setStatus(finalStatus)
            break
          }
          finalStatus = decideRunStatus(this.feature.featureDir, this.paths.summaryPath, exitCode)
          this.setStatus(finalStatus)
          if (finalStatus === 'passed') break
          const afterSummary = readSummary(this.paths.summaryPath)
          if (
            extractFailedSlugs(afterSummary).length === 0 &&
            nonPassedSignatureFromPlan(computeVerificationPlan(this.feature.featureDir, afterSummary)) === beforeSignature
          ) {
            const skippedCount = pendingPlan.kind === 'targeted' ? pendingPlan.skipped.length : 0
            this.recordLifecycle('rerunning-tests', 'Stopped: not-yet-passed tests stayed unchanged after rerun', {
              detail: skippedCount > 0
                ? `${skippedCount} test${skippedCount === 1 ? '' : 's'} remained skipped; a rerun without a code fix cannot turn skipped tests green. Stopping instead of re-running indefinitely.`
                : 'A rerun made no progress on the not-yet-passed tests; stopping instead of re-running indefinitely.',
              severity: 'warning',
            })
            break
          }
          continue
        }
        const signature = failedSlugs.slice().sort().join('|')
        // `observeFailures` now takes the raw slug array so it can remember it
        // on `snapshot().lastFailingSlugs` — that's what the heal-index uses
        // to compute the "delta vs previous cycle" section. The signature
        // string stays as the human-readable lifecycle-event detail.
        const decision = heal.observeFailures(failedSlugs)
        if (!decision.shouldHeal) break

        // Capture the same-failure streak AFTER `observeFailures` has updated
        // it for this cycle. The threshold-based escalation block in the cycle
        // prompt keys off this value (>= 3 = two prior fix attempts failed on
        // the same failing set).
        const consecutiveSameFailures = heal.snapshot().consecutiveSameFailures

        const cycleNum = heal.beginCycle() + 1
        this.emit('heal-cycle-started', { cycle: cycleNum, failureSignature: signature })
        this.setStatus('healing')
        this.noteHealCycle()
        this.recordLifecycle('agent-healing', `Heal cycle ${cycleNum} started`, {
          detail: signature ? `Failures: ${signature}` : 'No failure signature was available.',
          activeCycle: cycleNum,
        })

        // Snapshot every git-tracked feature repo just before the agent runs.
        // After the signal arrives, the diff against this snapshot is the
        // ground-truth list of files the agent edited during its turn —
        // pre-existing dirty state in the workspace doesn't leak in.
        const snapshots = await this.snapshotFeatureRepos()

        const { signal, reason } = await this.runHealAgent({ cycle: cycleNum, failedSlugs, userGuidance, consecutiveSameFailures })
        userGuidance = undefined

        if (this.stopped) return this.status

        if (this.healCancelled) {
          finalStatus = 'failed'
          this.setStatus(finalStatus)
          break
        }

        const filesChanged = await this.diffFeatureRepos(snapshots)
        const diffContent = await this.diffContentForFeatureRepos(snapshots)

        // No signal: agent exited / went idle / hit the hard ceiling. The
        // `reason` distinguishes which so the transcript can say what
        // actually happened (was it our timeout, or did the agent give up?).
        // Either way, if it edited any feature-repo file, treat as an
        // implicit `.rerun` so we don't discard the work; otherwise log the
        // no-op and end the loop. Journal is always written.
        let effectiveSignal = signal
        if (!effectiveSignal) {
          const idleSec = Math.round(this.healAgentIdleTimeoutMs / 1000)
          const hardMin = Math.round(this.healAgentTimeoutMs / 60_000)
          const reasonMessage =
            reason === 'idle-timeout' ? `Heal agent went silent for ${idleSec}s without writing a signal.`
              : reason === 'hard-timeout' ? `Heal cycle hit the ${hardMin}-minute ceiling without a signal.`
                : reason === 'pty-died' ? 'Heal agent exited without writing a signal.'
                  : reason === 'spawn-failed' ? 'Heal agent failed to spawn.'
                    : `Heal cycle ended without a signal (reason: ${reason}).`
          this.emitAgentSystemMessage(reasonMessage)

          if (filesChanged.length === 0) {
            try {
              appendJournalIteration({
                signal: 'none',
                hypothesis: `${reasonMessage} No code changes detected.`,
                fixDescription: 'No fix applied.',
                runId: this.runId,
                manifestPath: this.paths.manifestPath,
                summaryPath: this.paths.summaryPath,
                journalPath: this.paths.diagnosisJournalPath,
              })
            } catch { /* journal write is best-effort */ }
            this.emitAgentSystemMessage('No code changes detected — ending the heal loop.')
            finalStatus = 'failed'
            this.setStatus(finalStatus)
            break
          }
          this.emitAgentSystemMessage('Code changes detected — inferring a rerun from git diff.')
          effectiveSignal = {
            kind: 'rerun',
            body: {
              hypothesis: `${reasonMessage} Runner inferred a rerun from git diff.`,
              fixDescription: 'Inferred from git diff — agent did not write a signal body.',
            },
          }
        }

        try {
          if (effectiveSignal.kind === 'restart' || effectiveSignal.kind === 'rerun') {
            appendJournalIteration({
              signal: effectiveSignal.kind === 'restart' ? '.restart' : '.rerun',
              hypothesis: typeof effectiveSignal.body.hypothesis === 'string' ? effectiveSignal.body.hypothesis : undefined,
              filesChanged,
              fixDescription: typeof effectiveSignal.body.fixDescription === 'string' ? effectiveSignal.body.fixDescription : undefined,
              diffContent,
              runId: this.runId,
              manifestPath: this.paths.manifestPath,
              summaryPath: this.paths.summaryPath,
              journalPath: this.paths.diagnosisJournalPath,
            })
          }
        } catch { /* journal write is best-effort */ }

        const verificationPlan = this.verificationPlanForSummary(summary)
        this.setStatus('running')

        const action = heal.actionForSignal(effectiveSignal.kind === 'heal' ? 'rerun' : effectiveSignal.kind)
        if (action.kind === 'restart-and-rerun') {
          const { restarted, kept, startedBecauseMissing } = await this.restart(filesChanged)
          if (this.stopped) return this.status
          this.healCycleHistory.push({ cycle: cycleNum, restarted, kept })
          this.stateSink.patchManifest(this.runId, {
            healCycleHistory: this.healCycleHistory,
          })
          if (startedBecauseMissing.length > 0) {
            this.recordLifecycle('restarting-services', 'Starting missing kept services', {
              detail: `Starting ${startedBecauseMissing.join(', ')} because this heal restart is running in a fresh orchestrator process.`,
              restartPlan: { restarted, kept, startedBecauseMissing },
            })
          }
        } else {
          await this.rerun()
        }
        if (this.stopped) return this.status
        const startedBecauseMissing = await this.ensureServicesRunning()
        if (startedBecauseMissing.length > 0) {
          this.recordLifecycle('restarting-services', 'Started missing services', {
            detail: `Started ${startedBecauseMissing.join(', ')} before rerun.`,
            restartPlan: { restarted: [], kept: [], startedBecauseMissing },
          })
        }

        if (this.bootFailure) {
          this.recordBootFailureHealWait()
          continue
        }
        const exitCode = await this.runPlaywright(selectionForPlan(verificationPlan))
        if (this.stopped) return this.status
        // User cancelled mid-Playwright (cancelHeal SIGTERM'd the pw pty).
        // Don't read into the killed pty's exit code — finalize as failed.
        if (this.healCancelled) {
          finalStatus = 'failed'
          this.setStatus(finalStatus)
          break
        }
        finalStatus = decideRunStatus(this.feature.featureDir, this.paths.summaryPath, exitCode)
        this.setStatus(finalStatus)
        if (finalStatus === 'passed') break
      }

      return finalStatus
    } finally {
      // Drop the persistent REPL however the loop terminated — clean break,
      // failure, cancel, threshold, or thrown error. `stop()` also nukes the
      // pty during a full abort, so the second cleanup here is a no-op.
      this.cleanupHealAgentPty()
    }
  }

  /** Write a heartbeat timestamp to the manifest every 5 seconds so consumers
   *  can detect orphaned runs whose orchestrator crashed without cleaning up. */
  private startHeartbeat(): void {
    const tick = (): void => {
      if (this.stopped) return
      this.stateSink.recordHeartbeat(this.runId)
    }
    this.heartbeatTimer = setInterval(tick, 5_000)
    // Don't keep the process alive just for heartbeats.
    this.heartbeatTimer.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  setStatus(status: RunManifest['status']): void {
    // Once the run has been stopped (e.g. user clicked Abort), drop any
    // further status writes coming from the in-flight runFullCycle /
    // heal-loop. Without this guard the killed Playwright pty's exit code
    // would race the abort and overwrite `aborted` with `passed`/`failed`.
    // `stop()` is the single authority for the terminal manifest write.
    if (this.stopped) return
    this.status = status
    this.emit('run-status', { status })
    this.stateSink.setStatus(this.runId, status, this.healCycles)
    if (status === 'passed' || status === 'failed') {
      this.recordLifecycle(status, status === 'passed' ? 'Run passed' : 'Run failed', {
        severity: status === 'passed' ? 'success' : 'error',
      })
    }
  }

  noteHealCycle(): void {
    this.healCycles += 1
    this.stateSink.patchManifest(this.runId, { healCycles: this.healCycles })
  }

  async stop(finalStatus: RunManifest['status'] = 'aborted'): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.signalWatcher) {
      clearInterval(this.signalWatcher)
      this.signalWatcher = null
    }
    this.stopHeartbeat()
    // Kill any in-flight Playwright + heal-agent ptys before services so the
    // user's abort actually stops the visible processes — not just the
    // services they happen to depend on. `killTree` targets the process group
    // (negative pid) so children of the shell pipeline (claude, formatter)
    // also receive the signal; bare `pty.kill` only signals the shell.
    if (this.playwrightPty) {
      killTree(this.playwrightPty, 'SIGTERM')
      scheduleSigkillFallback(this.playwrightPty)
      this.playwrightPty = null
    }
    if (this.healAgentPty) {
      killTree(this.healAgentPty, 'SIGTERM')
      scheduleSigkillFallback(this.healAgentPty)
      this.healAgentPty = null
    }
    for (const [name, pty] of this.servicePtys) {
      killTree(pty, 'SIGTERM')
      this.servicePtys.delete(name)
    }
    this.logFiles.clear()
    // Release per-run isolation resources. Ports go back to the pool. For a
    // PORTIFIED run we reverse the overlay but KEEP the worktree — it holds the
    // heal agent's repair edits, and it follows the normal run-worktree
    // lifecycle (the Cleanup page lists/opens/removes it). For a non-portified
    // worktree run, tear the worktree down so the source repo doesn't
    // accumulate stale checkouts. Failures here must not block finalization.
    if (this.portMap) releasePorts(this.portMap.values())
    if (this.portified) {
      await this.reversePortifyOverlay().catch(() => {})
    } else {
      for (const handle of this.worktreeHandles) {
        await removeWorktree(handle).catch(() => {})
      }
    }
    const endedAt = new Date().toISOString()
    this.status = finalStatus
    // Single terminal write — services flipped to 'stopped', status +
    // endedAt + healCycles persisted, runs-index mirrored. The sink is the
    // only writer at this point; no other path can race because
    // `this.stopped = true` already gates `setStatus`.
    this.stateSink.finalize(this.runId, finalStatus, endedAt, this.healCycles)
    // A boot-only session ending is a normal teardown, not a failure: give it a
    // calm "services stopped" headline (info, no abortReason) instead of the
    // warning-tinted "Run aborted" a test run gets.
    const isBoot = this.executionType === 'boot'
    const finalPhase = finalLifecyclePhase(finalStatus)
    const finalHeadline = finalStatus === 'aborted'
      ? (isBoot ? 'Services stopped — envset reverted' : 'Run aborted')
      : finalStatus === 'passed' ? 'Run passed' : 'Run failed'
    if (this.lastLifecycleEvent?.phase !== finalPhase || this.lastLifecycleEvent.headline !== finalHeadline) {
      this.recordLifecycle(finalPhase, finalHeadline, {
        severity: finalStatus === 'passed' ? 'success' : finalStatus === 'aborted' ? (isBoot ? 'info' : 'warning') : 'error',
        ...(finalStatus === 'aborted' && !isBoot ? { abortReason: this.pendingAbortReason ?? { reason: 'run-stopped' } } : {}),
      })
    }
    this.emit('run-complete', { status: finalStatus })
  }
}

// ─── Module helpers ─────────────────────────────────────────────────────────

interface SummaryShape {
  failed?: Array<{ name?: unknown; endTime?: unknown; location?: unknown }>
  passed?: unknown
  passedNames?: unknown
  skippedNames?: unknown
  total?: unknown
  knownTests?: unknown
}

interface KnownSummaryTest {
  name: string
  title: string
  titlePath?: string[]
  location?: string
}

export function countPassed(summary: SummaryShape): number {
  return typeof summary.passed === 'number' ? summary.passed : 0
}

function computedTotal(summary: SummaryShape): number {
  return typeof summary.total === 'number' ? summary.total : 0
}

function signalLabel(kind: 'restart' | 'rerun' | 'heal'): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function startingServicesDetail(serviceCount: number): string {
  return serviceCount === 0
    ? 'No services are configured for this feature.'
    : `Starting ${serviceCount} service${serviceCount === 1 ? '' : 's'}.`
}

function restartPlanDetail(restarted: string[], kept: string[], startedBecauseMissing: string[]): string {
  const parts: string[] = []
  if (restarted.length > 0) parts.push(`Restarting ${restarted.join(', ')}.`)
  if (kept.length > 0) parts.push(`Keeping warm ${kept.join(', ')}.`)
  if (startedBecauseMissing.length > 0) parts.push(`Will start missing kept service${startedBecauseMissing.length === 1 ? '' : 's'} ${startedBecauseMissing.join(', ')} before rerun.`)
  return parts.join(' ') || 'No service restart is required.'
}

function finalLifecyclePhase(status: RunManifest['status']): RunLifecyclePhase {
  if (status === 'passed') return 'passed'
  if (status === 'aborted') return 'aborted'
  if (status === 'failed') return 'failed'
  return 'completed'
}

// Read just the `stoppedEarly.reason` field from a manifest on disk. Returns
// undefined if the manifest is missing, unparseable, or doesn't carry the
// field. Used by the heal loop to avoid clobbering an explicit 'user-pause'
// stamp with the automatic 'max-failures' attribution.
export function stoppedEarlyReasonOf(manifestPath: string): StoppedEarlyReason | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      stoppedEarly?: { reason?: StoppedEarlyReason }
    }
    return m.stoppedEarly?.reason
  } catch {
    return undefined
  }
}

export function readSummary(summaryPath: string): SummaryShape {
  try {
    return JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as SummaryShape
  } catch {
    return {}
  }
}

export type NonPassedTargetsResult =
  | { kind: 'targeted'; locations: string[]; total: number }
  | { kind: 'all-passed'; total: number }
  | { kind: 'no-passed-yet'; total: number }
  | { kind: 'extraction-failed' }

export type RerunTargetsOrderedResult =
  | {
      kind: 'targeted'
      locations: string[]
      failedFirst: string[]
      skipped: string[]
      pending: string[]
      droppedFailedSlugs: string[]
      total: number
    }
  | { kind: 'all-passed'; total: number }
  | { kind: 'extraction-failed' }

export type VerificationPlan =
  | {
      kind: 'targeted'
      selection: PlaywrightRerunSelection
      failedFirst: KnownSummaryTest[]
      skipped: KnownSummaryTest[]
      pending: KnownSummaryTest[]
      total: number
    }
  | { kind: 'full-suite'; reason: string; total: number }
  | { kind: 'all-passed'; total: number }

export function computeVerificationPlan(
  featureDir: string,
  summary: SummaryShape,
): VerificationPlan {
  const knownTests = knownTestsFromSummary(summary)
  if (knownTests.length > 0) {
    const passed = passedNameSet(summary)
    const skippedSet = skippedNameSet(summary)
    const failedSlugs = extractFailedSlugs(summary).filter((slug) => !passed.has(slug))
    const failedSet = new Set(failedSlugs)
    const knownByName = new Map(knownTests.map((test) => [test.name, test] as const))
    const missingFailed = failedSlugs.filter((slug) => !knownByName.has(slug))
    const failedFirst = uniqueByName(failedSlugs
      .map((slug) => knownByName.get(slug))
      .filter((test): test is KnownSummaryTest => Boolean(test)))
    const skipped = knownTests.filter((test) => !passed.has(test.name) && !failedSet.has(test.name) && skippedSet.has(test.name))
    const pending = knownTests.filter((test) => !passed.has(test.name) && !failedSet.has(test.name) && !skippedSet.has(test.name))
    const selected = [...failedFirst, ...skipped, ...pending]
    if (selected.length === 0) return { kind: 'all-passed', total: knownTests.length }
    if (missingFailed.length > 0) {
      return {
        kind: 'full-suite',
        total: knownTests.length,
        reason: `Post-heal rerun could not match ${missingFailed.length} failed test${missingFailed.length === 1 ? '' : 's'} in the known Playwright inventory; running the full suite with the configured failure threshold.`,
      }
    }
    const grep = grepForKnownTests(selected)
    if (!grep) {
      return {
        kind: 'full-suite',
        total: knownTests.length,
        reason: 'Post-heal rerun could not build a safe title selector for every not-yet-passed test; running the full suite with the configured failure threshold.',
      }
    }
    const passedCount = countPassed(summary)
    const failedCount = Array.isArray(summary.failed) ? summary.failed.length : 0
    const reason = `Rerunning ${selected.length} not-yet-passed tests (${failedFirst.length} failed first, then ${skipped.length} skipped, then ${pending.length} pending/not-run) because ${passedCount} passed and ${failedCount} failed before healing.`
    return {
      kind: 'targeted',
      selection: {
        kind: 'grep',
        grep,
        selected: selected.length,
        total: knownTests.length,
        mode: 'failed-and-pending',
        reason,
      },
      failedFirst,
      skipped,
      pending,
      total: knownTests.length,
    }
  }

  const computed = computeRerunTargetsOrdered(featureDir, summary)
  if (computed.kind === 'all-passed') return { kind: 'all-passed', total: computed.total }
  if (computed.kind === 'targeted') {
    if (computed.droppedFailedSlugs.length > 0) {
      return {
        kind: 'full-suite',
        total: computed.total,
        reason: `Post-heal rerun could not safely target ${computed.droppedFailedSlugs.length} previously failed test${computed.droppedFailedSlugs.length === 1 ? '' : 's'} from static spec extraction; running the full suite with the configured failure threshold.`,
      }
    }
    const passedCount = countPassed(summary)
    const failedCount = Array.isArray(summary.failed) ? summary.failed.length : 0
    const reason = `Rerunning ${computed.locations.length} not-yet-passed tests (${computed.failedFirst.length} failed first, then ${computed.skipped.length} skipped, then ${computed.pending.length} pending/not-run) because ${passedCount} passed and ${failedCount} failed before healing.`
    return {
      kind: 'targeted',
      selection: {
        kind: 'targets',
        targets: computed.locations,
        selected: computed.locations.length,
        total: computed.total,
        mode: 'failed-and-pending',
        reason,
      },
      failedFirst: computed.failedFirst.map((location) => ({
        name: location,
        title: location,
        location,
      })),
      skipped: computed.skipped.map((location) => ({
        name: location,
        title: location,
        location,
      })),
      pending: computed.pending.map((location) => ({
        name: location,
        title: location,
        location,
      })),
      total: computed.total,
    }
  }

  const failedSlugs = extractFailedSlugs(summary)
  if (failedSlugs.length === 0) return { kind: 'all-passed', total: computedTotal(summary) }
  const locations = extractFailedLocations(summary)
  const canTargetEveryFailure = locations.length >= failedSlugs.length && locations.every(isSpecLocation)
  if (canTargetEveryFailure) {
    const reason = `Rerunning ${locations.length} failed test location${locations.length === 1 ? '' : 's'} from the summary because the full Playwright inventory is unavailable.`
    return {
      kind: 'targeted',
      selection: {
        kind: 'targets',
        targets: locations,
        selected: locations.length,
        total: computedTotal(summary) || locations.length,
        mode: 'failed-and-pending',
        reason,
      },
      failedFirst: locations.map((location) => ({ name: location, title: location, location })),
      skipped: [],
      pending: [],
      total: computedTotal(summary) || locations.length,
    }
  }
  return {
    kind: 'full-suite',
    total: computedTotal(summary) || failedSlugs.length,
    reason: 'Post-heal rerun has failed tests without a complete safe selector set; running the full Playwright suite with the configured failure threshold.',
  }
}

// Compute the ordered list of file:line locations for a post-heal rerun:
// previously-failed tests FIRST (so we verify the fix landed), then anything
// still pending in source order. Failed locations are looked up by slug in the
// CURRENT AST so the rerun resolves correctly even if the heal agent moved
// the test to a new line. Slugs that no longer exist in the AST (the agent
// renamed or deleted the test) are reported via `droppedFailedSlugs` so the
// caller can surface a lifecycle warning instead of silently shipping a
// `file:line` that Playwright will report as "no tests found".
export function computeRerunTargetsOrdered(
  featureDir: string,
  summary: SummaryShape,
): RerunTargetsOrderedResult {
  const files = listSpecFiles(featureDir)
  if (files.length === 0) return { kind: 'extraction-failed' }

  const allTests: Array<{ location: string; slug: string }> = []
  let parsedAny = false
  for (const file of files) {
    let source = ''
    try { source = fs.readFileSync(file, 'utf-8') } catch { continue }
    const result = extractTestsFromSource(file, source)
    if (result.parseError && result.tests.length === 0) continue
    parsedAny = true
    for (const t of result.tests) {
      allTests.push({
        location: `${file}:${t.line}`,
        slug: `test-case-${slugify(t.name)}`,
      })
    }
  }
  if (!parsedAny || allTests.length === 0) return { kind: 'extraction-failed' }

  const locationBySlug = new Map<string, string>()
  for (const t of allTests) {
    if (!locationBySlug.has(t.slug)) locationBySlug.set(t.slug, t.location)
  }

  const passedRaw = Array.isArray(summary.passedNames) ? summary.passedNames : []
  const passed = new Set(passedRaw.filter((n): n is string => typeof n === 'string'))
  const skipped = skippedNameSet(summary)

  const failedSlugs = extractFailedSlugs(summary)
  const failedFirstSlugs = new Set<string>()
  const failedFirst: string[] = []
  const droppedFailedSlugs: string[] = []
  for (const slug of failedSlugs) {
    if (passed.has(slug)) continue // recovered between snapshots
    if (failedFirstSlugs.has(slug)) continue
    const loc = locationBySlug.get(slug)
    if (!loc) {
      droppedFailedSlugs.push(slug)
      continue
    }
    failedFirstSlugs.add(slug)
    failedFirst.push(loc)
  }

  const skippedLocations: string[] = []
  const seenLocations = new Set<string>(failedFirst)
  for (const t of allTests) {
    if (passed.has(t.slug)) continue
    if (failedFirstSlugs.has(t.slug)) continue
    if (!skipped.has(t.slug)) continue
    if (seenLocations.has(t.location)) continue
    seenLocations.add(t.location)
    skippedLocations.push(t.location)
  }

  const pending: string[] = []
  for (const t of allTests) {
    if (passed.has(t.slug)) continue
    if (failedFirstSlugs.has(t.slug)) continue
    if (skipped.has(t.slug)) continue
    if (seenLocations.has(t.location)) continue
    seenLocations.add(t.location)
    pending.push(t.location)
  }

  if (failedFirst.length === 0 && skippedLocations.length === 0 && pending.length === 0) {
    return { kind: 'all-passed', total: allTests.length }
  }
  return {
    kind: 'targeted',
    locations: [...failedFirst, ...skippedLocations, ...pending],
    failedFirst,
    skipped: skippedLocations,
    pending,
    droppedFailedSlugs,
    total: allTests.length,
  }
}

// Compute file:line locations for every test that has NOT yet passed in the
// given summary — i.e. the union of failed + pending. Used on heal restart so
// the agent re-runs everything still outstanding, not just the ones that
// failed last cycle. Returns a discriminated result so the caller can decide
// whether to skip the targeted rerun (full-suite is equivalent or no work to
// do) or fall back to legacy failed-only targeting on enumeration failure.
export function computeNonPassedTargets(
  featureDir: string,
  summary: SummaryShape,
): NonPassedTargetsResult {
  const files = listSpecFiles(featureDir)
  if (files.length === 0) return { kind: 'extraction-failed' }

  const allTests: Array<{ location: string; slug: string }> = []
  let parsedAny = false
  for (const file of files) {
    let source = ''
    try { source = fs.readFileSync(file, 'utf-8') } catch { continue }
    const result = extractTestsFromSource(file, source)
    if (result.parseError && result.tests.length === 0) continue
    parsedAny = true
    for (const t of result.tests) {
      allTests.push({
        location: `${file}:${t.line}`,
        slug: `test-case-${slugify(t.name)}`,
      })
    }
  }
  if (!parsedAny || allTests.length === 0) return { kind: 'extraction-failed' }

  const passedRaw = Array.isArray(summary.passedNames) ? summary.passedNames : []
  const passed = new Set(passedRaw.filter((n): n is string => typeof n === 'string'))

  if (passed.size === 0) return { kind: 'no-passed-yet', total: allTests.length }

  const seen = new Set<string>()
  const locations: string[] = []
  for (const t of allTests) {
    if (passed.has(t.slug)) continue
    if (seen.has(t.location)) continue
    seen.add(t.location)
    locations.push(t.location)
  }

  if (locations.length === 0) return { kind: 'all-passed', total: allTests.length }
  return { kind: 'targeted', locations, total: allTests.length }
}

function knownTestsFromSummary(summary: SummaryShape): KnownSummaryTest[] {
  const raw = Array.isArray(summary.knownTests) ? summary.knownTests : []
  const out: KnownSummaryTest[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as {
      name?: unknown
      title?: unknown
      titlePath?: unknown
      location?: unknown
    }
    if (typeof value.name !== 'string' || value.name.length === 0) continue
    if (typeof value.title !== 'string' || value.title.length === 0) continue
    if (out.some((test) => test.name === value.name)) continue
    out.push({
      name: value.name,
      title: value.title,
      ...(Array.isArray(value.titlePath)
        ? { titlePath: value.titlePath.filter((part): part is string => typeof part === 'string' && part.length > 0) }
        : {}),
      ...(typeof value.location === 'string' && value.location.length > 0 ? { location: value.location } : {}),
    })
  }
  return out
}

function passedNameSet(summary: SummaryShape): Set<string> {
  const passedRaw = Array.isArray(summary.passedNames) ? summary.passedNames : []
  return new Set(passedRaw.filter((name): name is string => typeof name === 'string' && name.length > 0))
}

function skippedNameSet(summary: SummaryShape): Set<string> {
  const skippedRaw = Array.isArray(summary.skippedNames) ? summary.skippedNames : []
  return new Set(skippedRaw.filter((name): name is string => typeof name === 'string' && name.length > 0))
}

function summaryHasPassingEvidence(summary: SummaryShape): boolean {
  if (knownTestsFromSummary(summary).length > 0) return true
  const total = computedTotal(summary)
  return total > 0 && countPassed(summary) >= total
}

function uniqueByName(tests: KnownSummaryTest[]): KnownSummaryTest[] {
  const seen = new Set<string>()
  const out: KnownSummaryTest[] = []
  for (const test of tests) {
    if (seen.has(test.name)) continue
    seen.add(test.name)
    out.push(test)
  }
  return out
}

function grepForKnownTests(tests: KnownSummaryTest[]): string | null {
  const titles = Array.from(new Set(tests.map((test) => test.title).filter(Boolean)))
  if (titles.length === 0) return null
  const escaped = titles.map(escapeRegExp)
  return escaped.length === 1 ? escaped[0] : `(?:${escaped.join('|')})`
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function isSpecLocation(location: string): boolean {
  return /(?:\.spec\.[cm]?[jt]sx?|\.test\.[cm]?[jt]sx?):\d+(?::\d+)?$/.test(location)
}

function selectionForPlan(plan: VerificationPlan): PlaywrightRerunSelection | undefined {
  return plan.kind === 'targeted' ? plan.selection : undefined
}

// Stable signature of the not-yet-passed test set a plan would re-run. Used by
// the auto-heal no-agent rerun branch to detect a no-progress cycle: if a rerun
// leaves this set unchanged, re-running again would produce the identical
// result (e.g. the only remaining tests are deterministically skipped via
// `test.skip(cond)`), so the loop must stop instead of spinning forever.
function nonPassedSignatureFromPlan(plan: VerificationPlan): string {
  if (plan.kind === 'all-passed') return ''
  if (plan.kind === 'full-suite') return `full-suite:${plan.total}`
  return [...plan.failedFirst, ...plan.skipped, ...plan.pending]
    .map((test) => test.name)
    .sort()
    .join('|')
}

function normalizeRerunSelection(rerun?: readonly string[] | PlaywrightRerunSelection): PlaywrightRerunSelection | undefined {
  if (!rerun) return undefined
  if (!Array.isArray(rerun)) return rerun as PlaywrightRerunSelection
  const targets = rerun as readonly string[]
  if (targets.length === 0) return undefined
  return {
    kind: 'targets',
    targets,
    selected: targets.length,
    total: targets.length,
    mode: 'failed-and-pending',
    reason: 'The runner selected tests that had not passed yet.',
  }
}

export function extractFailedSlugs(summary: SummaryShape): string[] {
  const failed = Array.isArray(summary.failed) ? summary.failed : []
  return failed
    .map((f) => (typeof f?.name === 'string' ? (f.name as string) : ''))
    .filter((n) => n.length > 0)
}

export function extractFailedLocations(summary: SummaryShape): string[] {
  const failed = Array.isArray(summary.failed) ? summary.failed : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of failed) {
    const location = typeof entry?.location === 'string' ? entry.location.trim() : ''
    if (!/:\d+(?::\d+)?$/.test(location)) continue
    if (seen.has(location)) continue
    seen.add(location)
    out.push(location)
  }
  return out
}

export function summarizeFailures(summaryPath: string): { failed: string[]; total: number } {
  const summary = readSummary(summaryPath)
  const failed = extractFailedSlugs(summary)
  const total = typeof summary.total === 'number' ? summary.total : failed.length
  return { failed, total }
}

export function readLatestHealOnFailureThreshold(feature: FeatureConfig): number | undefined {
  try {
    const featureDir = path.resolve(feature.featureDir)
    const latest = loadFeatures(path.dirname(featureDir))
      .find((candidate) => path.resolve(candidate.featureDir) === featureDir || candidate.name === feature.name)
    return latest ? latest.healOnFailureThreshold : feature.healOnFailureThreshold
  } catch {
    return feature.healOnFailureThreshold
  }
}

// PASSED only when (a) Playwright exited 0 AND (b) every known test is in
// summary.passedNames. The reporter's runtime `knownTests` inventory is the
// first source of truth so helper/factory-generated tests count; static spec
// extraction remains only as a legacy fallback.
export function decideRunStatus(
  featureDir: string,
  summaryPath: string,
  exitCode: number,
): 'passed' | 'failed' {
  if (exitCode !== 0) return 'failed'
  const summary = readSummary(summaryPath)
  return computeVerificationPlan(featureDir, summary).kind === 'all-passed' ? 'passed' : 'failed'
}

const SUMMARY_REPORTER_PATH = path.resolve(__dirname, 'summary-reporter.js')

// Bracketed-paste sequences. Modern TUIs (claude REPL included) toggle
// `\x1b[?2004h` on init to opt into "this is a paste" framing — text
// between the markers is inserted into the input field as a single block
// instead of being processed by the line editor character-by-character.
// Without these wrappers, every word the orchestrator writes via
// `pty.write` shows up in the transcript as `<word>\x1b[1C<word>...`,
// producing messy output and ballooning the log size.
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

// Production Playwright invocation. Uses `npx playwright test` with our custom
// summary reporter, rooted at the feature dir. Tests inject their own.
export const defaultPlaywrightSpawner: PlaywrightSpawner = ({ feature, paths, rerunTargets, rerunGrep }) => {
  const reporter = SUMMARY_REPORTER_PATH
  const threshold = feature.healOnFailureThreshold
  const maxFailures = typeof threshold === 'number' && threshold > 0
    ? ` --max-failures=${threshold}`
    : ''
  const targets = rerunTargets && rerunTargets.length > 0
    ? ` ${rerunTargets.map((target) => JSON.stringify(target)).join(' ')}`
    : ''
  const grep = rerunGrep ? ` --grep=${JSON.stringify(rerunGrep)}` : ''
  return {
    command: `npx playwright test${targets}${grep} --output=${JSON.stringify(paths.playwrightArtifactsDir)} --reporter=${JSON.stringify(reporter)},list${maxFailures}`,
    cwd: feature.featureDir,
  }
}

// Send `signal` to the entire process group of `pty`. node-pty spawns its
// child in a fresh session, so the pty's pid is the pgid — `process.kill(-pid, ...)`
// hits the shell AND its pipeline children (claude, formatter). Falls back to
// the pty's own kill (which only signals the shell) if pgkill fails — better
// than nothing.
function killTree(pty: PtyHandle, signal: NodeJS.Signals | number): void {
  try {
    process.kill(-pty.pid, signal)
    return
  } catch { /* fall through */ }
  try { pty.kill(typeof signal === 'string' ? signal : undefined) } catch { /* already dead */ }
}

// SIGTERM gives the agent time to flush. If it's still alive 2s later, SIGKILL
// the group so a wedged child doesn't outlive the run.
function scheduleSigkillFallback(pty: PtyHandle, ms = 2000): void {
  setTimeout(() => {
    try { process.kill(-pty.pid, 'SIGKILL') } catch { /* already dead */ }
  }, ms).unref?.()
}

function formatUserInterjectBlock(text: string, startedAt: string, now: Date = new Date()): string {
  const tag = formatElapsedTag(startedAt, now)
  const body = text.split(/\r?\n/).map((line) => `  │ ${line}`).join('\n')
  return `\n${tag} user interject\n${body}\n\n`
}

function formatElapsedTag(startedAt: string, now: Date): string {
  const started = new Date(startedAt).getTime()
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : 0
  const s = Math.floor(elapsedMs / 1000)
  const mm = Math.floor(s / 60)
  const ss = (s % 60).toString().padStart(2, '0')
  return `[${mm}:${ss}]`
}

// Production wires `buildAgentSpawnCommand` / `buildOrchestratorHealPrompt`
// from auto-heal.ts; these defaults are intentionally minimal so unit tests
// never silently run a real claude/codex REPL when an override is missing.
export function defaultSpawnCommand(_args: {
  sessionId?: string
  resume?: boolean
  mcpOutputDir?: string
  promptFile?: string
}): string {
  // A `cat` keeps the pty alive (so the orchestrator can write prompts to
  // its stdin and pty.onExit doesn't fire mid-loop) and echoes everything we
  // type, which is enough for assertions about prompt content in tests.
  return 'cat'
}

export function defaultHealPrompt(args: BuildHealCyclePromptArgs): string {
  const guidance = args.userGuidance ? ` guidance="${args.userGuidance}"` : ''
  const prior = args.priorAgentSessionContext ? ' prior-session=true' : ''
  return `[heal-agent placeholder cycle=${args.cycle} mcp-out=${args.outputDir}${guidance}${prior}]`
}
