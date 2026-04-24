import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { execFileSync, spawn } from 'child_process'
import {
  banner,
  section,
  step,
  bullet,
  ok,
  fail,
  warn,
  info,
  line as uiLine,
  dim,
  muted,
  path as ansiPath,
  summaryBox,
  c as ansiC,
} from '../cli-ui/ui'
import type { FeatureConfig } from '../launcher/types'
import { checkUpgradeDrift, formatDriftNotice } from '../runtime/upgrade-check'
import {
  isHealthy,
  normalizeStartCommand,
  resolvePath,
} from '../launcher/startup'
import {
  openItermTabs,
  reuseItermTabs,
  closeItermSessionsByPrefix,
  closeItermSessionsByIds,
} from '../launcher/iterm'
import {
  openTerminalTabs,
  closeTerminalTabsByPrefix,
} from '../launcher/terminal'
import {
  ROOT,
  FEATURES_DIR,
  LOGS_DIR,
  PIDS_DIR,
  MANIFEST_PATH,
  PLAYWRIGHT_STDOUT_PATH,
  getSummaryPath,
  RERUN_SIGNAL,
  RESTART_SIGNAL,
  HEAL_SIGNAL,
  SIGNAL_HISTORY_PATH,
  ITERM_SESSION_IDS_PATH,
  ITERM_HEAL_SESSION_IDS_PATH,
} from './paths'
import {
  spawnHealAgent,
  isAgentCliAvailable,
  failureSignature,
  closeLastHealAgentTab,
  buildStartupFailurePrompt,
  type HealAgent,
  type HealSessionMode,
  type HealResult,
} from './auto-heal'
import {
  createBenchmarkTracker,
  finalizeBenchmarkCycle,
  finalizeBenchmarkRun,
  noteBenchmarkSignal,
  startBenchmarkCycle,
  type BenchmarkTracker,
} from './benchmark'
import {
  buildBenchmarkContextSnapshot,
  type BenchmarkMode,
} from './context-assembler'

export function safeReadFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

type TerminalChoice = 'iTerm' | 'Terminal'

interface AutoHealConfig {
  agent: HealAgent | null
  sessionMode: HealSessionMode
}

interface BenchmarkConfig {
  enabled: boolean
  mode: BenchmarkMode
}

export const AUTO_HEAL_MAX_CYCLES = 3

// ─── Paths (local to runner) ────────────────────────────────────────────────
const SWITCH_SCRIPT = path.join(__dirname, '../env-switcher/switch.js')
const SUMMARY_REPORTER = path.resolve(__dirname, 'summary-reporter.js')

// ─── Readline helpers (same pattern as shared/launcher/index.ts) ────────────
export function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

export async function selectOption(
  rl: readline.Interface,
  label: string,
  options: string[],
): Promise<string> {
  section(label)
  options.forEach((opt, i) => console.log(`  ${ansiC('gray', `${i + 1})`)} ${opt}`))
  while (true) {
    const answer = await prompt(rl, `${ansiC('cyan', '›')} Select [1-${options.length}]: `)
    const idx = parseInt(answer.trim(), 10) - 1
    if (idx >= 0 && idx < options.length) return options[idx]
    warn(`Please enter a number between 1 and ${options.length}`)
  }
}

// ─── Feature discovery (same as shared/launcher/index.ts) ───────────────────
export function discoverFeatures(): FeatureConfig[] {
  const features: FeatureConfig[] = []
  const dirs = fs
    .readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const dir of dirs) {
    const configPath = ['feature.config.cjs', 'feature.config.js', 'feature.config.ts']
      .map((name) => path.join(FEATURES_DIR, dir, name))
      .find((candidate) => fs.existsSync(candidate))

    if (!configPath) continue

    try {
      const mod = require(configPath)
      features.push(mod.config ?? mod.default)
    } catch {
      // skip malformed configs
    }
  }
  return features
}

// ─── Repo check (same as shared/launcher/index.ts) ─────────────────────────
export function checkRepos(feature: FeatureConfig): boolean {
  if (!feature.repos?.length) return true
  let allOk = true
  for (const repo of feature.repos) {
    const resolved = resolvePath(repo.localPath)
    if (!fs.existsSync(resolved)) {
      uiLine()
      fail(`Missing repo: ${repo.name}`)
      console.error(`  ${dim('expected at:')} ${resolved}`)
      if (repo.cloneUrl) {
        console.error(`  ${dim('clone it with:')}`)
        console.error(`    git clone ${repo.cloneUrl} ${resolved}`)
      }
      allOk = false
    }
  }
  return allOk
}

// ─── Service management ─────────────────────────────────────────────────────

interface ServiceInfo {
  name: string
  safeName: string
  logPath: string
  command: string
  cwd: string
  healthUrl?: string
  healthTimeout?: number
}

export function buildServiceList(feature: FeatureConfig): ServiceInfo[] {
  const services: ServiceInfo[] = []

  for (const repo of feature.repos ?? []) {
    const dir = resolvePath(repo.localPath)
    const commands = repo.startCommands ?? []

    for (let i = 0; i < commands.length; i++) {
      const normalized = normalizeStartCommand(
        commands[i],
        `${repo.name}-cmd-${i + 1}`,
      )
      const safeName = normalized
        .name!.replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()
      const logPath = path.join(LOGS_DIR, `svc-${safeName}.log`)

      services.push({
        name: normalized.name!,
        safeName,
        logPath,
        command: normalized.command,
        cwd: dir,
        healthUrl: normalized.healthCheck?.url,
        healthTimeout: normalized.healthCheck?.timeoutMs,
      })
    }
  }

  return services
}

export function buildTeedCommand(
  svc: ServiceInfo,
  benchmarkMode: BenchmarkMode = 'canary',
): string {
  // LOG_MODE=plain tells apps to use synchronous console.log instead of async
  // loggers (e.g. Pino/sonic-boom), so XML markers land in the right position.
  // Canary: stdout+stderr go to both the iTerm tab and the log file via tee.
  // Baseline: no tee — nothing hits disk, so the heal agent can't be tempted
  // (or accidentally pointed) at canary-lab-specific service logs.
  if (benchmarkMode === 'baseline') {
    return `LOG_MODE=plain ${svc.command} 2>&1`
  }
  return `LOG_MODE=plain ${svc.command} 2>&1 | tee -a ${svc.logPath}`
}

