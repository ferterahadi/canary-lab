import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type { FeatureConfig, HealthProbe, HttpProbe, TcpProbe } from '../../../../shared/launcher/types'
import {
  HealSignalGate,
  createRunLifecycleEvent,
  type HealSignal,
  type HealSignalKind,
} from '../../../../shared/run-state'
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
} from '../agent-session-log'
import type { RunnerLog } from './runner-log'
import {
  resolveMcpOutputDir,
  ensureMcpOutputDir,
  capArtifacts,
} from './playwright-mcp-artifacts'
import { planRestart } from './restart-planner'
import { interpolateConfigTokens, makeTokenCache } from './launcher/interpolate'
import { readPlaywrightArtifactPolicy } from './playwright-artifact-policy'
import { slugify } from './summary-reporter'
import { listSpecFiles } from '../feature-loader'
import { extractTestsFromSource } from '../ast-extractor'
import {
  diffContentSinceSnapshot,
  diffNamesSinceSnapshot,
  resolveRepoPath,
  snapshotWorkingTree,
} from '../git-repo'

// Headless event-emitting orchestrator for a single feature run. Wraps the
// existing health-check / signal-file semantics behind a clean API the future
// Fastify server can drive without inheriting any readline / iTerm cruft.

export interface ServiceSpec {
  name: string
  safeName: string
  command: string
  cwd: string
  /** Resolved per-env readiness probe (single transport). */
  healthProbe?: HealthProbe
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

export type AutoHealAgent = 'claude' | 'codex'

export interface AutoHealConfig {
  agent: AutoHealAgent
  // 1-based cap on heal cycles. Default = AUTO_HEAL_MAX_CYCLES.
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

export type PlaywrightSpawner = (args: {
  feature: FeatureConfig
  paths: RunPaths
  rerunTargets?: readonly string[]
}) => PlaywrightInvocation

export function buildServiceSpecs(
  feature: FeatureConfig,
  runDir: string,
  env?: string,
): ServiceSpec[] {
  const out: ServiceSpec[] = []
  // ${slot.key} tokens in feature.config values resolve from the chosen env's
  // envset slot files at boot time. The cache shares parsed slot files across
  // every value in this build pass.
  const tokenCtx = { envName: env, envsetsDir: path.join(feature.featureDir, 'envsets') }
  const tokenCache = makeTokenCache()
  const interp = <T,>(node: T): T => interpolateConfigTokens(node, tokenCtx, tokenCache)
  for (const repo of feature.repos ?? []) {
    if (!enabledForEnv(repo.envs, env)) continue
    const dir = resolvePath(repo.localPath)
    const commands = repo.startCommands ?? []
    for (let i = 0; i < commands.length; i++) {
      const normalized = normalizeStartCommand(commands[i], `${repo.name}-cmd-${i + 1}`)
      if (!enabledForEnv(normalized.envs, env)) continue
      const safeName = normalized.name!.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      const probe = resolveHealthProbe(normalized.healthCheck, env)
      out.push({
        name: normalized.name!,
        safeName,
        command: interp(normalized.command),
        cwd: dir,
        healthProbe: probe ? interp(probe) : undefined,
        // Service log path is implied by runDir; consumers can derive via buildRunPaths.
      })
    }
  }
  // Annotate with per-service log paths to keep downstream consumers simple.
  return out.map((s) => ({
    ...s,
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

  constructor(opts: OrchestratorOptions) {
    super()
    this.feature = opts.feature
    this.env = opts.env
    this.runId = opts.runId
    this.runDir = opts.runDir
    this.paths = buildRunPaths(opts.runDir)
    this.services = buildServiceSpecs(opts.feature, opts.runDir, opts.env)
    this.ptyFactory = opts.ptyFactory
    this.healthCheck = opts.healthCheck ?? isHealthy
    this.healthPollIntervalMs = opts.healthPollIntervalMs ?? 1000
    this.healthDeadlineMs = opts.healthDeadlineMs ?? 60_000
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.logsRoot = path.dirname(path.dirname(opts.runDir))
    this.playwrightSpawner = opts.playwrightSpawner ?? defaultPlaywrightSpawner
    this.autoHeal = opts.autoHeal
    this.manualHeal = opts.manualHeal ?? false
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
    await this.ensureServicesRunning()
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
  }

  private async ensureServicesRunning(): Promise<string[]> {
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
    }))
    const manifest: RunManifest = {
      runId: this.runId,
      feature: this.feature.name,
      featureDir: this.feature.featureDir,
      env: this.env,
      startedAt: this.startedAt,
      status: this.status,
      healCycles: this.healCycles,
      services,
      repoPaths: (this.feature.repos ?? [])
        .map((r) => resolvePath(r.localPath))
        .filter((p) => {
          try { return fs.existsSync(p) } catch { return false }
        }),
      repoBranches: this.repoBranchSnapshots,
      playwrightArtifacts: readPlaywrightArtifactPolicy(this.feature.featureDir),
      signalPaths: {
        rerun: this.paths.rerunSignal,
        restart: this.paths.restartSignal,
      },
      healMode: this.autoHeal ? 'auto' : this.manualHeal ? 'manual' : undefined,
      lifecycle: {
        phase: 'starting-services',
        headline: 'Starting services',
        detail: startingServicesDetail(services.length),
        updatedAt: new Date().toISOString(),
      },
      heartbeatAt: new Date().toISOString(),
    }
    this.stateSink.bootstrap(manifest)
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
      env: { LOG_MODE: 'plain' },
    })
    this.servicePtys.set(svc.name, pty)
    this.emit('service-started', { service: svc, pid: pty.pid })

