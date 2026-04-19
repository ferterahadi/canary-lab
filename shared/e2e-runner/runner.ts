import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { execFileSync, spawn } from 'child_process'
import type { FeatureConfig } from '../launcher/types'
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
  SUMMARY_PATH,
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
  type HealAgent,
  type HealSessionMode,
} from './auto-heal'

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
  console.log(`\n${label}`)
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`))
  while (true) {
    const answer = await prompt(rl, `Select [1-${options.length}]: `)
    const idx = parseInt(answer.trim(), 10) - 1
    if (idx >= 0 && idx < options.length) return options[idx]
    console.log(`  Please enter a number between 1 and ${options.length}`)
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
      console.error(`\n  Missing repo: ${repo.name}`)
      console.error(`  Expected at: ${resolved}`)
      if (repo.cloneUrl) {
        console.error(
          `  Clone it with:\n    git clone ${repo.cloneUrl} ${resolved}`,
        )
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

export function buildTeedCommand(svc: ServiceInfo): string {
  // LOG_MODE=plain tells apps to use synchronous console.log instead of async
  // loggers (e.g. Pino/sonic-boom), so XML markers land in the right position.
  // stdout+stderr go to both the iTerm tab and the log file via tee.
  return `LOG_MODE=plain ${svc.command} 2>&1 | tee -a ${svc.logPath}`
}

// Wipe each service's log file so the next iteration starts clean. Called
// before every run signal (.restart and .rerun) so both behave identically —
// the file contains only the current iteration's output.
export function truncateServiceLogs(services: ServiceInfo[]): void {
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
): Promise<void> {
  // Always kill existing processes so we own the tee pipe and capture all logs.
  // Without this, externally-started services have no log file and XML markers
  // cannot be extracted.
  for (const svc of services) {
    const pid = resolveRunningPid(svc)
    if (pid) {
      process.stdout.write(`  Stopping existing ${svc.name} (PID ${pid})... `)
      await killProcess(pid)
      console.log('stopped')
    }
  }

  truncateServiceLogs(services)

  const tabs: Array<{ dir: string; command: string; name: string }> = services.map((svc) => ({
    dir: svc.cwd,
    command: buildTeedCommand(svc),
    name: svc.name,
  }))

  if (tabs.length === 0) {
    return
  }

  openTabs(terminal, tabs, `  Opening ${terminal} tabs for ${tabs.length} service(s)...`)
}

export async function pollHealthChecks(
  services: ServiceInfo[],
  timeoutMs = 120_000,
): Promise<void> {
  const checksNeeded = services.filter((s) => s.healthUrl)
  if (checksNeeded.length === 0) return

  console.log('\n  Waiting for health checks...')
  const deadline = Date.now() + timeoutMs

  for (const svc of checksNeeded) {
    process.stdout.write(`    ${svc.name}: `)
    while (Date.now() < deadline) {
      if (await isHealthy(svc.healthUrl!, svc.healthTimeout)) {
        console.log('healthy')
        break
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    if (Date.now() >= deadline) {
      console.log('TIMEOUT')
      throw new Error(
        `Health check timed out for ${svc.name} at ${svc.healthUrl}`,
      )
    }
  }
  console.log('')
}

export function writeManifest(services: ServiceInfo[]): void {
  const manifest = { serviceLogs: services.map((s) => s.logPath) }
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

export async function restartAllServices(
  services: ServiceInfo[],
  terminal: TerminalChoice,
): Promise<void> {
  console.log('\n  Restarting all configured services...')

  // Kill all running services first
  for (const svc of services) {
    process.stdout.write(`    ${svc.name}: `)
    const pid = resolveRunningPid(svc)
    if (pid) {
      process.stdout.write(`stopping PID ${pid}... `)
      await killProcess(pid)
      console.log('stopped')
    } else {
      console.log('no existing process found')
    }
  }

  truncateServiceLogs(services)

  // Re-launch all in terminal tabs with tee
  const tabs = services.map((svc) => ({
    dir: svc.cwd,
    command: buildTeedCommand(svc),
    name: svc.name,
  }))
  openTabs(terminal, tabs, `  Re-opening ${terminal} tabs for ${tabs.length} service(s)...`)

  await pollHealthChecks(services)
}

// ─── Playwright ─────────────────────────────────────────────────────────────
const RUN_TIMEOUT = 10 * 60 * 1000 // 10 minutes — safety net for hung runs

export function runPlaywright(featureDir: string, headed: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const playwrightArgs = [
      'playwright',
      'test',
      `--reporter=${SUMMARY_REPORTER},list`,
      ...(headed ? ['--headed'] : []),
    ]

    const child = spawn('npx', playwrightArgs, {
      cwd: featureDir,
      env: {
        ...process.env,
        CANARY_LAB_PROJECT_ROOT: ROOT,
      },
      stdio: 'inherit',
      shell: false,
    })

    const timer = setTimeout(() => {
      console.log('\n  Playwright run timed out after 10 minutes, killing...')
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

    child.on('error', (err) => {
      clearTimeout(timer)
      process.off('SIGINT', forwardSigInt)
      process.off('SIGTERM', forwardSigTerm)
      reject(err)
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      process.off('SIGINT', forwardSigInt)
      process.off('SIGTERM', forwardSigTerm)
      resolve(code ?? 1)
    })
  })
}

// ─── Log enrichment ─────────────────────────────────────────────────────────
export function extractLogsForTest(
  slug: string,
  serviceLogs: string[],
): Record<string, string> {
  const logs: Record<string, string> = {}
  const openTag = `<${slug}>`
  const closeTag = `</${slug}>`

  for (const logPath of serviceLogs) {
    if (!fs.existsSync(logPath)) continue
    const content = fs.readFileSync(logPath, 'utf-8')
    const openIdx = content.indexOf(openTag)
    const closeIdx = content.indexOf(closeTag)
    if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) continue
    const snippet = content
      .slice(openIdx + openTag.length, closeIdx)
      .trim()
    if (snippet.length > 0) {
      const svcName = path.basename(logPath, '.log')
      logs[svcName] = snippet
    }
  }
  return logs
}

export function enrichSummaryWithLogs(): void {
  if (!fs.existsSync(SUMMARY_PATH) || !fs.existsSync(MANIFEST_PATH)) return

  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'))
  const manifest: { serviceLogs: string[] } = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, 'utf-8'),
  )

  if (!Array.isArray(summary.failed) || summary.failed.length === 0) return

  // Enrich: replace string slugs with {name, logs} objects
  summary.failed = summary.failed.map((entry: string | { name: string }) => {
    const slug = typeof entry === 'string' ? entry : entry.name
    const logs = extractLogsForTest(slug, manifest.serviceLogs)
    return { name: slug, logs }
  })

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + '\n')
}

// ─── Summary ────────────────────────────────────────────────────────────────
export function printSummary(): void {
  if (!fs.existsSync(SUMMARY_PATH)) {
    console.log('\n  No summary file found.')
    return
  }

  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'))
  console.log('\n  ──── E2E Summary ────')
  console.log(`  Total:  ${summary.total}`)
  console.log(`  Passed: ${summary.passed}`)
  console.log(`  Failed: ${summary.failed.length}`)
  if (summary.failed.length > 0) {
    console.log(`  Failures:`)
    for (const entry of summary.failed) {
      const name = typeof entry === 'string' ? entry : entry.name
      console.log(`    - ${name}`)
    }
  }
  console.log('')
}

// ─── Watch mode ─────────────────────────────────────────────────────────────
export function readFailureSignature(): string {
  if (!fs.existsSync(SUMMARY_PATH)) return ''
  try {
    const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'))
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
  console.log('  Options:')
  console.log('    • fix the code yourself, then `touch logs/.rerun`')
  if (autoHealConfigured) {
    console.log('    • `touch logs/.heal` to reset strikes and spawn the headless agent again')
  }
  console.log(
    `    • open \`claude\` or \`codex\` in ${ROOT} and send the prompt \`self heal\``,
  )
  console.log('    • Ctrl+C to exit')
  console.log('')
}

