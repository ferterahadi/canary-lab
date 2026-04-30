// Thin CLI shim — drives feature selection / env prompts via readline, then
// delegates orchestration to `RunOrchestrator`. Output streams to the
// invoking terminal via `ForegroundLauncher` until the web UI lands.
//
// Heavy orchestration logic lives in `orchestrator.ts`; this file's only job
// is to wire user input + the new per-run log layout to it.

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { execFileSync, spawn } from 'child_process'
import { runAsScript } from '../../scripts/run-as-script'
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
  path as ansiPath,
  c as ansiC,
  setActiveRunnerLog,
} from '../cli-ui/ui'
import { RunnerLog } from './runner-log'
import type { FeatureConfig } from '../launcher/types'
import { ForegroundLauncher } from '../launcher/foreground-pty'
import { realPtyFactory } from './pty-spawner'
import { enabledForEnv, normalizeStartCommand, resolvePath } from '../launcher/startup'
import {
  ROOT,
  FEATURES_DIR,
  LOGS_DIR,
} from './paths'
import { generateRunId } from './run-id'
import { buildRunPaths, runDirFor } from './run-paths'
import { pruneRuns } from './retention'
import { RunOrchestrator } from './orchestrator'
import {
  spawnHealAgent,
  isAgentCliAvailable,
  failureSignature,
  type HealAgent,
  type HealSessionMode,
} from './auto-heal'
import { appendJournalIteration } from './log-enrichment'
import { resolveMcpOutputDir, ensureMcpOutputDir } from './playwright-mcp-artifacts'

const SWITCH_SCRIPT = path.join(__dirname, '../env-switcher/switch.js')
const SUMMARY_REPORTER = path.resolve(__dirname, 'summary-reporter.js')

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

export function discoverFeatures(): FeatureConfig[] {
  const features: FeatureConfig[] = []
  if (!fs.existsSync(FEATURES_DIR)) return features
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
      /* skip malformed configs */
    }
  }
  return features
}

export function checkRepos(feature: FeatureConfig, env?: string): boolean {
  if (!feature.repos?.length) return true
  let allOk = true
  for (const repo of feature.repos) {
    if (!enabledForEnv(repo.envs, env)) continue
    const cmds = repo.startCommands ?? []
    if (cmds.length > 0 && !cmds.some((c, i) =>
      enabledForEnv(normalizeStartCommand(c, `${repo.name}-cmd-${i + 1}`).envs, env),
    )) continue
    const resolved = resolvePath(repo.localPath)
    if (!fs.existsSync(resolved)) {
      uiLine()
      fail(`Missing repo: ${repo.name}`)
      console.error(`  ${dim('expected at:')} ${resolved}`)
      if (repo.cloneUrl) {
        console.error(`  ${dim('clone it with:')} git clone ${repo.cloneUrl} ${resolved}`)
      }
      allOk = false
    }
  }
  return allOk
}

interface RunFlags {
  headed: boolean
  healSession: HealSessionMode
}