// Wipe each service's log file so the next iteration starts clean. Called
// before every run signal (.restart and .rerun) so both behave identically —
// the file contains only the current iteration's output.
export function truncateServiceLogs(
  services: ServiceInfo[],
  benchmarkMode: BenchmarkMode = 'canary',
): void {
  if (benchmarkMode === 'baseline') return
  for (const svc of services) {
    try {
      fs.writeFileSync(svc.logPath, '')
    } catch { /* log file may not exist yet on first run; tee will create it */ }
  }
}

// Tracks iTerm session IDs for launched service tabs so restarts can close
// them precisely (zsh auto-title overwrites `name of s`, so name-prefix
// matching is unreliable across restarts). Persisted to disk so a fresh
// runner process can still close tabs from a prior process.
export const itermSessionIds = loadSessionIds(ITERM_SESSION_IDS_PATH)

export function loadSessionIds(file: string): Map<string, string> {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const obj = JSON.parse(raw) as Record<string, string>
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

export function saveSessionIds(file: string, ids: Map<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(ids), null, 2))
  } catch {
    /* non-fatal — persistence is best-effort */
  }
}

export function openTabs(
  terminal: TerminalChoice,
  tabs: Array<{ dir: string; command: string; name: string }>,
  label: string,
): void {
  if (terminal === 'iTerm') {
    // Try reuse first — if we already have tabs with matching names, send
    // Ctrl-C + new command into them instead of closing + reopening. This
    // preserves scrollback and avoids the close race where a tab's shell
    // outlives the close and the next run spawns a second tab next to it.
    const reuseIds = tabs.map((t) => itermSessionIds.get(t.name) ?? '')
    const allMatched = reuseIds.every((id) => id.length > 0)
    if (allMatched && reuseItermTabs(reuseIds, tabs, label)) {
      return // IDs unchanged; on-disk cache stays valid.
    }

    // Fallback — close previously-tracked sessions (by ID — always accurate),
    // then fall back to prefix-matching for untracked legacy tabs, and open
    // a fresh window.
    const knownIds = Array.from(itermSessionIds.values())
    if (knownIds.length > 0) closeItermSessionsByIds(knownIds)
    itermSessionIds.clear()
    closeItermSessionsByPrefix(tabs.map((t) => t.name))

    const newIds = openItermTabs(tabs, label)
    tabs.forEach((tab, i) => {
      if (newIds[i]) itermSessionIds.set(tab.name, newIds[i])
    })
    saveSessionIds(ITERM_SESSION_IDS_PATH, itermSessionIds)
  } else {
    closeTerminalTabsByPrefix(tabs.map((t) => t.name))
    openTerminalTabs(tabs, label)
  }
}

export async function launchServices(
  services: ServiceInfo[],
  terminal: TerminalChoice,
  benchmarkMode: BenchmarkMode = 'canary',
): Promise<void> {
  // Always kill existing processes so we own the tee pipe and capture all logs.
  // Without this, externally-started services have no log file and XML markers
  // cannot be extracted.
  for (const svc of services) {
    const pid = resolveRunningPid(svc)
    if (pid) {
      process.stdout.write(`  ${ansiC('gray', '›')} Stopping existing ${svc.name} ${dim(`(PID ${pid})`)}... `)
      await killProcess(pid)
      console.log(ansiC('green', 'stopped'))
    }
  }

  truncateServiceLogs(services, benchmarkMode)

  const tabs: Array<{ dir: string; command: string; name: string }> = services.map((svc) => ({
    dir: svc.cwd,
    command: buildTeedCommand(svc, benchmarkMode),
    name: svc.name,
  }))

  if (tabs.length === 0) {
    return
  }

  uiLine()
  info(`Opening ${terminal} tabs for ${tabs.length} service(s)...`)
  openTabs(terminal, tabs, '')
}

// Thrown by pollHealthChecks when a service's initial health check exceeds
// the deadline. Typed so callers can distinguish startup failures from other
// runtime errors and offer the user recovery options instead of tearing
// everything down.
export class HealthCheckTimeoutError extends Error {
  readonly serviceName: string
  readonly healthUrl: string

  constructor(serviceName: string, healthUrl: string) {
    super(`Health check timed out for ${serviceName} at ${healthUrl}`)
    this.name = 'HealthCheckTimeoutError'
    this.serviceName = serviceName
    this.healthUrl = healthUrl
  }
}

export async function pollHealthChecks(
  services: ServiceInfo[],
  timeoutMs = 120_000,
): Promise<void> {
  const checksNeeded = services.filter((s) => s.healthUrl)
  if (checksNeeded.length === 0) return

  uiLine()
  info('Waiting for health checks...')
  const deadline = Date.now() + timeoutMs

  for (const svc of checksNeeded) {
    process.stdout.write(`    ${ansiC('gray', '•')} ${svc.name} ${dim('…')} `)
    while (Date.now() < deadline) {
      if (await isHealthy(svc.healthUrl!, svc.healthTimeout)) {
        console.log(ansiC('green', 'healthy'))
        break
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    if (Date.now() >= deadline) {
      console.log(ansiC('red', 'TIMEOUT'))
      throw new HealthCheckTimeoutError(svc.name, svc.healthUrl!)
    }
  }
}

// ─── Startup-failure recovery ──────────────────────────────────────────────

const STARTUP_HEAL_MAX_CYCLES = 3
const STARTUP_SIGNAL_POLL_INTERVAL_MS = 1000
const STARTUP_MANUAL_TIMEOUT_MS = 30 * 60 * 1000 // 30 min cap for manual self-heal

export type StartupRecoveryChoice = 'stop' | 'manual' | 'claude' | 'codex'

async function waitForRestartOrRerunSignal(
  timeoutMs = STARTUP_MANUAL_TIMEOUT_MS,
): Promise<'signal' | 'timeout'> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STARTUP_SIGNAL_POLL_INTERVAL_MS))
    if (fs.existsSync(RESTART_SIGNAL) || fs.existsSync(RERUN_SIGNAL)) {
      return 'signal'
    }
  }
  return 'timeout'
}

function consumeSignalAndReadFilesChanged(): unknown {
  const signalPath = fs.existsSync(RESTART_SIGNAL)
    ? RESTART_SIGNAL
    : fs.existsSync(RERUN_SIGNAL)
      ? RERUN_SIGNAL
      : null
  let filesChanged: unknown = undefined
  if (signalPath) {
    try {
      const raw = fs.readFileSync(signalPath, 'utf-8').trim()
      if (raw) {
        const parsed = JSON.parse(raw) as { filesChanged?: unknown }
        filesChanged = parsed.filesChanged
      }
    } catch { /* empty / non-JSON is fine */ }
  }
  try { fs.unlinkSync(RESTART_SIGNAL) } catch { /* ignore */ }
  try { fs.unlinkSync(RERUN_SIGNAL) } catch { /* ignore */ }
  return filesChanged
}