export async function maybeAutoHeal(
  autoHeal: AutoHealConfig,
  state: HealCycleState,
  terminal: TerminalChoice,
): Promise<void> {
  if (autoHeal.agent === null || state.disabled) return

  const signature = readFailureSignature()
  if (signature === '') return // no failures recorded

  if (signature === state.lastSignature) {
    state.strikeCount += 1
  } else {
    state.strikeCount = 0
    state.lastSignature = signature
  }

  if (state.strikeCount >= AUTO_HEAL_MAX_CYCLES) {
    console.log(
      `\n  Auto-heal gave up after ${AUTO_HEAL_MAX_CYCLES} cycles on the same failure set.`,
    )
    printManualOptions(true)
    state.disabled = true
    return
  }

  console.log(
    `\n  Auto-heal: spawning ${autoHeal.agent} (strike ${state.strikeCount + 1}/${AUTO_HEAL_MAX_CYCLES})...`,
  )

  const result = await spawnHealAgent({
    agent: autoHeal.agent,
    sessionMode: autoHeal.sessionMode,
    cycle: state.spawnCount,
    terminal,
  })
  state.spawnCount += 1

  if (result === 'signal') {
    console.log('  Auto-heal: agent wrote a signal — re-running tests.')
    return
  }

  if (result === 'agent_exited_no_signal') {
    console.log(
      '\n  Auto-heal: agent exited without writing logs/.rerun or logs/.restart.',
    )
  } else {
    console.log('\n  Auto-heal: timed out waiting for agent (10 min).')
  }
  printManualOptions(true)
}