export function parseFlags(args: string[]): RunFlags {
  const flags: RunFlags = { headed: false, healSession: 'resume' }
  const readValue = (arg: string, name: string, next: string | undefined): string => {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    if (next === undefined) throw new Error(`${name} requires a value`)
    return next
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--headed') {
      flags.headed = true
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

function runPlaywright(
  featureDir: string,
  headed: boolean,
  summaryPath: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [
      'playwright', 'test',
      `--reporter=${SUMMARY_REPORTER},list`,
      ...(headed ? ['--headed'] : []),
    ]
    const child = spawn('npx', args, {
      cwd: featureDir,
      env: {
        ...process.env,
        CANARY_LAB_PROJECT_ROOT: ROOT,
        CANARY_LAB_SUMMARY_PATH: summaryPath,
      },
      stdio: 'inherit',
      shell: false,
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

// Top-level entry — minimal flow that boots a single run and waits for either
// Ctrl+C or the run to complete. The richer watch/heal cycle that lived here
// before is being moved into the web UI; this remains as a fallback so the
// CLI keeps working until that lands.
export async function main(argv: string[] = []) {
  const flags = parseFlags(argv)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  let envSetApplied = false
  let appliedFeatureDir = ''
  let cleanedUp = false
  let orchestrator: RunOrchestrator | null = null

  const cleanup = async () => {
    if (cleanedUp) return
    cleanedUp = true
    try { rl.close() } catch { /* ignore */ }
    setActiveRunnerLog(null)
    if (orchestrator) {
      await orchestrator.stop('aborted')
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
  }

  process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
  process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(143)) })

  try {
    banner('Canary Lab — E2E Runner')
    warn('`canary-lab run` is deprecated. Use `canary-lab ui` for the new web UI.')
    console.log(dim('    The legacy CLI flow will be removed in 0.11.0.'))
    uiLine()

    const features = discoverFeatures()
    if (features.length === 0) {
      fail('No features found. Add a feature.config.cjs to a features/<name>/ folder.')
      process.exit(1)
    }
    const labels = features.map((f) => `${f.name} — ${f.description}`)
    const chosen = await selectOption(rl, 'Which feature?', labels)
    const feature = features[labels.indexOf(chosen)]

    let env: string
    if (feature.envs.length === 1) {
      env = feature.envs[0]
      uiLine()
      console.log(`${dim('Environment:')} ${ansiC('bold', env)}`)
    } else {
      env = await selectOption(rl, 'Which environment?', feature.envs)
    }

    const autoHealChoice = await selectOption(
      rl,
      'Auto-heal on test failure?',
      ['No (default)', 'Yes — Claude Code', 'Yes — Codex'],
    )
    const autoHeal: { agent: HealAgent | null; sessionMode: HealSessionMode } = {
      agent: null,
      sessionMode: flags.healSession,
    }
    if (autoHealChoice.includes('Claude')) autoHeal.agent = 'claude'
    else if (autoHealChoice.includes('Codex')) autoHeal.agent = 'codex'

    if (autoHeal.agent !== null && !isAgentCliAvailable(autoHeal.agent)) {
      uiLine()
      fail(`\`${autoHeal.agent}\` CLI not found on PATH.`)
      process.exit(1)
    }

    if (!checkRepos(feature, env)) {
      uiLine()
      fail('Please clone the missing repos and try again.')
      process.exit(1)
    }
    ok('All repos present.')

    const envSetsDir = path.join(feature.featureDir, 'envsets')
    if (fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) {
      const envSets = fs
        .readdirSync(envSetsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
      const chosenSet = envSets.includes(env)
        ? env
        : envSets.length === 1
          ? envSets[0]
          : await selectOption(rl, `Which env set for ${feature.name}?`, envSets)
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

    // ── Allocate run dir + boot orchestrator
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    pruneRuns(LOGS_DIR)
    const runId = generateRunId()
    const runDir = runDirFor(LOGS_DIR, runId)
    fs.mkdirSync(runDir, { recursive: true })

    const runPaths = buildRunPaths(runDir)
    const runnerLog = new RunnerLog(runPaths.runnerLogPath)
    setActiveRunnerLog(runnerLog)
    runnerLog.info(`Run started: feature=${feature.name} runId=${runId}`)

    const launcher = new ForegroundLauncher({ ptyFactory: realPtyFactory() })
    orchestrator = new RunOrchestrator({
      feature,
      env,
      runId,
      runDir,
      ptyFactory: realPtyFactory(),
      runnerLog,
    })
    // NOTE: the CLI shim drives Playwright + heal-agent itself (below) via the
    // legacy `runPlaywright` / `spawnHealAgent` helpers so the existing
    // foreground-pty UX stays intact. The web-server entry point uses
    // `orchestrator.runFullCycle()` instead, which drives the same lifecycle
    // through node-pty + the new heal-cycle state machine.

    uiLine()
    info(`Starting run ${ansiC('bold', runId)} → ${ansiPath(runDir)}`)

    orchestrator.on('service-output', ({ service, chunk }) => {
      // Mirror service output to the user's terminal so they see something
      // while the web UI is still being built.
      process.stdout.write(`[${service.name}] ${chunk}`)
    })
    orchestrator.on('signal-detected', ({ kind, body }) => {
      if (kind === 'restart' || kind === 'rerun') {
        try {
          appendJournalIteration({
            signal: kind === 'restart' ? '.restart' : '.rerun',
            hypothesis: typeof body.hypothesis === 'string' ? body.hypothesis : undefined,
            filesChanged: Array.isArray(body.filesChanged)
              ? body.filesChanged.filter((f): f is string => typeof f === 'string')
              : undefined,
            fixDescription: typeof body.fixDescription === 'string' ? body.fixDescription : undefined,
            runId,
            manifestPath: orchestrator!.paths.manifestPath,
            summaryPath: orchestrator!.paths.summaryPath,
          })
        } catch { /* journal write is best-effort */ }
      }
    })

    await orchestrator.start()

    uiLine()
    info(`Running Playwright tests${flags.headed ? dim(' (headed)') : ''}...`)
    const exitCode = await runPlaywright(
      feature.featureDir,
      flags.headed,
      orchestrator.paths.summaryPath,
    )
    orchestrator.setStatus(exitCode === 0 ? 'passed' : 'failed')

    if (exitCode !== 0 && autoHeal.agent) {
      orchestrator.setStatus('healing')
      orchestrator.noteHealCycle()
      // Resolve where Playwright MCP should write its artifacts for this
      // heal cycle. When exactly one test failed, scope by slug; otherwise
      // share a per-run dir.
      const summaryRaw = (() => {
        try { return JSON.parse(fs.readFileSync(orchestrator.paths.summaryPath, 'utf-8')) }
        catch { return {} }
      })()
      const failedSlugs = Array.isArray(summaryRaw?.failed)
        ? (summaryRaw.failed as Array<{ name?: unknown }>)
            .map((f) => (typeof f?.name === 'string' ? f.name : ''))
            .filter((n) => n.length > 0)
        : []
      const mcpTarget = resolveMcpOutputDir({ runDir, failedSlugs })
      ensureMcpOutputDir(mcpTarget.dir)
      try {
        await spawnHealAgent({
          agent: autoHeal.agent,
          sessionMode: autoHeal.sessionMode,
          cycle: 0,
          mcpOutputDir: mcpTarget.dir,
        })
      } catch (err) {
        warn(`Auto-heal failed: ${(err as Error).message}`)
      }
    }

    await orchestrator.stop(exitCode === 0 ? 'passed' : 'failed')
    void launcher
  } finally {
    await cleanup()
  }
}

runAsScript(module, main)

// Re-exports used by tests / legacy callers — kept so downstream imports of
// `runner.ts` continue to compile during the transition.
export { failureSignature, RunOrchestrator }