export interface HandleHealthCheckFailureOptions {
  rl: readline.Interface
  failingServiceName: string
  services: ServiceInfo[]
  feature: FeatureConfig
  terminal: TerminalChoice
  benchmarkMode: BenchmarkMode
  healSession: HealSessionMode
  // Injection points for tests.
  spawnAgent?: typeof spawnHealAgent
  agentCliAvailable?: (agent: HealAgent) => boolean
  selectChoice?: (
    rl: readline.Interface,
    label: string,
    options: string[],
  ) => Promise<string>
  waitForSignal?: (timeoutMs?: number) => Promise<'signal' | 'timeout'>
  restartSelected?: (services: ServiceInfo[]) => Promise<void>
  restartAll?: (services: ServiceInfo[]) => Promise<void>
}

/**
 * Prompt the user when a service fails its initial health check. Returns
 * `true` if the user recovered (services are healthy and the caller should
 * proceed to Playwright), `false` if the user chose to stop (caller should
 * re-throw so the outer catch runs cleanup).
 *
 * Mirrors the existing "Auto-heal on test failure?" UX, but for startup.
 */
export async function handleHealthCheckFailure(
  opts: HandleHealthCheckFailureOptions,
): Promise<boolean> {
  const spawn = opts.spawnAgent ?? spawnHealAgent
  const cliAvailable = opts.agentCliAvailable ?? isAgentCliAvailable
  const select = opts.selectChoice ?? selectOption
  const wait = opts.waitForSignal ?? waitForRestartOrRerunSignal
  const restartSelectedFn =
    opts.restartSelected ??
    ((svcs: ServiceInfo[]) => restartServices(svcs, opts.terminal, opts.benchmarkMode))
  const restartAllFn =
    opts.restartAll ??
    ((svcs: ServiceInfo[]) => restartAllServices(svcs, opts.terminal, opts.benchmarkMode))

  let failingName = opts.failingServiceName

  while (true) {
    const failing = opts.services.find((s) => s.name === failingName)
    if (!failing) {
      // Shouldn't happen — service disappeared from the list. Escalate.
      return false
    }

    uiLine()
    warn(`Service \`${failing.name}\` failed its startup health check at ${failing.healthUrl}`)
    bullet(`service log: ${ansiPath(failing.logPath)}`)
    bullet(`repo: ${ansiPath(failing.cwd)}`)

    const claudeAvailable = cliAvailable('claude')
    const codexAvailable = cliAvailable('codex')

    const optionDefs: Array<{ label: string; choice: StartupRecoveryChoice }> = [
      { label: 'Stop services and exit (default)', choice: 'stop' },
      { label: 'Keep services running — self heal manually', choice: 'manual' },
    ]
    if (claudeAvailable) {
      optionDefs.push({
        label: 'Keep services running — Claude Code auto-heal',
        choice: 'claude',
      })
    }
    if (codexAvailable) {
      optionDefs.push({
        label: 'Keep services running — Codex auto-heal',
        choice: 'codex',
      })
    }

    const picked = await select(
      opts.rl,
      'Service failed to start. What now?',
      optionDefs.map((o) => o.label),
    )
    const choice = optionDefs.find((o) => o.label === picked)?.choice ?? 'stop'

    if (choice === 'stop') return false

    // Recovery loop.
    for (let cycle = 0; cycle < STARTUP_HEAL_MAX_CYCLES; cycle++) {
      if (choice === 'claude' || choice === 'codex') {
        const prompt = buildStartupFailurePrompt({
          serviceName: failing.name,
          healthUrl: failing.healthUrl!,
          logPath: failing.logPath,
          repoPath: failing.cwd,
          restartSignalPath: RESTART_SIGNAL,
        })
        const result = await spawn({
          agent: choice,
          sessionMode: cycle === 0 ? 'new' : opts.healSession,
          cycle,
          terminal: opts.terminal,
          benchmarkMode: opts.benchmarkMode,
          basePromptOverride: prompt,
        })
        if (result !== 'signal') {
          uiLine()
          warn(
            `Auto-heal agent exited without writing ${ansiPath('logs/.restart')} — cycle ${cycle + 1} of ${STARTUP_HEAL_MAX_CYCLES}`,
          )
          continue
        }
      } else {
        // Manual self-heal.
        uiLine()
        info('Services are still running. In another terminal, run `claude` or `codex` in this project')
        info(`and send the prompt ${ansiC('cyan', '`self heal`')}, or fix the code yourself and:`)
        bullet(`${ansiC('cyan', 'touch logs/.restart')} ${dim('— with a JSON body listing filesChanged to restart only the affected service(s)')}`)
        bullet(`${ansiC('cyan', 'touch logs/.rerun')}   ${dim('— just re-poll health without restarting')}`)
        uiLine()
        info(`Waiting for ${ansiPath('logs/.restart')} or ${ansiPath('logs/.rerun')}…`)
        const waitResult = await wait()
        if (waitResult === 'timeout') {
          uiLine()
          warn('Timed out waiting for a heal signal.')
          // Fall through to the outer prompt.
          break
        }
      }

      // Signal detected (or manual .rerun/.restart appeared). Consume + act.
      const filesChanged = consumeSignalAndReadFilesChanged()
      try {
        const selected = selectServicesToRestart(opts.services, filesChanged)
        if (selected === null) {
          await restartAllFn(opts.services)
        } else {
          uiLine()
          info(`Selective restart: ${selected.map((s) => s.name).join(', ')}`)
          await restartSelectedFn(selected)
        }
        // restartServices re-polls health at the end — if we got here, healthy.
        return true
      } catch (err) {
        if (err instanceof HealthCheckTimeoutError) {
          failingName = err.serviceName
          continue // next cycle within the same choice
        }
        throw err
      }
    }

    // Exhausted 3 cycles (or manual wait timed out). Re-prompt so the user
    // can escalate to a different agent, keep trying manually, or stop.
    uiLine()
    warn(`Startup heal exhausted after ${STARTUP_HEAL_MAX_CYCLES} cycle(s).`)
  }
}

