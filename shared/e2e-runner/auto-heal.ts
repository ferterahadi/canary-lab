import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { ForegroundLauncher } from '../launcher/foreground-pty'
import {
  ROOT,
  LOGS_DIR,
  RERUN_SIGNAL,
  RESTART_SIGNAL,
} from './paths'
import type { BenchmarkMode } from './context-assembler'
import { buildHealAddendum } from './heal-prompt-builder'

export type HealAgent = 'claude' | 'codex'
export type HealSessionMode = 'resume' | 'new'
export type HealResult = 'signal' | 'agent_exited_no_signal' | 'timeout'

export interface SpawnHealAgentOptions {
  agent: HealAgent
  sessionMode: HealSessionMode
  cycle: number
  promptAddendum?: string
  benchmarkUsageFile?: string
  benchmarkMode?: BenchmarkMode
  agentCwd?: string
  baselinePlaywrightLogPath?: string
  baselineSignalFilePath?: string
  baselineRepoPaths?: string[]
  basePromptOverride?: string
  // Test injection points.
  launcher?: ForegroundLauncher
  out?: NodeJS.WritableStream
  pollIntervalMs?: number
  timeoutMs?: number
}

export function buildStartupFailurePrompt(args: {
  serviceName: string
  healthUrl: string
  logPath: string
  repoPath: string
  restartSignalPath: string
}): string {
  return [
    `Service \`${args.serviceName}\` failed its startup health check at \`${args.healthUrl}\`. The process is still running but not responding as expected — the runner hasn't reached Playwright yet.`,
    '',
    `Read the service log at \`${args.logPath}\` — focus on errors, stack traces, or the "listening on" message that never arrived. The service repo is at \`${args.repoPath}\`.`,
    '',
    'Diagnose why the service won\'t pass its health check. Fix the repo code — never canary-lab test/config. Do not kill the service process; the runner will restart it after you signal done.',
    '',
    `When you've committed a fix, write a single JSON line to \`${args.restartSignalPath}\`: \`{"hypothesis":"…","filesChanged":["<absolute path>"]}\`. The \`filesChanged\` list lets the runner restart only the affected service(s). Exit after writing the signal — the runner is polling.`,
  ].join('\n')
}

export function buildBaselineVanillaPrompt(args: {
  playwrightLogPath: string
  signalFilePath: string
  repoPaths?: string[]
}): string {
  const reposLine = args.repoPaths && args.repoPaths.length > 0
    ? `\n\nRepositories you may need to edit (use absolute paths):\n${args.repoPaths.map((p) => `- ${p}`).join('\n')}`
    : ''
  return [
    `Playwright tests just failed. The raw test output is at \`${args.playwrightLogPath}\` — read that file to see which tests failed and why.`,
    '',
    'Figure out where the bug is in the codebase, fix it, and exit. Assume the tests are correct; fix the application/service code to match.',
    `${reposLine}`,
    '',
    `Before you exit, write a file at \`${args.signalFilePath}\` (any content — a single line is fine). The test runner polls for this file and will rebuild services and re-run the tests when it appears.`,
  ].join('\n')
}

const HEAL_PROMPT_FILE = path.join(LOGS_DIR, '.heal-prompt.txt')
const HEAL_DONE_FILE = path.join(LOGS_DIR, '.heal-agent-done')
const CLAUDE_FORMATTER_FILE = path.join(__dirname, 'claude-formatter.js')
const CODEX_FORMATTER_FILE = path.join(__dirname, 'codex-formatter.js')
const AGENT_TIMEOUT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 1000
const POST_EXIT_GRACE_MS = 5000