async function watchMode(
  services: ServiceInfo[],
  featureDir: string,
  headed: boolean,
  terminal: TerminalChoice,
  autoHeal: AutoHealConfig,
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
    console.log('  ──── Watch Mode ────')
    if (autoHeal.agent) {
      console.log(
        `  Auto-heal: ${autoHeal.agent} (${autoHeal.sessionMode === 'resume' ? 'resume session' : 'new session each cycle'})`,
      )
    }
    console.log('  Waiting for signal...')
    console.log('    touch logs/.rerun    — re-run tests')
    console.log('    touch logs/.restart  — restart services + re-run')
    if (autoHeal.agent) {
      console.log('    touch logs/.heal     — re-engage auto-heal (resets strikes)')
    }
    console.log('    Ctrl+C               — stop everything')
    console.log('')
  }

  printBanner()

  // If we already have failures from the initial run, trigger auto-heal before polling.
  await maybeAutoHeal(autoHeal, cycleState, terminal)
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
        console.log(
          '\n  .heal signal received but no auto-heal agent is configured — ignoring.\n',
        )
        continue
      }
      console.log(
        '\n  Heal signal received — resetting strikes and re-engaging auto-heal.\n',
      )
      cycleState.strikeCount = 0
      cycleState.lastSignature = ''
      cycleState.disabled = false
      await maybeAutoHeal(autoHeal, cycleState, terminal)
      printBanner()
      continue
    }

    if (doRestart) {
      await restartAllServices(services, terminal)
    } else if (doRerun) {
      // Rerun keeps services running, but we still wipe their logs so each
      // iteration's output stands alone — matching restart's behavior.
      truncateServiceLogs(services)
    }

    console.log(
      `\n  Re-running Playwright tests${headed ? ' (headed)' : ''}...\n`,
    )
    await runPlaywright(featureDir, headed)
    enrichSummaryWithLogs()
    printSummary()

    await maybeAutoHeal(autoHeal, cycleState, terminal)

    // If tests are green now, no next heal cycle will fire — close the
    // lingering "you can close this tab" heal tab so it doesn't stick
    // around until SIGINT.
    if (terminal === 'iTerm' && readFailureSignature() === '') {
      closeLastHealAgentTab()
    }

    console.log('  ──── Watch Mode ────')
    console.log('  Waiting for signal...\n')
  }
}

// ─── Flag parsing ───────────────────────────────────────────────────────────
interface RunFlags {
  headed: boolean
  terminal: TerminalChoice
  healSession: HealSessionMode
}

export function parseFlags(args: string[]): RunFlags {
  const flags: RunFlags = { headed: false, terminal: 'iTerm', healSession: 'resume' }
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

  // Cleanup stops all launched services and reverts env sets.
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true

    // Stop service processes
    if (services.length > 0) {
      console.log('\n  Stopping services...')
      for (const svc of services) {
        const pid = resolveRunningPid(svc)
        if (pid) {
          process.stdout.write(`    ${svc.name}: stopping PID ${pid}... `)
          killProcessSync(pid)
          console.log('stopped')
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
        console.log('\n  Reverting env files...')
      try {
        execFileSync(process.execPath, [SWITCH_SCRIPT, appliedFeatureDir, '--revert'], {
          stdio: 'inherit',
        })
      } catch {
        console.error(
          '  Warning: env revert failed. Run `yarn env:revert` manually.',
        )
      }
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
    console.log('\n  Canary Lab — E2E Runner\n')

    // ── 1. Discover features
    const features = discoverFeatures()
    if (features.length === 0) {
      console.error(
        'No features found. Add a feature.config.cjs to a features/<name>/ folder.',
      )
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
      console.log(`\n  Environment: ${env}`)
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
      console.error(
        `\n  \`${autoHeal.agent}\` CLI not found on PATH. Install it and re-run, or pick a different auto-heal agent.`,
      )
      console.error(
        `  You can still drive the heal loop interactively: open \`claude\` or \`codex\``,
      )
      console.error(`  in ${ROOT} and send the prompt \`self heal\`.`)
      process.exit(1)
    }
    if (autoHeal.agent === null) {
      console.log('\n  Auto-heal is off. If a test fails, you can drive the fix loop yourself:')
      console.log(`    • open \`claude\` or \`codex\` in ${ROOT} and send the prompt \`self heal\``)
      console.log('    • or fix the code and `touch logs/.rerun`')
    }

    // ── 6. Check repos
    console.log('\n  Checking prerequisites...')
    if (!checkRepos(feature)) {
      console.error('\n  Please clone the missing repos and try again.')
      process.exit(1)
    }
    console.log('  All repos present.')

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

      console.log(`\n  Applying env set: ${chosenSet}`)
      execFileSync(
        process.execPath,
        [SWITCH_SCRIPT, feature.featureDir, '--apply', chosenSet],
        { stdio: 'inherit' },
      )
      envSetApplied = true
      appliedFeatureDir = feature.featureDir
    }

    rl.close()

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
    await launchServices(services, terminalChoice)
    writeManifest(services)

    // ── 10. Wait for health checks
    await pollHealthChecks(services)

    // ── 11. Run Playwright
    console.log(`  Running Playwright tests${headed ? ' (headed)' : ''}...\n`)
    await runPlaywright(feature.featureDir, headed)

    // ── 12. Enrich summary with log snippets and print
    enrichSummaryWithLogs()
    printSummary()

    // ── 13. Enter watch mode (loops forever until Ctrl+C)
    await watchMode(services, feature.featureDir, headed, terminalChoice, autoHeal)
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