    pty.onData((chunk) => {
      try { fs.appendFileSync(logPath, chunk) } catch { /* ignore */ }
      this.emit('service-output', { service: svc, chunk })
    })
    pty.onExit(({ exitCode, signal }) => {
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
      await this.delay(this.healthPollIntervalMs)
    }
    this.stateSink.setServiceStatus(this.runId, svc.safeName, 'timeout')
    this.emit('health-check', { service: svc, healthy: false, transport })
    const detail = transport === 'http'
      ? `url=${(probe as { http: HttpProbe }).http.url}`
      : `port=${(probe as { tcp: TcpProbe }).tcp.port}`
    this.pendingAbortReason = { reason: 'service-health-failed', service: svc.name }
    this.recordLifecycle('aborted', `Health failed: ${svc.name}`, {
      detail: `Timed out waiting for ${transport.toUpperCase()} readiness (${detail}).`,
      severity: 'error',
      abortReason: this.pendingAbortReason,
    })
    throw new Error(`Health check timed out for ${svc.name} (${transport}, ${detail})`)
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
  async runPlaywright(rerunTargets?: readonly string[]): Promise<number> {
    const inv = this.playwrightSpawner({ feature: this.feature, paths: this.paths, rerunTargets })
    const targetCount = rerunTargets?.length ?? 0
    const targetedRerun = targetCount > 0
      ? {
          selected: targetCount,
          total: targetCount,
          mode: 'failed-and-pending',
          reason: 'The runner selected tests that had not passed yet.',
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
        CANARY_LAB_PROJECT_ROOT: this.feature.featureDir,
        CANARY_LAB_MANIFEST_PATH: this.paths.manifestPath,
        CANARY_LAB_SUMMARY_PATH: this.paths.summaryPath,
        ...(rerunTargets && rerunTargets.length > 0 ? { CANARY_LAB_TARGETED_RERUN: '1' } : {}),
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

  private rerunTargetsForSummary(summary: SummaryShape): string[] | undefined {
    const computed = computeNonPassedTargets(this.feature.featureDir, summary)
    if (computed.kind === 'targeted') {
      const passed = countPassed(summary)
      const failed = Array.isArray(summary.failed) ? summary.failed.length : 0
      const reason = `Rerunning ${computed.locations.length} not-yet-passed tests because ${passed} passed and ${failed} failed before healing.`
      this.runnerLog?.info(`Targeted re-run: ${computed.locations.length} failed/pending of ${computed.total} total tests`)
      this.recordLifecycle('rerunning-tests', 'Targeted rerun selected', {
        detail: reason,
        targetedRerun: {
          selected: computed.locations.length,
          total: computed.total,
          mode: 'failed-and-pending',
          reason,
        },
      })
      return computed.locations
    }
    if (computed.kind === 'no-passed-yet') {
      this.recordLifecycle('rerunning-tests', 'Full rerun selected', {
        detail: 'No tests had passed yet, so a targeted rerun would be equivalent to the full suite.',
        targetedRerun: {
          selected: computed.total,
          total: computed.total,
          mode: 'full-suite',
          reason: 'No tests had passed yet.',
        },
      })
      return undefined
    }
    if (computed.kind === 'all-passed') return undefined
    if (computed.kind === 'extraction-failed') {
      // Fall back to legacy failed-only targeting if we couldn't enumerate the
      // suite (no spec files found, or AST parse blew up everywhere).
      const failedSlugs = extractFailedSlugs(summary)
      if (failedSlugs.length === 0) return undefined
      const locations = extractFailedLocations(summary)
      if (locations.length > 0) return locations
      const msg = 'Post-heal rerun has failed tests without usable file:line locations; running the full Playwright suite.'
      this.runnerLog?.warn(msg)
      this.recordLifecycle('rerunning-tests', 'Full rerun selected', {
        detail: msg,
        severity: 'warning',
        targetedRerun: {
          selected: computedTotal(summary),
          total: computedTotal(summary),
          mode: 'full-suite',
          reason: msg,
        },
      })
      this.emit('playwright-output', { chunk: `\n[warning] ${msg}\n` })
      return undefined
    }
    return undefined
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
    // (`claude … "@<promptFile>"`), so claude reads it at startup with no
    // stdin write. Cycle 2+ needs to re-prompt the alive REPL: write the
    // updated prompt body to the same file (already done above) and tell
    // claude to re-read it via the `@<path>` reference. Single-line input
    // submits cleanly on `\r`; no input-editor multi-line ambiguity.
    if (!isFirstSpawn) {
      try {
        pty.write(`@${this.healPromptFile}\r`)
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

  // Snapshot every git-tracked repo in the feature just before the agent has
  // the floor. The returned map is the input to `diffFeatureRepos`, which
  // computes the list of files the agent actually edited during its turn.
  // Repos that aren't git working trees are silently omitted — the diff for
  // them is empty, which yields a `restart([])` (restart everything) fallback
  // identical to the pre-change behavior when the agent didn't declare files.
  private async snapshotFeatureRepos(): Promise<Map<string, string>> {
    const snapshots = new Map<string, string>()
    for (const repo of this.feature.repos ?? []) {
      const localPath = repo.localPath
      if (typeof localPath !== 'string') continue
      const ref = await snapshotWorkingTree(localPath)
      if (ref !== null) snapshots.set(localPath, ref)
    }
    return snapshots
  }

  // Diff each snapshotted repo and return absolute paths of the files the
  // agent touched between snapshot and now. Used as ground truth for both the
  // journal entry's `fix.file` line and the orchestrator's restart planning.
  private async diffFeatureRepos(snapshots: Map<string, string>): Promise<string[]> {
    const out: string[] = []
    for (const [localPath, ref] of snapshots) {
      const relPaths = await diffNamesSinceSnapshot(localPath, ref)
      const absRepoPath = resolveRepoPath(localPath)
      for (const rel of relPaths) {
        out.push(path.join(absRepoPath, rel))
      }
    }
    return out
  }

  // Full unified-diff content (not just names) for each snapshotted repo,
  // joined into one string. Multi-repo features get a `# repo: <localPath>`
  // header before each repo's diff so the agent (and a human reviewer) can
  // tell which tree each hunk came from. Truncation to MAX_JOURNAL_DIFF_BYTES
  // happens at the journal-writer layer.
  private async diffContentForFeatureRepos(snapshots: Map<string, string>): Promise<string> {
    const blocks: string[] = []
    const multiRepo = snapshots.size > 1
    for (const [localPath, ref] of snapshots) {
      const content = await diffContentSinceSnapshot(localPath, ref)
      if (!content.trim()) continue
      blocks.push(multiRepo ? `# repo: ${localPath}\n${content}` : content)
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

    if (finalStatus === 'passed') return finalStatus

    // Manual heal mode: no agent CLI configured but the user explicitly
    // asked for manual mode. Transition to 'healing' and wait for the user
    // to fix the code by hand and write the signal file. Loops until tests
    // pass, the user cancels, or the signal-poll timeout (24h) is hit.
    // Signal watcher (already running) feeds `signalGate` for
    // `waitForHealSignal` to consume.
    if (!this.autoHeal && this.manualHeal) {
      const MANUAL_TIMEOUT_MS = 24 * 60 * 60 * 1000
      while (true) {
        this.setStatus('healing')
        this.noteHealCycle()
        this.emit('agent-started', { cycle: this.healCycles, command: '<manual>' })
        this.recordLifecycle('agent-healing', `Manual heal cycle ${this.healCycles} started`, {
          detail: 'Waiting for a manual agent or user to write a per-run signal file.',
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
        const rerunTargets = this.rerunTargetsForSummary(readSummary(this.paths.summaryPath))
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
        exitCode = await this.runPlaywright(rerunTargets)
        // Manual-heal mirror of the auto-heal abort guard: the top of the
        // loop already checks `stopped`, but the killed Playwright pty's
        // exit code arrives after the abort flips the flag — don't
        // compute a finalStatus from it.
        if (this.stopped) return this.status
        finalStatus = decideRunStatus(this.feature.featureDir, this.paths.summaryPath, exitCode)
        this.setStatus(finalStatus)
        // Break on clean Playwright exit: if exit was 0 but the summary still
        // shows non-passed tests, finalStatus is already 'failed' above and
        // exiting the loop hands control back to the user (per design).
        if (exitCode === 0) break
      }
      return finalStatus
    }

    if (!this.autoHeal) return finalStatus

    // Same abort guard as above: if the user aborted between Playwright
    // exiting and the heal-loop entry, never spawn a heal agent. Without
    // this, auto-heal would race past stop() and start a fresh heal pty
    // the user has no way to interrupt (the row is already 'aborted').
    if (this.stopped) return this.status

    return await this.runAutoHealLoop()
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
        const signature = failedSlugs.slice().sort().join('|')
        const decision = heal.observeFailures(signature)
        if (!decision.shouldHeal) break

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

        const { signal, reason } = await this.runHealAgent({ cycle: cycleNum, failedSlugs, userGuidance })
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
                signal: '.rerun',
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

        const rerunTargets = this.rerunTargetsForSummary(summary)
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

        const exitCode = await this.runPlaywright(rerunTargets)
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
        // Break on clean Playwright exit even when finalStatus is 'failed'
        // (summary disagrees with exit 0): ends the heal loop and hands
        // control to the user instead of spawning another agent cycle.
        if (exitCode === 0) break
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
    const endedAt = new Date().toISOString()
    this.status = finalStatus
    // Single terminal write — services flipped to 'stopped', status +
    // endedAt + healCycles persisted, runs-index mirrored. The sink is the
    // only writer at this point; no other path can race because
    // `this.stopped = true` already gates `setStatus`.
    this.stateSink.finalize(this.runId, finalStatus, endedAt, this.healCycles)
    this.recordLifecycle(finalLifecyclePhase(finalStatus), finalStatus === 'aborted' ? 'Run aborted' : finalStatus === 'passed' ? 'Run passed' : 'Run failed', {
      severity: finalStatus === 'passed' ? 'success' : finalStatus === 'aborted' ? 'warning' : 'error',
      ...(finalStatus === 'aborted' ? { abortReason: this.pendingAbortReason ?? { reason: 'run-stopped' } } : {}),
    })
    this.emit('run-complete', { status: finalStatus })
  }
}

// ─── Module helpers ─────────────────────────────────────────────────────────

interface SummaryShape {
  failed?: Array<{ name?: unknown; endTime?: unknown; location?: unknown }>
  passed?: unknown
  passedNames?: unknown
  total?: unknown
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

// PASSED only when (a) Playwright exited 0 AND (b) every test the AST can see
// is in summary.passedNames. Skipped/pending/failed all block. Falls back to
// summarizeFailures when AST extraction fails so feature dirs with no parseable
// specs degrade to "no failed entries => passed" instead of always failing.
export function decideRunStatus(
  featureDir: string,
  summaryPath: string,
  exitCode: number,
): 'passed' | 'failed' {
  if (exitCode !== 0) return 'failed'
  const summary = readSummary(summaryPath)
  const computed = computeNonPassedTargets(featureDir, summary)
  if (computed.kind === 'all-passed') return 'passed'
  if (computed.kind === 'extraction-failed') {
    return summarizeFailures(summaryPath).failed.length > 0 ? 'failed' : 'passed'
  }
  return 'failed'
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
export const defaultPlaywrightSpawner: PlaywrightSpawner = ({ feature, paths, rerunTargets }) => {
  const reporter = SUMMARY_REPORTER_PATH
  const threshold = feature.healOnFailureThreshold
  const maxFailures = typeof threshold === 'number' && threshold > 0
    ? ` --max-failures=${threshold}`
    : ''
  const targets = rerunTargets && rerunTargets.length > 0
    ? ` ${rerunTargets.map((target) => JSON.stringify(target)).join(' ')}`
    : ''
  return {
    command: `npx playwright test${targets} --output=${JSON.stringify(paths.playwrightArtifactsDir)} --reporter=${JSON.stringify(reporter)},list${maxFailures}`,
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