export function isAgentCliAvailable(agent: HealAgent): boolean {
  try {
    execFileSync('which', [agent], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HEAL_PROMPT_START = '<!-- heal-prompt:start -->'
const HEAL_PROMPT_END = '<!-- heal-prompt:end -->'

function promptPathFor(agent: HealAgent): string {
  return agent === 'claude'
    ? path.join(ROOT, 'CLAUDE.md')
    : path.join(ROOT, 'AGENTS.md')
}

export function extractHealPrompt(content: string): string | null {
  const startIdx = content.indexOf(HEAL_PROMPT_START)
  if (startIdx === -1) return null
  const endIdx = content.indexOf(HEAL_PROMPT_END, startIdx + HEAL_PROMPT_START.length)
  if (endIdx === -1) return null
  return content.slice(startIdx + HEAL_PROMPT_START.length, endIdx).trim()
}

export function loadPrompt(agent: HealAgent, promptPath: string = promptPathFor(agent)): string {
  if (!fs.existsSync(promptPath)) {
    throw new Error(
      `Heal prompt source not found at ${promptPath}. Run \`canary-lab upgrade\` to install it.`,
    )
  }
  const content = fs.readFileSync(promptPath, 'utf-8')
  const prompt = extractHealPrompt(content)
  if (!prompt) {
    throw new Error(
      `Heal prompt markers (${HEAL_PROMPT_START} / ${HEAL_PROMPT_END}) not found in ${promptPath}. Run \`canary-lab upgrade\` to refresh the managed block.`,
    )
  }
  return prompt
}

export function buildAgentCommand(
  agent: HealAgent,
  sessionMode: HealSessionMode,
  cycle: number,
  promptFile: string,
): string {
  const useResume = sessionMode === 'resume' && cycle > 0
  const promptSub = `"$(cat ${JSON.stringify(promptFile)})"`

  if (agent === 'claude') {
    const base = `--dangerously-skip-permissions --output-format=stream-json --verbose -p`
    const flags = useResume ? `--continue ${base}` : base
    const formatter = `node ${JSON.stringify(CLAUDE_FORMATTER_FILE)}`
    return `claude ${flags} ${promptSub} | ${formatter}`
  }

  const codexBase = `--skip-git-repo-check --full-auto --json`
  const formatter = `node ${JSON.stringify(CODEX_FORMATTER_FILE)}`
  if (useResume) {
    return `(codex exec resume ${codexBase} ${promptSub} || codex exec ${codexBase} ${promptSub}) | ${formatter}`
  }
  return `codex exec ${codexBase} ${promptSub} | ${formatter}`
}

function unlinkSafe(p: string): void {
  try { fs.unlinkSync(p) } catch { /* ignore */ }
}

async function waitForResult(opts: {
  pollMs: number
  timeoutMs: number
}): Promise<HealResult> {
  const deadline = Date.now() + opts.timeoutMs
  let agentExitedAt: number | null = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs))
    if (fs.existsSync(RERUN_SIGNAL) || fs.existsSync(RESTART_SIGNAL)) {
      return 'signal'
    }
    if (agentExitedAt === null && fs.existsSync(HEAL_DONE_FILE)) {
      agentExitedAt = Date.now()
    }
    if (agentExitedAt !== null && Date.now() - agentExitedAt >= POST_EXIT_GRACE_MS) {
      return 'agent_exited_no_signal'
    }
  }
  return 'timeout'
}

// Spawns the heal agent as a foreground pty in the same terminal the runner is
// running in. Output is mirrored to stdout (so the user sees what the agent is
// doing) and the exit code is recorded in HEAL_DONE_FILE. The agent writes its
// signal to logs/.restart or logs/.rerun when done; this function polls.
export async function spawnHealAgent(
  opts: SpawnHealAgentOptions,
): Promise<HealResult> {
  fs.mkdirSync(LOGS_DIR, { recursive: true })

  const basePrompt = opts.benchmarkMode === 'baseline'
    ? buildBaselineVanillaPrompt({
        playwrightLogPath: opts.baselinePlaywrightLogPath ?? path.join(LOGS_DIR, 'playwright-stdout.log'),
        signalFilePath: opts.baselineSignalFilePath ?? RESTART_SIGNAL,
        repoPaths: opts.baselineRepoPaths,
      })
    : opts.basePromptOverride ?? loadPrompt(opts.agent)

  const stateAddendum =
    opts.benchmarkMode !== 'baseline' && !opts.basePromptOverride
      ? buildHealAddendum({ cycle: opts.cycle + 1 })
      : ''

  const prompt = [
    basePrompt,
    stateAddendum,
    opts.promptAddendum?.trim(),
  ].filter(Boolean).join('\n\n')
  fs.writeFileSync(HEAL_PROMPT_FILE, prompt)

  unlinkSafe(HEAL_DONE_FILE)

  const agentCommand = buildAgentCommand(
    opts.agent,
    opts.sessionMode,
    opts.cycle,
    HEAL_PROMPT_FILE,
  )

  // Wrap so we capture exit status and so a benchmark usage file can be
  // pre-created if requested.
  const usageEnv = opts.benchmarkUsageFile
    ? `CANARY_LAB_BENCHMARK_USAGE_FILE=${JSON.stringify(opts.benchmarkUsageFile)} `
    : ''
  const usageInit = opts.benchmarkUsageFile
    ? `mkdir -p ${JSON.stringify(path.dirname(opts.benchmarkUsageFile))} && : > ${JSON.stringify(opts.benchmarkUsageFile)} && `
    : ''
  const wrapped = `${usageInit}${usageEnv}${agentCommand}; status=$?; echo "$status" > ${JSON.stringify(HEAL_DONE_FILE)}`

  const launcher = opts.launcher ?? new ForegroundLauncher({ out: opts.out })
  launcher.open({
    name: `heal-agent-${opts.agent}-${opts.cycle + 1}`,
    command: wrapped,
    cwd: opts.agentCwd ?? ROOT,
  })

  return waitForResult({
    pollMs: opts.pollIntervalMs ?? POLL_INTERVAL_MS,
    timeoutMs: opts.timeoutMs ?? AGENT_TIMEOUT_MS,
  })
}

export function failureSignature(failed: unknown): string {
  if (!Array.isArray(failed)) return ''
  const slugs = failed
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null && 'name' in entry &&
          typeof (entry as { name: unknown }).name === 'string'
          ? (entry as { name: string }).name
          : '',
    )
    .filter((s) => s.length > 0)
    .sort()
  return slugs.join('|')
}

// Legacy no-op kept for back-compat with runner.ts; foreground pty agents exit
// with their parent process so there's no separate tab to close.
export function closeLastHealAgentTab(): void {
  /* no-op in foreground pty mode */
}
