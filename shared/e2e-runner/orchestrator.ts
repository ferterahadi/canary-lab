import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import type { FeatureConfig, HealthProbe, HttpProbe, TcpProbe } from '../launcher/types'
import {
  enabledForEnv,
  isHealthy,
  isTcpListening,
  normalizeStartCommand,
  resolveHealthProbe,
  resolvePath,
} from '../launcher/startup'
import {
  buildRunPaths,
  type RunPaths,
} from './run-paths'
import {
  setCurrentRunSymlink,
  upsertRunsIndexEntry,
  writeManifest,
  updateManifest,
  type RunManifest,
  type ServiceManifestEntry,
  updateServiceStatus,
  updateAllServicesStatus,
  type StoppedEarlyReason,
} from './manifest'
import type { PtyFactory, PtyHandle } from './pty-spawner'
import { HealCycleState, AUTO_HEAL_MAX_CYCLES } from './heal-cycle'
import { appendJournalIteration } from './log-enrichment'
import type { RunnerLog } from './runner-log'
import {
  resolveMcpOutputDir,
  ensureMcpOutputDir,
  capArtifacts,
} from './playwright-mcp-artifacts'
import { planRestart } from './restart-planner'

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
  // Cap on how long we wait for an agent to write a signal after exit.
  healAgentTimeoutMs?: number
  // Optional runner-log sink. When present, the orchestrator subscribes to its
  // own lifecycle events on construction and tees a human-readable line for
  // each into `runner.log`. Both CLI and web entrypoints provide one.
  runnerLog?: RunnerLog
  // Selected env (e.g. 'local', 'production'). Used to filter
  // repos/startCommands whose `envs` whitelist excludes it — letting a feature
  // skip booting local services when running tests against a remote URL.
  env?: string
}

export type PauseResult =
  | { ok: true; failureCount: number }
  | { ok: false; reason: 'already-healing' | 'no-playwright-running' | 'no-failures-yet' }

export type CancelHealResult =
  | { ok: true }
  | { ok: false; reason: 'not-healing' | 'no-agent-running' }

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
  'agent-started': { cycle: number; command: string }
  'agent-output': { chunk: string }
  'agent-exit': { exitCode: number }
  'heal-cycle-started': { cycle: number; failureSignature: string }
  'signal-detected': {
    kind: 'restart' | 'rerun' | 'heal'
    body: Record<string, unknown>
  }
  'run-status': { status: RunManifest['status'] }
  'run-complete': { status: RunManifest['status'] }
  'paused-by-user': { failureCount: number }
}

export type AutoHealAgent = 'claude' | 'codex'

export interface AutoHealConfig {
  agent: AutoHealAgent
  // 1-based cap on heal cycles. Default = AUTO_HEAL_MAX_CYCLES.
  maxCycles?: number
  // Optional override of the agent command. Production wires
  // `buildAgentCommand` from auto-heal.ts; tests pass a no-op echo.
  buildCommand?: (args: { cycle: number; outputDir: string }) => string
}

export interface PlaywrightInvocation {
  command: string
  cwd: string
}

export type PlaywrightSpawner = (args: {
  feature: FeatureConfig
  paths: RunPaths
}) => PlaywrightInvocation

