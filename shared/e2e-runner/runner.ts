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
import { openItermTabs } from '../launcher/iterm'
import { openTerminalTabs } from '../launcher/terminal'

type TerminalChoice = 'iTerm' | 'Terminal'

// ─── Paths ──────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '../..')
const FEATURES_DIR = path.join(ROOT, 'features')
const LOGS_DIR = path.join(ROOT, 'logs')
const PIDS_DIR = path.join(LOGS_DIR, 'pids')
const MANIFEST_PATH = path.join(LOGS_DIR, 'manifest.json')
const SUMMARY_PATH = path.join(LOGS_DIR, 'e2e-summary.json')
const SWITCH_SCRIPT = path.join(__dirname, '../env-switcher/switch.ts')
const SUMMARY_REPORTER = path.resolve(__dirname, 'summary-reporter.ts')
const RERUN_SIGNAL = path.join(LOGS_DIR, '.rerun')
const RESTART_SIGNAL = path.join(LOGS_DIR, '.restart')

// ─── Readline helpers (same pattern as shared/launcher/index.ts) ────────────
function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

async function selectOption(
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
function discoverFeatures(): FeatureConfig[] {
  const features: FeatureConfig[] = []
  const dirs = fs
    .readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const dir of dirs) {
    const configPath = path.join(FEATURES_DIR, dir, 'feature.config.ts')
    if (!fs.existsSync(configPath)) continue
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
function checkRepos(feature: FeatureConfig): boolean {
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

function buildServiceList(feature: FeatureConfig): ServiceInfo[] {
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

function buildTeedCommand(svc: ServiceInfo): string {
  // LOG_MODE=plain tells apps to use synchronous console.log instead of async
  // loggers (e.g. Pino/sonic-boom), so XML markers land in the right position.
  // stdout+stderr go to both the iTerm tab and the log file via tee.
  return `LOG_MODE=plain ${svc.command} 2>&1 | tee -a ${svc.logPath}`
}

function openTabs(
  terminal: TerminalChoice,
  tabs: Array<{ dir: string; command: string; name: string }>,
  label: string,
): void {
  if (terminal === 'iTerm') {
    openItermTabs(tabs, label)
  } else {
    openTerminalTabs(tabs, label)
  }
}

async function launchServices(
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
      killProcess(pid)
      console.log('stopped')
    }
  }

  const tabs: Array<{ dir: string; command: string; name: string }> = []

  for (const svc of services) {
    // Create/truncate log file for a clean run
    fs.writeFileSync(svc.logPath, '')

    tabs.push({
      dir: svc.cwd,
      command: buildTeedCommand(svc),
      name: svc.name,
    })
  }

  if (tabs.length === 0) {
    return
  }

  openTabs(terminal, tabs, `  Opening ${terminal} tabs for ${tabs.length} service(s)...`)
}

async function pollHealthChecks(
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

function writeManifest(services: ServiceInfo[]): void {
  const manifest = { serviceLogs: services.map((s) => s.logPath) }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
}

// ─── Restart unhealthy services ─────────────────────────────────────────────
function readPid(safeName: string): number | null {
  const pidPath = path.join(PIDS_DIR, `${safeName}.pid`)
  if (!fs.existsSync(pidPath)) return null
  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
  return isNaN(pid) ? null : pid
}

function portFromHealthUrl(url: string): number | null {
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

function lookupPidByPort(port: number): number | null {
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const pid = parseInt(output.split('\n')[0]?.trim() ?? '', 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  // Wait up to 5s for graceful shutdown
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && isProcessAlive(pid)) {
    const waitUntil = Date.now() + 200
    while (Date.now() < waitUntil) {
      /* spin */
    }
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }
}

function resolveRunningPid(svc: ServiceInfo): number | null {
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

async function restartAllServices(
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
      killProcess(pid)
      console.log('stopped')
    } else {
      console.log('no existing process found')
    }
  }

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
function runPlaywright(featureDir: string, headed: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const playwrightArgs = [
      'playwright',
      'test',
      `--reporter=${SUMMARY_REPORTER},list`,
      ...(headed ? ['--headed'] : []),
    ]

    const child = spawn('npx', playwrightArgs, {
      cwd: featureDir,
      stdio: 'inherit',
      shell: false,
    })

    const forwardSigInt = () => child.kill('SIGINT')
    const forwardSigTerm = () => child.kill('SIGTERM')
    process.on('SIGINT', forwardSigInt)
    process.on('SIGTERM', forwardSigTerm)

    child.on('error', (err) => {
      process.off('SIGINT', forwardSigInt)
      process.off('SIGTERM', forwardSigTerm)
      reject(err)
    })

    child.on('exit', (code) => {
      process.off('SIGINT', forwardSigInt)
      process.off('SIGTERM', forwardSigTerm)
      resolve(code ?? 1)
    })
  })
}

// ─── Summary ────────────────────────────────────────────────────────────────
function printSummary(): void {
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
    for (const name of summary.failed) {
      console.log(`    - ${name}`)
    }
  }
  console.log('')
}

// ─── Watch mode ─────────────────────────────────────────────────────────────
async function watchMode(
  services: ServiceInfo[],
  featureDir: string,
  headed: boolean,
  terminal: TerminalChoice,
): Promise<never> {
  // Clean any stale signal files
  try { fs.unlinkSync(RERUN_SIGNAL) } catch { /* ignore */ }
  try { fs.unlinkSync(RESTART_SIGNAL) } catch { /* ignore */ }

  console.log('  ──── Watch Mode ────')
  console.log('  Waiting for signal...')
  console.log('    touch logs/.rerun    — re-run tests')
  console.log('    touch logs/.restart  — restart services + re-run')
  console.log('    Ctrl+C               — stop everything')
  console.log('')

  while (true) {
    await new Promise((r) => setTimeout(r, 1000))

    const doRestart = fs.existsSync(RESTART_SIGNAL)
    const doRerun = fs.existsSync(RERUN_SIGNAL)

    if (!doRestart && !doRerun) continue

    // Consume signal files
    try { fs.unlinkSync(RESTART_SIGNAL) } catch { /* ignore */ }
    try { fs.unlinkSync(RERUN_SIGNAL) } catch { /* ignore */ }

    if (doRestart) {
      await restartAllServices(services, terminal)
    }

    console.log(
      `\n  Re-running Playwright tests${headed ? ' (headed)' : ''}...\n`,
    )
    await runPlaywright(featureDir, headed)
    printSummary()

    console.log('  ──── Watch Mode ────')
    console.log('  Waiting for signal...\n')
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
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
          killProcess(pid)
          console.log('stopped')
        }
      }
    }

    if (envSetApplied) {
      console.log('\n  Reverting env files...')
      try {
        execFileSync('tsx', [SWITCH_SCRIPT, appliedFeatureDir, '--revert'], {
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
        'No features found. Add a feature.config.ts to a features/<name>/ folder.',
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

    // ── 4. Select terminal
    const terminalChoice = await selectOption(
      rl,
      'Which terminal?',
      ['iTerm', 'Terminal'],
    ) as TerminalChoice

    // ── 5. Headed?
    const headedChoice = await selectOption(
      rl,
      'Run headed (browser visible)?',
      ['No (headless)', 'Yes (headed)'],
    )
    const headed = headedChoice.startsWith('Yes')

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
        'tsx',
        [SWITCH_SCRIPT, feature.featureDir, '--apply', chosenSet],
        { stdio: 'inherit' },
      )
      envSetApplied = true
      appliedFeatureDir = feature.featureDir
    }

    rl.close()

    // ── 8. Prepare logs directory
    fs.rmSync(LOGS_DIR, { recursive: true, force: true })
    fs.mkdirSync(PIDS_DIR, { recursive: true })

    // ── 9. Build service list and launch in terminal tabs (with tee to log files)
    services = buildServiceList(feature)
    await launchServices(services, terminalChoice)
    writeManifest(services)

    // ── 10. Wait for health checks
    await pollHealthChecks(services)

    // ── 11. Run Playwright
    console.log(`  Running Playwright tests${headed ? ' (headed)' : ''}...\n`)
    await runPlaywright(feature.featureDir, headed)

    // ── 12. Print summary
    printSummary()

    // ── 13. Enter watch mode (loops forever until Ctrl+C)
    await watchMode(services, feature.featureDir, headed, terminalChoice)
  } catch (err) {
    cleanup()
    throw err
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