export function writeManifest(
  services: ServiceInfo[],
  feature?: FeatureConfig,
): void {
  const manifest: {
    serviceLogs: string[]
    featureName?: string
    featureDir?: string
    repoPaths?: string[]
  } = { serviceLogs: services.map((s) => s.logPath) }
  if (feature) {
    manifest.featureName = feature.name
    manifest.featureDir = feature.featureDir
    manifest.repoPaths = (feature.repos ?? [])
      .map((r) => resolvePath(r.localPath))
      .filter((p) => fs.existsSync(p))
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
}

// ─── Restart unhealthy services ─────────────────────────────────────────────
export function readPid(safeName: string): number | null {
  const pidPath = path.join(PIDS_DIR, `${safeName}.pid`)
  if (!fs.existsSync(pidPath)) return null
  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
  return isNaN(pid) ? null : pid
}

export function portFromHealthUrl(url: string): number | null {
  try {
    const parsed = new URL(url)
    if (parsed.port) {
      return parseInt(parsed.port, 10)
    }
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

export function lookupPidByPort(port: number): number | null {
  try {
    const output = execFileSync(
      'lsof',
      ['-ti', `tcp:${port}`, '-sTCP:LISTEN'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()
    const pid = parseInt(output.split('\n')[0]?.trim() ?? '', 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function killProcessSync(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  // Best-effort sync kill for signal handlers — send SIGKILL after SIGTERM
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // ignore
  }
}

export async function killProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  // Wait up to 5s for graceful shutdown
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 200))
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }
}

export function resolveRunningPid(svc: ServiceInfo): number | null {
  const pidFromFile = readPid(svc.safeName)
  if (pidFromFile && isProcessAlive(pidFromFile)) {
    return pidFromFile
  }

  if (!svc.healthUrl) {
    return null
  }

  const port = portFromHealthUrl(svc.healthUrl)
  if (!port) {
    return null
  }

  const pidFromPort = lookupPidByPort(port)
  if (pidFromPort && isProcessAlive(pidFromPort)) {
    return pidFromPort
  }

  return null
}

// Returns null when we should fall back to restarting all services
// (missing filesChanged, or any path doesn't map to a known repo).
export function selectServicesToRestart(
  services: ServiceInfo[],
  filesChanged: unknown,
): ServiceInfo[] | null {
  if (!Array.isArray(filesChanged) || filesChanged.length === 0) return null

  // Longest-prefix first so nested repos match their deeper path.
  const repoDirs = Array.from(new Set(services.map((s) => s.cwd)))
    .sort((a, b) => b.length - a.length)

  const matchedDirs = new Set<string>()
  for (const raw of filesChanged) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const abs = path.resolve(ROOT, resolvePath(raw))
    const match = repoDirs.find(
      (dir) => abs === dir || abs.startsWith(dir + path.sep),
    )
    if (!match) {
      warn(
        `filesChanged path did not match any repo — falling back to restart all: ${raw}`,
      )
      return null
    }
    matchedDirs.add(match)
  }

  if (matchedDirs.size === 0) return null
  return services.filter((s) => matchedDirs.has(s.cwd))
}

export async function restartServices(
  services: ServiceInfo[],
  terminal: TerminalChoice,
  benchmarkMode: BenchmarkMode = 'canary',
): Promise<void> {
  uiLine()
  info(`Restarting ${services.length} service(s)...`)

  // Kill running services first
  for (const svc of services) {
    process.stdout.write(`    ${ansiC('gray', '•')} ${svc.name} ${dim('…')} `)
    const pid = resolveRunningPid(svc)
    if (pid) {
      process.stdout.write(`${dim(`stopping PID ${pid}`)} `)
      await killProcess(pid)
      console.log(ansiC('green', 'stopped'))
    } else {
      console.log(dim('no existing process'))
    }
  }

  truncateServiceLogs(services, benchmarkMode)

  // Re-launch in terminal tabs with tee
  const tabs = services.map((svc) => ({
    dir: svc.cwd,
    command: buildTeedCommand(svc, benchmarkMode),
    name: svc.name,
  }))
  uiLine()
  info(`Re-opening ${terminal} tabs for ${tabs.length} service(s)...`)
  openTabs(terminal, tabs, '')

  await pollHealthChecks(services)
}

export async function restartAllServices(
  services: ServiceInfo[],
  terminal: TerminalChoice,
  benchmarkMode: BenchmarkMode = 'canary',
): Promise<void> {
  return restartServices(services, terminal, benchmarkMode)
}

// ─── Playwright ─────────────────────────────────────────────────────────────
const RUN_TIMEOUT = 10 * 60 * 1000 // 10 minutes — safety net for hung runs

export function runPlaywright(
  featureDir: string,
  headed: boolean,
  benchmarkMode: BenchmarkMode = 'canary',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const playwrightArgs = [
      'playwright',
      'test',
      `--reporter=${SUMMARY_REPORTER},list`,
      ...(headed ? ['--headed'] : []),
    ]

    // Baseline: capture stdout+stderr to logs/playwright-stdout.log so the
    // vanilla heal agent has exactly one file to read — the raw Playwright
    // output a developer would see in their terminal. Still forward to the
    // parent process so the user sees progress live.
    const captureStdout = benchmarkMode === 'baseline'
    let stdoutFile: fs.WriteStream | null = null
    if (captureStdout) {
      fs.mkdirSync(path.dirname(PLAYWRIGHT_STDOUT_PATH), { recursive: true })
      stdoutFile = fs.createWriteStream(PLAYWRIGHT_STDOUT_PATH, { flags: 'w' })
    }

    const child = spawn('npx', playwrightArgs, {
      cwd: featureDir,
      env: {
        ...process.env,
        CANARY_LAB_PROJECT_ROOT: ROOT,
        CANARY_LAB_BENCHMARK_MODE: benchmarkMode,
      },
      stdio: captureStdout ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    })

    if (captureStdout && stdoutFile && child.stdout && child.stderr) {
      child.stdout.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk)
        stdoutFile!.write(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk)
        stdoutFile!.write(chunk)
      })
    }

    const timer = setTimeout(() => {
      uiLine()
      warn('Playwright run timed out after 10 minutes, killing...')
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already dead
        }
      }, 5000)
    }, RUN_TIMEOUT)

    const forwardSigInt = () => child.kill('SIGINT')
    const forwardSigTerm = () => child.kill('SIGTERM')
    process.on('SIGINT', forwardSigInt)
    process.on('SIGTERM', forwardSigTerm)

    const closeStdoutFile = (): Promise<void> =>
      new Promise((res) => {
        if (!stdoutFile) return res()
        stdoutFile.end(() => res())
      })

    child.on('error', (err) => {
      clearTimeout(timer)
      process.off('SIGINT', forwardSigInt)
      process.off('SIGTERM', forwardSigTerm)
      closeStdoutFile().then(() => reject(err))
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      process.off('SIGINT', forwardSigInt)
      process.off('SIGTERM', forwardSigTerm)
      closeStdoutFile().then(() => resolve(code ?? 1))
    })
  })
}