export function buildServiceSpecs(
  feature: FeatureConfig,
  runDir: string,
  env?: string,
): ServiceSpec[] {
  const out: ServiceSpec[] = []
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
        command: normalized.command,
        cwd: dir,
        healthProbe: probe ?? undefined,
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
  private readonly runnerLog?: RunnerLog
  private lastDetectedSignal: { kind: 'restart' | 'rerun' | 'heal'; body: Record<string, unknown> } | null = null
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
  // Cleared on agent exit.
  private healAgentPty: PtyHandle | null = null
  // Set by cancelHeal() so the heal loop in runFullCycle bails out instead of
  // racing toward another Playwright rerun.
  private healCancelled = false
  private stoppedEarlyReason: StoppedEarlyReason | undefined

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
    this.healAgentTimeoutMs = opts.healAgentTimeoutMs ?? 10 * 60 * 1000
    this.runnerLog = opts.runnerLog
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
    this.startedAt = new Date().toISOString()
    fs.mkdirSync(this.runDir, { recursive: true })
    fs.mkdirSync(this.paths.signalsDir, { recursive: true })

    this.writeInitialManifest()
    this.startSignalWatcher()
    this.startHeartbeat()

    for (const svc of this.services) {
      this.spawnService(svc)
    }
    await this.waitForHealth()
  }

  private writeInitialManifest(): void {
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
      status: 'starting',
    }))
    const manifest: RunManifest = {
      runId: this.runId,
      feature: this.feature.name,
      featureDir: this.feature.featureDir,
      startedAt: this.startedAt,
      status: this.status,
      healCycles: this.healCycles,
      services,
      repoPaths: (this.feature.repos ?? [])
        .map((r) => resolvePath(r.localPath))
        .filter((p) => {
          try { return fs.existsSync(p) } catch { return false }
        }),
      signalPaths: {
        rerun: this.paths.rerunSignal,
        restart: this.paths.restartSignal,
      },
      healMode: this.autoHeal ? 'auto' : this.manualHeal ? 'manual' : undefined,
      heartbeatAt: new Date().toISOString(),
    }
    writeManifest(this.paths.manifestPath, manifest)
    upsertRunsIndexEntry(this.logsRoot, {
      runId: this.runId,
      feature: this.feature.name,
      startedAt: this.startedAt,
      status: this.status,
    })
    setCurrentRunSymlink(this.logsRoot, this.runId)
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
      updateServiceStatus(this.paths.manifestPath, svc.safeName, 'ready')
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
      if (await attempt()) {
        updateServiceStatus(this.paths.manifestPath, svc.safeName, 'ready')
        this.emit('health-check', { service: svc, healthy: true, transport })
        return
      }
      await this.delay(this.healthPollIntervalMs)
    }
    updateServiceStatus(this.paths.manifestPath, svc.safeName, 'timeout')
    this.emit('health-check', { service: svc, healthy: false, transport })
    const detail = transport === 'http'
      ? `url=${(probe as { http: HttpProbe }).http.url}`
      : `port=${(probe as { tcp: TcpProbe }).tcp.port}`
    throw new Error(`Health check timed out for ${svc.name} (${transport}, ${detail})`)
  }

  // Polls the per-run signals dir. The future server (and externally-spawned
  // heal agents) write here; the orchestrator translates them into events the
  // consumer can react to (re-run Playwright, restart services, etc.).
  private startSignalWatcher(): void {
    if (this.signalWatcher) return
    this.signalWatcher = setInterval(() => {
      const tries: Array<{ kind: 'restart' | 'rerun' | 'heal'; file: string }> = [
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
        this.lastDetectedSignal = { kind: t.kind, body }
        this.emit('signal-detected', { kind: t.kind, body })
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
  async restart(filesChanged?: readonly string[]): Promise<{ restarted: string[]; kept: string[] }> {
    const plan = planRestart(filesChanged ?? [], this.services)
    this.emit('restart-planned', {
      toRestart: plan.toRestart,
      toKeep: plan.toKeep,
      noMatch: plan.noMatch,
    })

    if (plan.noMatch) {
      // Non-empty filesChanged but nothing matched: keep all services warm.
      for (const svc of this.services) {
        this.emit('service-restart-skipped', { service: svc, reason: 'no-files-changed-here' })
      }
      return { restarted: [], kept: plan.toKeep }
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
      updateServiceStatus(this.paths.manifestPath, svc.safeName, 'starting')
      this.spawnService(svc)
    }
    if (targets.length > 0) await this.waitForHealth()
    return { restarted: plan.toRestart, kept: plan.toKeep }
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
  async runPlaywright(): Promise<number> {
    const inv = this.playwrightSpawner({ feature: this.feature, paths: this.paths })
    this.emit('playwright-started', { command: inv.command })
    const pty = this.ptyFactory({
      command: inv.command,
      cwd: inv.cwd,
      env: {
        CANARY_LAB_PROJECT_ROOT: this.feature.featureDir,
        CANARY_LAB_SUMMARY_PATH: this.paths.summaryPath,
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
        const waiter = this.playwrightExitWaiter
        this.playwrightExitWaiter = null
        if (waiter) waiter({ exitCode, signal })
        resolve(exitCode)
      })
    })
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
    updateManifest(this.paths.manifestPath, {
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
   * Manually abort an in-flight heal cycle. SIGTERMs the agent pty, sets a
   * cancellation flag so `runFullCycle`'s heal loop bails out instead of
   * spawning another Playwright rerun, and appends a journal entry so the
   * stop is part of the diagnosis history.
   *
   * Returns `409 not-healing` when the run isn't currently in the heal phase
   * and `409 no-agent-running` when status is healing but no agent pty is
   * tracked (e.g. the loop is between cycles).
   */
  async cancelHeal(): Promise<CancelHealResult> {
    if (this.status !== 'healing') return { ok: false, reason: 'not-healing' }
    if (!this.healAgentPty) return { ok: false, reason: 'no-agent-running' }

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
      })
    } catch { /* journal append is best-effort */ }

    try { this.healAgentPty.kill('SIGTERM') } catch { /* already dead */ }
    // Don't wait here — the heal loop's existing `await new Promise<...> pty.onExit`
    // will resolve when the kill lands and the loop checks `healCancelled` to
    // break out.
    return { ok: true }
  }

  /** Live interject — pipe `data` into the running heal agent's stdin so the
   *  user can guide the agent without restarting the cycle. Returns false
   *  when no agent pty is currently in flight (e.g. between cycles or in
   *  manual mode). */
  writeToHealAgent(data: string): boolean {
    if (!this.healAgentPty) return false
    try {
      this.healAgentPty.write(data)
      return true
    } catch {
      return false
    }
  }

  // Block until a signal lands or we time out. Returns `null` on timeout. The
  // signal watcher already records lastDetectedSignal, so we just poll that.
  async waitForHealSignal(timeoutMs: number = this.healAgentTimeoutMs): Promise<
    { kind: 'restart' | 'rerun' | 'heal'; body: Record<string, unknown> } | null
  > {
    const deadline = Date.now() + timeoutMs
    // Always yield to the macrotask queue here — this loop runs concurrently
    // with the signal-watcher setInterval, and a microtask-only delay would
    // starve the timer queue.
    const yieldOnce = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms))
    while (Date.now() < deadline) {
      if (this.stopped) return null
      if (this.lastDetectedSignal) {
        const sig = this.lastDetectedSignal
        this.lastDetectedSignal = null
        return sig
      }
      await yieldOnce(Math.max(1, this.healSignalPollMs))
    }
    return null
  }

  async runHealAgent(args: {
    cycle: number
    failedSlugs: readonly string[]
  }): Promise<{ exitCode: number; signal: { kind: 'restart' | 'rerun' | 'heal'; body: Record<string, unknown> } | null }> {
    const cfg = this.autoHeal
    if (!cfg) throw new Error('autoHeal not configured')

    const target = resolveMcpOutputDir({
      runDir: this.runDir,
      failedSlugs: args.failedSlugs,
    })
    ensureMcpOutputDir(target.dir)

    const command = (cfg.buildCommand ?? defaultHealCommand)({
      cycle: args.cycle,
      outputDir: target.dir,
    })
    this.emit('agent-started', { cycle: args.cycle, command })

    const transcriptPath = this.paths.agentTranscriptPath
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    if (!fs.existsSync(transcriptPath)) fs.writeFileSync(transcriptPath, '')

    const pty = this.ptyFactory({
      command,
      cwd: this.runDir,
      env: { CANARY_LAB_PROJECT_ROOT: this.feature.featureDir },
    })
    this.healAgentPty = pty
    pty.onData((chunk) => {
      try { fs.appendFileSync(transcriptPath, chunk) } catch { /* ignore */ }
      this.emit('agent-output', { chunk })
    })

    const exitCode = await new Promise<number>((resolve) => {
      pty.onExit(({ exitCode: code }) => {
        this.healAgentPty = null
        this.emit('agent-exit', { exitCode: code })
        resolve(code)
      })
    })

    // Apply the artifact cap once the agent exits — the agent has finished
    // writing into the MCP output dir at this point.
    try {
      capArtifacts(target.dir)
    } catch { /* best-effort */ }

    // Give the signal watcher a few ticks to pick up a signal that may have
    // landed right before exit.
    const sig = await this.waitForHealSignal(Math.min(this.healAgentTimeoutMs, 5000))
    return { exitCode, signal: sig }
  }

  // Top-level "do the whole thing" entry. Boots services, runs Playwright,
  // and—if autoHeal is enabled—loops through heal cycles until one of:
  // tests pass, the cap is hit, the agent gives up without signaling, or the
  // failure set stops changing. Updates manifest status throughout.
  async runFullCycle(): Promise<RunManifest['status']> {
    await this.start()
    let exitCode = await this.runPlaywright()
    let finalStatus: RunManifest['status'] = exitCode === 0 ? 'passed' : 'failed'
    // If the user clicked Pause & Heal, Playwright was killed on purpose —
    // a graceful exitCode 0 must NOT mark the run "passed". The
    // `markStoppedEarly('user-pause')` call inside `pauseAndHeal` is what
    // we key off here. We override to 'failed' so the heal-loop entry
    // condition below is satisfied.
    if (this.stoppedEarlyReason === 'user-pause') {
      finalStatus = 'failed'
    }
    this.setStatus(finalStatus)

    if (finalStatus === 'passed') return finalStatus

    // Manual heal mode: no agent CLI configured but the user explicitly
    // asked for manual mode. Transition to 'healing' and wait for the user
    // to fix the code by hand and write the signal file. Loops until tests
    // pass, the user cancels, or the signal-poll timeout (24h) is hit.
    // Signal watcher (already running) populates `lastDetectedSignal` for
    // `waitForHealSignal` to consume.
    if (!this.autoHeal && this.manualHeal) {
      const MANUAL_TIMEOUT_MS = 24 * 60 * 60 * 1000
      while (true) {
        this.setStatus('healing')
        this.noteHealCycle()
        this.emit('agent-started', { cycle: this.healCycles, command: '<manual>' })
        const signal = await this.waitForHealSignal(MANUAL_TIMEOUT_MS)
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
        try {
          if (signal.kind === 'restart' || signal.kind === 'rerun') {
            appendJournalIteration({
              signal: signal.kind === 'restart' ? '.restart' : '.rerun',
              hypothesis: typeof signal.body.hypothesis === 'string' ? signal.body.hypothesis : undefined,
              filesChanged: Array.isArray(signal.body.filesChanged)
                ? (signal.body.filesChanged.filter((f): f is string => typeof f === 'string'))
                : undefined,
              fixDescription: typeof signal.body.fixDescription === 'string' ? signal.body.fixDescription : undefined,
              runId: this.runId,
              manifestPath: this.paths.manifestPath,
              summaryPath: this.paths.summaryPath,
            })
          }
        } catch { /* journal is best-effort */ }
        if (signal.kind === 'restart') {
          const filesChanged = Array.isArray(signal.body.filesChanged)
            ? signal.body.filesChanged.filter((f): f is string => typeof f === 'string')
            : []
          await this.restart(filesChanged)
        } else {
          await this.rerun()
        }
        exitCode = await this.runPlaywright()
        finalStatus = exitCode === 0 ? 'passed' : 'failed'
        this.setStatus(finalStatus)
        if (exitCode === 0) break
      }
      return finalStatus
    }

    if (!this.autoHeal) return finalStatus

    const heal = new HealCycleState({
      maxCycles: this.autoHeal.maxCycles ?? AUTO_HEAL_MAX_CYCLES,
    })

    // If Playwright stopped early because --max-failures fired, persist that
    // before the first heal cycle so the heal-index header carries the note.
    // Skip when pauseAndHeal already stamped 'user-pause' — that's a stronger
    // claim about why the suite was cut short.
    const threshold = this.feature.healOnFailureThreshold ?? 1
    if (!this.stoppedEarlyReason) {
      const { failed: failed0, total: total0 } = summarizeFailures(this.paths.summaryPath)
      if (failed0.length >= threshold) {
        this.markStoppedEarly('max-failures', failed0.length, total0)
      }
    }

    while (true) {
      const summary = readSummary(this.paths.summaryPath)
      const failedSlugs = extractFailedSlugs(summary)
      const signature = failedSlugs.slice().sort().join('|')
      const decision = heal.observeFailures(signature)
      if (!decision.shouldHeal) break

      const cycleNum = heal.beginCycle() + 1
      this.emit('heal-cycle-started', { cycle: cycleNum, failureSignature: signature })
      this.setStatus('healing')
      this.noteHealCycle()

      const { signal } = await this.runHealAgent({ cycle: cycleNum, failedSlugs })

      // User cancelled mid-cycle (cancelHeal()) — terminate the loop without
      // re-running Playwright, regardless of whether a signal landed first.
      if (this.healCancelled) {
        finalStatus = 'failed'
        this.setStatus(finalStatus)
        break
      }

      if (!signal) {
        finalStatus = 'failed'
        this.setStatus(finalStatus)
        break
      }

      // Append a journal entry from the signal body so the next iteration's
      // heal agent has cumulative context.
      try {
        if (signal.kind === 'restart' || signal.kind === 'rerun') {
          appendJournalIteration({
            signal: signal.kind === 'restart' ? '.restart' : '.rerun',
            hypothesis: typeof signal.body.hypothesis === 'string' ? signal.body.hypothesis : undefined,
            filesChanged: Array.isArray(signal.body.filesChanged)
              ? (signal.body.filesChanged.filter((f): f is string => typeof f === 'string'))
              : undefined,
            fixDescription: typeof signal.body.fixDescription === 'string' ? signal.body.fixDescription : undefined,
            runId: this.runId,
            manifestPath: this.paths.manifestPath,
            summaryPath: this.paths.summaryPath,
          })
        }
      } catch { /* journal write is best-effort */ }

      const action = heal.actionForSignal(signal.kind === 'heal' ? 'rerun' : signal.kind)
      // actionForSignal can only return restart-and-rerun or rerun-only here;
      // the give-up case is reached via `actionForNoSignal` (handled above
      // when `signal` is null).
      if (action.kind === 'restart-and-rerun') {
        const filesChanged = Array.isArray(signal.body.filesChanged)
          ? signal.body.filesChanged.filter((f): f is string => typeof f === 'string')
          : []
        const { restarted, kept } = await this.restart(filesChanged)
        this.healCycleHistory.push({ cycle: cycleNum, restarted, kept })
        updateManifest(this.paths.manifestPath, {
          healCycleHistory: this.healCycleHistory,
        })
      } else {
        await this.rerun()
      }

      exitCode = await this.runPlaywright()
      finalStatus = exitCode === 0 ? 'passed' : 'failed'
      this.setStatus(finalStatus)
      if (exitCode === 0) break
    }

    return finalStatus
  }

  /** Write a heartbeat timestamp to the manifest every 5 seconds so consumers
   *  can detect orphaned runs whose orchestrator crashed without cleaning up. */
  private startHeartbeat(): void {
    const tick = (): void => {
      if (this.stopped) return
      updateManifest(this.paths.manifestPath, { heartbeatAt: new Date().toISOString() })
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
    this.status = status
    this.emit('run-status', { status })
    updateManifest(this.paths.manifestPath, { status, healCycles: this.healCycles })
    upsertRunsIndexEntry(this.logsRoot, {
      runId: this.runId,
      feature: this.feature.name,
      startedAt: this.startedAt,
      status,
    })
  }

  noteHealCycle(): void {
    this.healCycles += 1
    updateManifest(this.paths.manifestPath, { healCycles: this.healCycles })
  }

  async stop(finalStatus: RunManifest['status'] = 'aborted'): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.signalWatcher) {
      clearInterval(this.signalWatcher)
      this.signalWatcher = null
    }
    this.stopHeartbeat()
    for (const [name, pty] of this.servicePtys) {
      try { pty.kill('SIGTERM') } catch { /* ignore */ }
      this.servicePtys.delete(name)
    }
    this.logFiles.clear()
    updateAllServicesStatus(this.paths.manifestPath, 'stopped')
    const endedAt = new Date().toISOString()
    this.status = finalStatus
    updateManifest(this.paths.manifestPath, {
      status: finalStatus,
      endedAt,
      healCycles: this.healCycles,
    })
    upsertRunsIndexEntry(this.logsRoot, {
      runId: this.runId,
      feature: this.feature.name,
      startedAt: this.startedAt,
      status: finalStatus,
      endedAt,
    })
    this.emit('run-complete', { status: finalStatus })
  }
}

