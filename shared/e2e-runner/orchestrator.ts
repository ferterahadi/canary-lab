import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import type { FeatureConfig } from '../launcher/types'
import {
  isHealthy,
  normalizeStartCommand,
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
} from './manifest'
import type { PtyFactory, PtyHandle } from './pty-spawner'
import { HealCycleState, AUTO_HEAL_MAX_CYCLES } from './heal-cycle'
import { appendJournalIteration } from './log-enrichment'
import {
  resolveMcpOutputDir,
  ensureMcpOutputDir,
  capArtifacts,
} from './playwright-mcp-artifacts'

// Headless event-emitting orchestrator for a single feature run. Wraps the
// existing health-check / signal-file semantics behind a clean API the future
// Fastify server can drive without inheriting any readline / iTerm cruft.

export interface ServiceSpec {
  name: string
  safeName: string
  command: string
  cwd: string
  healthUrl?: string
  healthTimeoutMs?: number
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
  // Polling interval for the heal-cycle signal-wait loop. Defaults to
  // healthPollIntervalMs.
  healSignalPollMs?: number
  // Cap on how long we wait for an agent to write a signal after exit.
  healAgentTimeoutMs?: number
}

export type OrchestratorEventMap = {
  'service-started': { service: ServiceSpec; pid: number }
  'service-output': { service: ServiceSpec; chunk: string }
  'service-exit': { service: ServiceSpec; exitCode: number; signal?: number }
  'health-check': { service: ServiceSpec; healthy: boolean }
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

export function buildServiceSpecs(feature: FeatureConfig, runDir: string): ServiceSpec[] {
  const out: ServiceSpec[] = []
  for (const repo of feature.repos ?? []) {
    const dir = resolvePath(repo.localPath)
    const commands = repo.startCommands ?? []
    for (let i = 0; i < commands.length; i++) {
      const normalized = normalizeStartCommand(commands[i], `${repo.name}-cmd-${i + 1}`)
      const safeName = normalized.name!.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      out.push({
        name: normalized.name!,
        safeName,
        command: normalized.command,
        cwd: dir,
        healthUrl: normalized.healthCheck?.url,
        healthTimeoutMs: normalized.healthCheck?.timeoutMs,
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
  private readonly healSignalPollMs: number
  private readonly healAgentTimeoutMs: number
  private lastDetectedSignal: { kind: 'restart' | 'rerun' | 'heal'; body: Record<string, unknown> } | null = null

  private status: RunManifest['status'] = 'running'
  private healCycles = 0
  private startedAt = ''
  private servicePtys = new Map<string, PtyHandle>()
  private logFiles = new Set<string>()
  private signalWatcher: NodeJS.Timeout | null = null
  private stopped = false

  constructor(opts: OrchestratorOptions) {
    super()
    this.feature = opts.feature
    this.runId = opts.runId
    this.runDir = opts.runDir
    this.paths = buildRunPaths(opts.runDir)
    this.services = buildServiceSpecs(opts.feature, opts.runDir)
    this.ptyFactory = opts.ptyFactory
    this.healthCheck = opts.healthCheck ?? isHealthy
    this.healthPollIntervalMs = opts.healthPollIntervalMs ?? 1000
    this.healthDeadlineMs = opts.healthDeadlineMs ?? 60_000
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.logsRoot = path.dirname(path.dirname(opts.runDir))
    this.playwrightSpawner = opts.playwrightSpawner ?? defaultPlaywrightSpawner
    this.autoHeal = opts.autoHeal
    this.healSignalPollMs = opts.healSignalPollMs ?? this.healthPollIntervalMs
    this.healAgentTimeoutMs = opts.healAgentTimeoutMs ?? 10 * 60 * 1000
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
      healthUrl: s.healthUrl,
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

  private async waitForHealth(): Promise<void> {
    const checks = this.services.filter((s) => s.healthUrl)
    if (checks.length === 0) return
    await Promise.all(
      checks.map(async (svc) => {
        const deadline = Date.now() + this.healthDeadlineMs
        while (Date.now() < deadline) {
          if (this.stopped) return
          const ok = await this.healthCheck(svc.healthUrl!, svc.healthTimeoutMs)
          if (ok) {
            this.emit('health-check', { service: svc, healthy: true })
            return
          }
          await this.delay(this.healthPollIntervalMs)
        }
        this.emit('health-check', { service: svc, healthy: false })
        throw new Error(`Health check timed out for ${svc.name} at ${svc.healthUrl}`)
      }),
    )
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

  // Manually fire a restart — wipes service logs and re-spawns. Used both by
  // the signal watcher (when a `.restart` lands) and by the consumer directly.
  async restart(_filesChanged?: string[]): Promise<void> {
    for (const [name, pty] of this.servicePtys) {
      try { pty.kill('SIGTERM') } catch { /* already dead */ }
      this.servicePtys.delete(name)
    }
    this.logFiles.clear()
    for (const svc of this.services) {
      const p = this.paths.serviceLog(svc.safeName)
      try { fs.writeFileSync(p, '') } catch { /* may not exist yet */ }
    }
    for (const svc of this.services) this.spawnService(svc)
    await this.waitForHealth()
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
    fs.mkdirSync(path.dirname(this.paths.playwrightStdoutPath), { recursive: true })
    fs.writeFileSync(this.paths.playwrightStdoutPath, '')
    pty.onData((chunk) => {
      try { fs.appendFileSync(this.paths.playwrightStdoutPath, chunk) } catch { /* ignore */ }
      this.emit('playwright-output', { chunk })
    })
    return new Promise<number>((resolve) => {
      pty.onExit(({ exitCode }) => {
        this.emit('playwright-exit', { exitCode })
        resolve(exitCode)
      })
    })
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
    pty.onData((chunk) => {
      try { fs.appendFileSync(transcriptPath, chunk) } catch { /* ignore */ }
      this.emit('agent-output', { chunk })
    })

    const exitCode = await new Promise<number>((resolve) => {
      pty.onExit(({ exitCode: code }) => {
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
    this.setStatus(finalStatus)

    if (exitCode === 0 || !this.autoHeal) return finalStatus

    const heal = new HealCycleState({
      maxCycles: this.autoHeal.maxCycles ?? AUTO_HEAL_MAX_CYCLES,
    })

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
        await this.restart()
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
    for (const [name, pty] of this.servicePtys) {
      try { pty.kill('SIGTERM') } catch { /* ignore */ }
      this.servicePtys.delete(name)
    }
    this.logFiles.clear()
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

const SUMMARY_REPORTER_PATH = path.resolve(__dirname, 'summary-reporter.js')

// Production Playwright invocation. Uses `npx playwright test` with our custom
// summary reporter, rooted at the feature dir. Tests inject their own.
export const defaultPlaywrightSpawner: PlaywrightSpawner = ({ feature, paths: _paths }) => {
  const reporter = SUMMARY_REPORTER_PATH
  return {
    command: `npx playwright test --reporter=${JSON.stringify(reporter)},list`,
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