// ─── Summary ────────────────────────────────────────────────────────────────
export function printSummary(): void {
  const summaryPath = getSummaryPath()
  if (!fs.existsSync(summaryPath)) {
    uiLine()
    warn('No summary file found.')
    return
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
  const failedCount = summary.failed.length
  const extras = failedCount > 0
    ? [
        '',
        ansiC('red', 'Failures:'),
        ...summary.failed.map((entry: unknown) => {
          const name = typeof entry === 'string' ? entry : (entry as { name: string }).name
          return `  ${ansiC('red', '✗')} ${name}`
        }),
      ]
    : []
  summaryBox(
    'E2E Summary',
    [
      { label: 'Total', value: summary.total },
      { label: 'Passed', value: summary.passed, tone: 'good' },
      { label: 'Failed', value: failedCount, tone: failedCount > 0 ? 'bad' : 'default' },
    ],
    extras,
  )
  uiLine()
}

// ─── Watch mode ─────────────────────────────────────────────────────────────
export function readFailureSignature(): string {
  const summaryPath = getSummaryPath()
  if (!fs.existsSync(summaryPath)) return ''
  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
    return failureSignature(summary.failed)
  } catch {
    return ''
  }
}

export interface HealCycleState {
  spawnCount: number
  strikeCount: number
  lastSignature: string
  disabled: boolean
}

export function printManualOptions(autoHealConfigured: boolean): void {
  section('Options')
  bullet(`fix the code yourself, then ${ansiC('cyan', '`touch logs/.rerun`')}`)
  if (autoHealConfigured) {
    bullet(`${ansiC('cyan', '`touch logs/.heal`')} to reset strikes and spawn the headless agent again`)
  }
  bullet(`open ${ansiC('cyan', '`claude`')} or ${ansiC('cyan', '`codex`')} in ${ansiPath(ROOT)} and send the prompt ${ansiC('cyan', '`self heal`')}`)
  bullet(`${ansiC('cyan', 'Ctrl+C')} to exit`)
  uiLine()
}

// Build a sandbox dir outside ROOT for baseline mode. Spawning the heal
// agent with cwd here prevents Claude Code / Codex from auto-discovering
// `.claude/skills/*`, `CLAUDE.md`, or `AGENTS.md` up the tree — those would
// leak canary-lab methodology into a supposedly vanilla run.
//
// We copy playwright-stdout.log into the sandbox so the agent's "first
// Read" lands on a local, present file. Writes (.restart) go back to the
// real LOGS_DIR via the absolute path in the prompt.
export function prepareBaselineSandbox(runId: string): {
  sandboxDir: string
  sandboxLogPath: string
} {
  const sandboxDir = path.join(os.tmpdir(), `canary-lab-baseline-${runId}`)
  fs.mkdirSync(sandboxDir, { recursive: true })
  const srcLog = PLAYWRIGHT_STDOUT_PATH
  const sandboxLogPath = path.join(sandboxDir, 'playwright-stdout.log')
  try {
    fs.copyFileSync(srcLog, sandboxLogPath)
  } catch {
    // Source log may not exist yet on first cycle; agent will still see the
    // absolute path and surface the miss itself.
  }
  return { sandboxDir, sandboxLogPath }
}

export async function maybeAutoHeal(
  autoHeal: AutoHealConfig,
  state: HealCycleState,
  terminal: TerminalChoice,
  benchmark: BenchmarkTracker | null = null,
  benchmarkMode: BenchmarkMode = 'canary',
  maxCycles = AUTO_HEAL_MAX_CYCLES,
): Promise<HealResult | null> {
  if (autoHeal.agent === null || state.disabled) return null

  const signature = readFailureSignature()
  if (signature === '') return null // no failures recorded

  if (signature === state.lastSignature) {
    state.strikeCount += 1
  } else {
    state.strikeCount = 0
    state.lastSignature = signature
  }

  if (state.strikeCount >= maxCycles) {
    uiLine()
    warn(`Auto-heal gave up after ${maxCycles} cycles on the same failure set.`)
    printManualOptions(true)
    state.disabled = true
    if (benchmark?.pending) {
      finalizeBenchmarkCycle(benchmark, 'max_cycles_reached', false)
    }
    if (benchmark) {
      finalizeBenchmarkRun(benchmark, 'max_cycles_reached', false)
    }
    return null
  }

  uiLine()
  info(`Auto-heal: spawning ${ansiC('bold', autoHeal.agent)} ${dim(`(strike ${state.strikeCount + 1}/${maxCycles})`)}...`)

  const cycle = state.spawnCount + 1
  const snapshot = benchmark
    ? buildBenchmarkContextSnapshot(benchmark.run.runId, cycle, benchmarkMode)
    : null
  const usageFile = benchmark && snapshot
    ? startBenchmarkCycle(benchmark, cycle, signature, snapshot)
    : undefined

  // Baseline must not see `.claude/`, `CLAUDE.md`, or `AGENTS.md` from the
  // project — the CLIs auto-discover them, which leaks canary-lab into a
  // supposedly vanilla run. Sandbox the agent cwd outside ROOT for baseline.
  let agentCwd: string | undefined
  let baselinePlaywrightLogPath: string | undefined
  let baselineRepoPaths: string[] | undefined
  if (benchmarkMode === 'baseline') {
    const runId = benchmark?.run.runId ?? String(Date.now())
    const { sandboxDir, sandboxLogPath } = prepareBaselineSandbox(runId)
    agentCwd = sandboxDir
    baselinePlaywrightLogPath = sandboxLogPath
    try {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
      if (Array.isArray(manifest.repoPaths)) {
        baselineRepoPaths = manifest.repoPaths.filter((p: unknown): p is string => typeof p === 'string')
      }
    } catch { /* no manifest yet, leave undefined */ }
  }

  const result = await spawnHealAgent({
    agent: autoHeal.agent,
    sessionMode: autoHeal.sessionMode,
    cycle: state.spawnCount,
    terminal,
    promptAddendum: snapshot?.promptAddendum,
    benchmarkUsageFile: usageFile,
    benchmarkMode,
    agentCwd,
    baselinePlaywrightLogPath,
    baselineSignalFilePath: benchmarkMode === 'baseline' ? RESTART_SIGNAL : undefined,
    baselineRepoPaths,
  })
  state.spawnCount += 1

  if (result === 'signal') {
    info('Auto-heal: agent wrote a signal — re-running tests.')
    return result
  }

  uiLine()
  if (result === 'agent_exited_no_signal') {
    warn('Auto-heal: agent exited without writing logs/.rerun or logs/.restart.')
  } else {
    warn('Auto-heal: timed out waiting for agent (10 min).')
  }
  printManualOptions(true)
  if (benchmark?.pending) {
    finalizeBenchmarkCycle(benchmark, result, false)
  }
  if (benchmark) {
    finalizeBenchmarkRun(benchmark, result, false)
  }
  return result
}

