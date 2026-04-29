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
}

export type OrchestratorEventMap = {
  'service-started': { service: ServiceSpec; pid: number }
  'service-output': { service: ServiceSpec; chunk: string }
  'service-exit': { service: ServiceSpec; exitCode: number; signal?: number }
  'health-check': { service: ServiceSpec; healthy: boolean }
  'playwright-output': { chunk: string }
  'playwright-started': { command: string }
  'playwright-exit': { exitCode: number }
  'agent-output': { chunk: string }
  'signal-detected': {
    kind: 'restart' | 'rerun' | 'heal'
    body: Record<string, unknown>
  }
  'run-status': { status: RunManifest['status'] }
  'run-complete': { status: RunManifest['status'] }
}

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