// ─── Module helpers ─────────────────────────────────────────────────────────

interface SummaryShape {
  failed?: Array<{ name?: unknown; endTime?: unknown }>
  passed?: unknown
  total?: unknown
}

export function countPassed(summary: SummaryShape): number {
  return typeof summary.passed === 'number' ? summary.passed : 0
}

// Read just the `stoppedEarly.reason` field from a manifest on disk. Returns
// undefined if the manifest is missing, unparseable, or doesn't carry the
// field. Used by the heal loop to avoid clobbering an explicit 'user-pause'
// stamp with the default 'max-failures' attribution.
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

export function extractFailedSlugs(summary: SummaryShape): string[] {
  const failed = Array.isArray(summary.failed) ? summary.failed : []
  return failed
    .map((f) => (typeof f?.name === 'string' ? (f.name as string) : ''))
    .filter((n) => n.length > 0)
}

export function summarizeFailures(summaryPath: string): { failed: string[]; total: number } {
  const summary = readSummary(summaryPath)
  const failed = extractFailedSlugs(summary)
  const total = typeof summary.total === 'number' ? summary.total : failed.length
  return { failed, total }
}

const SUMMARY_REPORTER_PATH = path.resolve(__dirname, 'summary-reporter.js')

// Production Playwright invocation. Uses `npx playwright test` with our custom
// summary reporter, rooted at the feature dir. Tests inject their own.
export const defaultPlaywrightSpawner: PlaywrightSpawner = ({ feature, paths: _paths }) => {
  const reporter = SUMMARY_REPORTER_PATH
  const threshold = feature.healOnFailureThreshold ?? 1
  return {
    command: `npx playwright test --reporter=${JSON.stringify(reporter)},list --max-failures=${threshold}`,
    cwd: feature.featureDir,
  }
}

// Production heal-agent command builder. The web-server / CLI entry points
// pass a richer one that wires `buildAgentCommand` from auto-heal.ts; this
// default is intentionally minimal so it never silently runs in tests.
export function defaultHealCommand(args: { cycle: number; outputDir: string }): string {
  // Clamp to a no-op if no override is provided. The real wiring lives in
  // auto-heal.ts and is composed at the call site (CLI / web-server).
  return `echo "[heal-agent placeholder cycle=${args.cycle} mcp-out=${args.outputDir}]"`
}