export async function watchMode(
  services: ServiceInfo[],
  featureDir: string,
  headed: boolean,
  terminal: TerminalChoice,
  autoHeal: AutoHealConfig,
  benchmark: BenchmarkTracker | null,
  benchmarkMode: BenchmarkMode,
  maxCycles: number,
): Promise<never> {
  // Clean any stale signal files
  try { fs.unlinkSync(RERUN_SIGNAL) } catch { /* ignore */ }
  try { fs.unlinkSync(RESTART_SIGNAL) } catch { /* ignore */ }
  try { fs.unlinkSync(HEAL_SIGNAL) } catch { /* ignore */ }

  const cycleState: HealCycleState = {
    spawnCount: 0,
    strikeCount: 0,
    lastSignature: '',
    disabled: false,
  }

  const printBanner = () => {
    banner('Watch Mode')
    if (autoHeal.agent) {
      console.log(
        `  ${dim('Auto-heal:')} ${ansiC('bold', autoHeal.agent)} ${dim(`(${autoHeal.sessionMode === 'resume' ? 'resume session' : 'new session each cycle'})`)}`,
      )
    }
    section('Waiting for signal')
    bullet(`${ansiC('cyan', 'touch logs/.rerun')}    ${dim('— re-run tests')}`)
    bullet(`${ansiC('cyan', 'touch logs/.restart')}  ${dim('— restart services + re-run')}`)
    if (autoHeal.agent) {
      bullet(`${ansiC('cyan', 'touch logs/.heal')}     ${dim('— re-engage auto-heal (resets strikes)')}`)
    }
    bullet(`${ansiC('cyan', 'Ctrl+C')}                ${dim('— stop everything')}`)
    uiLine()
  }

  printBanner()

  // If we already have failures from the initial run, trigger auto-heal before polling.
  await maybeAutoHeal(autoHeal, cycleState, terminal, benchmark, benchmarkMode, maxCycles)
  if (!autoHeal.agent && readFailureSignature() !== '') {
    // Auto-heal wasn't selected; surface the manual escape hatches so the user
    // isn't left wondering what to do with a red test board.
    printManualOptions(false)
  }

  while (true) {
    await new Promise((r) => setTimeout(r, 1000))

    const doRestart = fs.existsSync(RESTART_SIGNAL)
    const doRerun = fs.existsSync(RERUN_SIGNAL)
    const doHeal = fs.existsSync(HEAL_SIGNAL)

    if (!doRestart && !doRerun && !doHeal) continue

    // Read signal file content before consuming (agents may write JSON context)
    const signalPath = doRestart ? RESTART_SIGNAL : doRerun ? RERUN_SIGNAL : HEAL_SIGNAL
    let signalContent: Record<string, unknown> = {}
    try {
      const raw = fs.readFileSync(signalPath, 'utf-8').trim()
      if (raw) signalContent = JSON.parse(raw)
    } catch { /* empty or non-JSON signal file is fine */ }

    // Append to signal history
    try {
      const history: unknown[] = fs.existsSync(SIGNAL_HISTORY_PATH)
        ? JSON.parse(fs.readFileSync(SIGNAL_HISTORY_PATH, 'utf-8'))
        : []
      history.push({
        type: doRestart ? 'restart' : doRerun ? 'rerun' : 'heal',
        timestamp: new Date().toISOString(),
        ...signalContent,
      })
      fs.writeFileSync(
        SIGNAL_HISTORY_PATH,
        JSON.stringify(history, null, 2) + '\n',
      )
    } catch { /* don't let history logging break the loop */ }

    // Consume signal files
    try { fs.unlinkSync(RESTART_SIGNAL) } catch { /* ignore */ }
    try { fs.unlinkSync(RERUN_SIGNAL) } catch { /* ignore */ }
    try { fs.unlinkSync(HEAL_SIGNAL) } catch { /* ignore */ }

    // NOTE: do NOT close the heal tab here — the next heal cycle (if any)
    // will reuse it. It's closed below when tests pass + no next cycle is
    // needed, and on SIGINT via cleanup().

    if (doHeal) {
      if (!autoHeal.agent) {
        uiLine()
        warn('.heal signal received but no auto-heal agent is configured — ignoring.')
        uiLine()
        continue
      }
      uiLine()
      info('Heal signal received — resetting strikes and re-engaging auto-heal.')
      uiLine()
      cycleState.strikeCount = 0
      cycleState.lastSignature = ''
      cycleState.disabled = false
      await maybeAutoHeal(autoHeal, cycleState, terminal, benchmark, benchmarkMode, maxCycles)
      printBanner()
      continue
    }

    if (benchmark) {
      noteBenchmarkSignal(benchmark, doRestart ? '.restart' : '.rerun')
    }

    if (doRestart) {
      const selected = selectServicesToRestart(
        services,
        (signalContent as { filesChanged?: unknown }).filesChanged,
      )
      if (selected === null) {
        await restartAllServices(services, terminal, benchmarkMode)
      } else {
        info(`Selective restart: ${selected.map((s) => s.name).join(', ')}`)
        await restartServices(selected, terminal, benchmarkMode)
      }
    } else if (doRerun) {
      // Rerun keeps services running, but we still wipe their logs so each
      // iteration's output stands alone — matching restart's behavior.
      truncateServiceLogs(services, benchmarkMode)
    }

    uiLine()
    info(`Re-running Playwright tests${headed ? dim(' (headed)') : ''}...`)
    uiLine()
    await runPlaywright(featureDir, headed, benchmarkMode)
    printSummary()

    const greenAfterCycle = readFailureSignature() === ''
    if (benchmark?.pending) {
      finalizeBenchmarkCycle(benchmark, 'completed', greenAfterCycle)
      if (greenAfterCycle) {
        finalizeBenchmarkRun(benchmark, 'green', true)
      }
    }

    await maybeAutoHeal(autoHeal, cycleState, terminal, benchmark, benchmarkMode, maxCycles)

    // If tests are green now, no next heal cycle will fire — close the
    // lingering "you can close this tab" heal tab so it doesn't stick
    // around until SIGINT.
    if (terminal === 'iTerm' && readFailureSignature() === '') {
      closeLastHealAgentTab()
    }

    banner('Watch Mode')
    muted('  Waiting for signal...')
    uiLine()
  }
}

// ─── Flag parsing ───────────────────────────────────────────────────────────
interface RunFlags {
  headed: boolean
  terminal: TerminalChoice
  healSession: HealSessionMode
  benchmark: boolean
  benchmarkMode: BenchmarkMode
}

export function parseFlags(args: string[]): RunFlags {
  const flags: RunFlags = {
    headed: false,
    terminal: 'iTerm',
    healSession: 'resume',
    benchmark: false,
    benchmarkMode: 'canary',
  }
  const readValue = (arg: string, name: string, next: string | undefined): string => {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    if (next === undefined) throw new Error(`${name} requires a value`)
    return next
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--headed') {
      flags.headed = true
    } else if (arg === '--terminal' || arg.startsWith('--terminal=')) {
      const value = readValue(arg, '--terminal', arg.includes('=') ? undefined : args[++i])
      if (value !== 'iTerm' && value !== 'Terminal') {
        throw new Error(`--terminal must be "iTerm" or "Terminal" (got "${value}")`)
      }
      flags.terminal = value
    } else if (arg === '--heal-session' || arg.startsWith('--heal-session=')) {
      const value = readValue(arg, '--heal-session', arg.includes('=') ? undefined : args[++i])
      if (value !== 'resume' && value !== 'new') {
        throw new Error(`--heal-session must be "resume" or "new" (got "${value}")`)
      }
      flags.healSession = value
    } else if (arg === '--benchmark') {
      flags.benchmark = true
    } else if (arg === '--benchmark-mode' || arg.startsWith('--benchmark-mode=')) {
      const value = readValue(arg, '--benchmark-mode', arg.includes('=') ? undefined : args[++i])
      if (value !== 'canary' && value !== 'baseline') {
        throw new Error(`--benchmark-mode must be "canary" or "baseline" (got "${value}")`)
      }
      flags.benchmark = true
      flags.benchmarkMode = value
    } else {
      throw new Error(`Unknown flag: ${arg}`)
    }
  }
  return flags
}

// ─── Main ───────────────────────────────────────────────────────────────────
export async function main(argv: string[] = []) {
  const flags = parseFlags(argv)
  const terminalChoice: TerminalChoice = flags.terminal
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  let envSetApplied = false
  let appliedFeatureDir = ''
  let cleanedUp = false
  let services: ServiceInfo[] = []
  let benchmarkTracker: BenchmarkTracker | null = null

  // Cleanup stops all launched services and reverts env sets.
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true

    // Close readline so stdin no longer holds the event loop open and any
    // pending rl.question() rejections resolve cleanly.
    try { rl.close() } catch { /* already closed */ }

    // Stop service processes
    if (services.length > 0) {
      uiLine()
      info('Stopping services...')
      for (const svc of services) {
        const pid = resolveRunningPid(svc)
        if (pid) {
          process.stdout.write(`    ${ansiC('gray', '•')} ${svc.name} ${dim(`(PID ${pid})`)} … `)
          killProcessSync(pid)
          console.log(ansiC('green', 'stopped'))
        }
      }
    }

    // Close iTerm tabs we opened so they don't linger after the runner exits.
    // The shell inside each tab is still alive after killing the service PID;
    // without this, tabs stack up across runs.
    if (terminalChoice === 'iTerm') {
      try {
        const svcIds = Array.from(itermSessionIds.values())
        if (svcIds.length > 0) closeItermSessionsByIds(svcIds)
        closeLastHealAgentTab()
      } catch { /* best-effort */ }
    }

    if (envSetApplied) {
      uiLine()
      info('Reverting env files...')
      try {
        execFileSync(process.execPath, [SWITCH_SCRIPT, appliedFeatureDir, '--revert'], {
          stdio: 'inherit',
        })
      } catch {
        warn('env revert failed. Run `yarn env:revert` manually.')
      }
    }

    if (benchmarkTracker && !benchmarkTracker.finalized) {
      finalizeBenchmarkRun(benchmarkTracker, 'interrupted', false)
    }

    // Clean up baseline tmp dirs so we don't leave stray state in the OS
    // tmpdir after a benchmark run. Best-effort.
    const runnerTmp = process.env.CANARY_LAB_SUMMARY_PATH
    if (runnerTmp && runnerTmp.includes('canary-lab-baseline-runner-')) {
      try {
        fs.rmSync(path.dirname(runnerTmp), { recursive: true, force: true })
      } catch { /* best-effort */ }
    }
  }

  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })

  try {
    banner('Canary Lab — E2E Runner')

    // Warn if the scaffolded files in this project were synced against an
    // older version of canary-lab. `npm update` doesn't touch files outside
    // node_modules/, so users can easily drift out of sync with the skills
    // and managed doc blocks.
    const notice = formatDriftNotice(checkUpgradeDrift(ROOT))
    if (notice) {
      uiLine()
      warn(notice.replace(/\n/g, '\n  '))
    }

    // ── 1. Discover features
    const features = discoverFeatures()
    if (features.length === 0) {
      fail('No features found. Add a feature.config.cjs to a features/<name>/ folder.')
      process.exit(1)
    }

    // ── 2. Select feature
    const labels = features.map((f) => `${f.name} — ${f.description}`)
    const chosen = await selectOption(rl, 'Which feature?', labels)
    const feature = features[labels.indexOf(chosen)]

    // ── 3. Select environment
    let env: string
    if (feature.envs.length === 1) {
      env = feature.envs[0]
      uiLine()
      console.log(`${dim('Environment:')} ${ansiC('bold', env)}`)
    } else {
      env = await selectOption(rl, 'Which environment?', feature.envs)
    }

    const headed = flags.headed

    // ── 4. Auto-heal mode?
    const autoHealChoice = await selectOption(
      rl,
      'Auto-heal on test failure?',
      ['No (default)', 'Yes — Claude Code', 'Yes — Codex'],
    )
    const autoHeal: AutoHealConfig = { agent: null, sessionMode: flags.healSession }
    if (autoHealChoice.includes('Claude')) {
      autoHeal.agent = 'claude'
    } else if (autoHealChoice.includes('Codex')) {
      autoHeal.agent = 'codex'
    }
    if (autoHeal.agent !== null && !isAgentCliAvailable(autoHeal.agent)) {
      uiLine()
      fail(`\`${autoHeal.agent}\` CLI not found on PATH. Install it and re-run, or pick a different auto-heal agent.`)
      console.error(`  ${dim('You can still drive the heal loop interactively: open')} \`claude\` ${dim('or')} \`codex\``)
      console.error(`  ${dim('in')} ${ansiPath(ROOT)} ${dim('and send the prompt')} \`self heal\`.`)
      process.exit(1)
    }
    if (autoHeal.agent === null) {
      uiLine()
      info('Auto-heal is off. If a test fails, you can drive the fix loop yourself:')
      bullet(`open ${ansiC('cyan', '`claude`')} or ${ansiC('cyan', '`codex`')} in ${ansiPath(ROOT)} and send the prompt ${ansiC('cyan', '`self heal`')}`)
      bullet(`or fix the code and ${ansiC('cyan', '`touch logs/.rerun`')}`)
    }

    const benchmarkConfig: BenchmarkConfig = {
      enabled: flags.benchmark,
      mode: flags.benchmarkMode,
    }
    if (benchmarkConfig.enabled) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      benchmarkTracker = createBenchmarkTracker({
        runId: `${stamp}_${feature.name}_${benchmarkConfig.mode}`,
        feature: feature.name,
        benchmarkMode: benchmarkConfig.mode,
        startedAt: new Date().toISOString(),
        modelProvider: autoHeal.agent,
        maxCycles: AUTO_HEAL_MAX_CYCLES,
        headed,
        autoHealEnabled: autoHeal.agent !== null,
        healSession: autoHeal.sessionMode,
      })
    }

    // Baseline keeps LOGS_DIR clean: redirect the summary (runner-internal
    // state the heal-loop uses for failure detection) to tmpdir so it never
    // appears alongside playwright-stdout.log / manifest.json. Set it in
    // process.env so both the runner and the Playwright reporter honor it.
    if (benchmarkConfig.enabled && benchmarkConfig.mode === 'baseline') {
      const runId = benchmarkTracker?.run.runId ?? String(Date.now())
      const runnerTmp = path.join(os.tmpdir(), `canary-lab-baseline-runner-${runId}`)
      fs.mkdirSync(runnerTmp, { recursive: true })
      process.env.CANARY_LAB_SUMMARY_PATH = path.join(runnerTmp, 'e2e-summary.json')
    }

    // ── 6. Check repos
    uiLine()
    info('Checking prerequisites...')
    if (!checkRepos(feature)) {
      uiLine()
      fail('Please clone the missing repos and try again.')
      process.exit(1)
    }
    ok('All repos present.')

    // ── 7. Apply env sets
    const envSetsDir = path.join(feature.featureDir, 'envsets')
    if (fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) {
      const envSets = fs
        .readdirSync(envSetsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()

      let chosenSet: string
      if (envSets.includes(env)) {
        chosenSet = env
      } else if (envSets.length === 1) {
        chosenSet = envSets[0]
      } else {
        chosenSet = await selectOption(
          rl,
          `Which env set for ${feature.name}?`,
          envSets,
        )
      }

      uiLine()
      info(`Applying env set: ${ansiC('bold', chosenSet)}`)
      execFileSync(
        process.execPath,
        [SWITCH_SCRIPT, feature.featureDir, '--apply', chosenSet],
        { stdio: 'inherit' },
      )
      envSetApplied = true
      appliedFeatureDir = feature.featureDir
    }

    // NOTE: don't `rl.close()` here. Later phases (health-check failure
    // recovery, future interactive prompts) may still need stdin. The
    // readline is closed inside cleanup() so it lives for the whole run.

    // ── 8. Prepare logs directory
    // Preserve iTerm session ID caches across the logs wipe so we can still
    // close tabs from a prior runner process that exited without clean
    // shutdown (in-memory copy is re-saved later via openTabs(), but only
    // when that code path runs — e.g. a no-heal run otherwise loses them).
    const preservedSessionIds: Record<string, string | null> = {
      [ITERM_SESSION_IDS_PATH]: safeReadFile(ITERM_SESSION_IDS_PATH),
      [ITERM_HEAL_SESSION_IDS_PATH]: safeReadFile(ITERM_HEAL_SESSION_IDS_PATH),
    }
    fs.rmSync(LOGS_DIR, { recursive: true, force: true })
    fs.mkdirSync(PIDS_DIR, { recursive: true })
    for (const [p, content] of Object.entries(preservedSessionIds)) {
      if (content !== null) fs.writeFileSync(p, content)
    }

    // ── 9. Build service list and launch in terminal tabs (with tee to log files)
    services = buildServiceList(feature)
    await launchServices(services, terminalChoice, flags.benchmarkMode)
    writeManifest(services, feature)

    // ── 10. Wait for health checks
    try {
      await pollHealthChecks(services)
    } catch (err) {
      if (err instanceof HealthCheckTimeoutError) {
        const recovered = await handleHealthCheckFailure({
          rl,
          failingServiceName: err.serviceName,
          services,
          feature,
          terminal: terminalChoice,
          benchmarkMode: flags.benchmarkMode,
          healSession: autoHeal.sessionMode,
        })
        if (!recovered) throw err
      } else {
        throw err
      }
    }

    // ── 11. Run Playwright
    uiLine()
    info(`Running Playwright tests${headed ? dim(' (headed)') : ''}...`)
    uiLine()
    await runPlaywright(feature.featureDir, headed, flags.benchmarkMode)

    // ── 12. Print summary (SummaryReporter has already enriched it)
    printSummary()
    if (benchmarkTracker && readFailureSignature() === '') {
      finalizeBenchmarkRun(benchmarkTracker, 'green', true)
    } else if (benchmarkTracker && autoHeal.agent === null) {
      finalizeBenchmarkRun(benchmarkTracker, 'manual_only', false)
    }

    // ── 13. Enter watch mode (loops forever until Ctrl+C)
    await watchMode(
      services,
      feature.featureDir,
      headed,
      terminalChoice,
      autoHeal,
      benchmarkTracker,
      flags.benchmarkMode,
      AUTO_HEAL_MAX_CYCLES,
    )
  } catch (err) {
    cleanup()
    throw err
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
