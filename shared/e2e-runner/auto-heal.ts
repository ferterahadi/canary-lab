import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
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
  LOGS_DIR,
  RERUN_SIGNAL,
  RESTART_SIGNAL,
  ITERM_HEAL_SESSION_IDS_PATH,
} from './paths'
import type { BenchmarkMode } from './context-assembler'
import { buildHealAddendum } from './heal-prompt-builder'

export type HealAgent = 'claude' | 'codex'
export type HealSessionMode = 'resume' | 'new'
export type TerminalChoice = 'iTerm' | 'Terminal'
export type HealResult = 'signal' | 'agent_exited_no_signal' | 'timeout'

export interface SpawnHealAgentOptions {
  agent: HealAgent
  sessionMode: HealSessionMode
  cycle: number
  terminal: TerminalChoice
  promptAddendum?: string
  benchmarkUsageFile?: string
  benchmarkMode?: BenchmarkMode
  // Directory to spawn the agent tab in. Defaults to ROOT. Baseline uses a
  // sandbox outside the project so Claude Code / Codex don't auto-discover
  // `.claude/skills/*` or `CLAUDE.md` / `AGENTS.md` from the repo — those
  // would leak canary-lab methodology into a supposedly vanilla run.
  agentCwd?: string
  // Baseline-only overrides for absolute paths used inside the prompt (the
  // agent works from a sandbox cwd, so relative paths won't resolve).
  baselinePlaywrightLogPath?: string
  baselineSignalFilePath?: string
  baselineRepoPaths?: string[]
  // Replaces the base prompt (normally loaded from CLAUDE.md / AGENTS.md
  // heal-prompt markers). Used for startup-failure healing, which has a
  // different shape than Playwright-failure healing. Ignored when
  // benchmarkMode === 'baseline' (baseline builds its own prompt).
  basePromptOverride?: string
}

// Startup-failure prompt, built at runtime when a service fails its initial
// health check and the user chooses to auto-heal. The Playwright-failure
// heal-prompt in CLAUDE.md / AGENTS.md doesn't fit this case — the agent
// needs to read the service log, not logs/heal-index.md.
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

// Baseline benchmark mode runs as if canary-lab didn't exist: no heal-loop
// skill, no journal, no log enrichment guidance. The agent sees only the raw
// Playwright stdout (what a developer running `npx playwright test` by hand
// would see) and figures everything else out itself. We still reuse the
// `.rerun` / `.restart` signal files so the runner's watch loop keeps working
// — that's pure infra, not methodology, and it's cheap to describe inline.
//
// The prompt is built at runtime because baseline now sandboxes the agent cwd
// outside the project — the agent needs absolute paths to reach the log and
// the signal-file location inside the real workspace.
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
const HEAL_SCRIPT_FILE = path.join(LOGS_DIR, '.heal-agent.sh')
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

export function healAgentBanner(agent: HealAgent): string {
  return `[canary-lab] heal agent — ${agent} (using your CLI profile defaults for model + reasoning)`
}

// Bash ANSI-C quoted variant — used inside the generated .heal-agent.sh so the
// tab shows a colored banner. Bash decodes \e, \033 inside $'...'; JSON escapes
// like \u001b would NOT be decoded, so we avoid raw escape bytes here.
function healAgentBannerBash(agent: HealAgent): string {
  return `$'\\e[1;36m▶ canary-lab\\e[0m  heal agent — \\e[1m${agent}\\e[0m \\e[2m(using your CLI profile defaults for model + reasoning)\\e[0m'`
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
    // Model + reasoning effort are inherited from the operator's Claude CLI
    // profile (~/.claude settings) — we don't override here.
    // --dangerously-skip-permissions: required for headless tool use; the heal
    // agent runs unattended and cannot answer permission prompts.
    // --output-format=stream-json + our formatter: so the tab shows live
    // progress instead of sitting blank for 1-5 minutes.
    const base = `--dangerously-skip-permissions --output-format=stream-json --verbose -p`
    const flags = useResume ? `--continue ${base}` : base
    const formatter = `node ${JSON.stringify(CLAUDE_FORMATTER_FILE)}`
    return `claude ${flags} ${promptSub} | ${formatter}`
  }

  // Codex exec runs autonomously by default. Resume semantics vary across
  // Codex versions; fall back to a fresh exec if the resume attempt errors.
  // Model + reasoning effort are inherited from the operator's Codex CLI
  // profile (~/.codex/config.toml) — we don't override here.
  // --skip-git-repo-check: scaffold may not be a git repo yet.
  // --full-auto: required for the heal agent to write files (server edits,
  // diagnosis-journal.md, .rerun/.restart). Without it, codex runs in a
  // read-only sandbox and silently fails file writes.
  // --json + formatter: raw codex output is very verbose; the formatter emits
  // a compact timeline of commands, file changes, and messages.
  const codexBase = `--skip-git-repo-check --full-auto --json`
  const formatter = `node ${JSON.stringify(CODEX_FORMATTER_FILE)}`
  if (useResume) {
    return `(codex exec resume ${codexBase} ${promptSub} || codex exec ${codexBase} ${promptSub}) | ${formatter}`
  }
  return `codex exec ${codexBase} ${promptSub} | ${formatter}`
}

function writeHealScript(
  agentCommand: string,
  agent: HealAgent,
  benchmarkUsageFile?: string,
): void {
  const benchmarkEnv = benchmarkUsageFile
    ? `export CANARY_LAB_BENCHMARK_USAGE_FILE=${JSON.stringify(benchmarkUsageFile)}\n`
    : ''
  // Bash ANSI-C quoting ($'...') decodes \e, \033. We prefer this over
  // printf '%b' with a JSON-stringified banner because JSON encodes ESC as
  // \uXXXX which printf %b does NOT interpret.
  const banner = healAgentBannerBash(agent)
  const script = `#!/bin/bash
set +e
echo ${banner}
echo $'\\e[2m›\\e[0m starting heal agent — streaming progress below.'
echo $'\\e[2m›\\e[0m agent will write \\e[36mlogs/.rerun\\e[0m (or \\e[36mlogs/.restart\\e[0m) when done.'
echo ""
${benchmarkEnv}${benchmarkEnv ? '\n' : ''}${benchmarkUsageFile ? `mkdir -p ${JSON.stringify(path.dirname(benchmarkUsageFile))}\n` : ''}${benchmarkUsageFile ? `: > ${JSON.stringify(benchmarkUsageFile)}\n` : ''}${benchmarkUsageFile ? '\n' : ''}${agentCommand}
status=\${PIPESTATUS[0]}
echo "$status" > ${JSON.stringify(HEAL_DONE_FILE)}
echo ""
if [ "$status" = "0" ]; then
  echo $'\\e[32m✓\\e[0m agent exited with status '"$status"
else
  echo $'\\e[31m✗\\e[0m agent exited with status '"$status"
fi
echo $'\\e[2mYou can close this tab.\\e[0m'
`
  fs.writeFileSync(HEAL_SCRIPT_FILE, script, { mode: 0o755 })
}

function loadHealIds(): string[] {
  try {
    const raw = fs.readFileSync(ITERM_HEAL_SESSION_IDS_PATH, 'utf-8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveHealIds(ids: string[]): void {
  try {
    fs.mkdirSync(path.dirname(ITERM_HEAL_SESSION_IDS_PATH), { recursive: true })
    fs.writeFileSync(ITERM_HEAL_SESSION_IDS_PATH, JSON.stringify(ids, null, 2))
  } catch {
    /* non-fatal */
  }
}

const previousHealAgentIds: string[] = loadHealIds()

export function closeLastHealAgentTab(): void {
  if (previousHealAgentIds.length === 0) return
  try {
    closeItermSessionsByIds(previousHealAgentIds.splice(0))
  } finally {
    saveHealIds(previousHealAgentIds)
  }
}

function openTab(
  terminal: TerminalChoice,
  command: string,
  cycle: number,
  agent: HealAgent,
  cwd: string = ROOT,
): void {
  const tab = {
    dir: cwd,
    command,
    name: `heal-agent-${agent}-${cycle + 1}`,
  }
  const label = `\n  Opening ${terminal} tab for ${agent} heal agent (cycle ${cycle + 1})...`
  if (terminal === 'iTerm') {
    // Prior heal agent has already exited by the time we get here; reusing
    // its tab preserves scrollback (useful for debugging the heal flow) and
    // avoids the close+open churn.
    if (
      previousHealAgentIds.length === 1 &&
      reuseItermTabs(previousHealAgentIds, [tab], label)
    ) {
      return
    }
    if (previousHealAgentIds.length > 0) {
      closeItermSessionsByIds(previousHealAgentIds.splice(0))
    }
    closeItermSessionsByPrefix(['heal-agent-'])
    const ids = openItermTabs([tab], label)
    previousHealAgentIds.push(...ids)
    saveHealIds(previousHealAgentIds)
  } else {
    closeTerminalTabsByPrefix(['heal-agent-'])
    openTerminalTabs([tab], label)
  }
}

function unlinkSafe(p: string): void {
  try {
    fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
}

async function waitForResult(): Promise<HealResult> {
  const deadline = Date.now() + AGENT_TIMEOUT_MS
  let agentExitedAt: number | null = null

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    if (fs.existsSync(RERUN_SIGNAL) || fs.existsSync(RESTART_SIGNAL)) {
      return 'signal'
    }

    if (agentExitedAt === null && fs.existsSync(HEAL_DONE_FILE)) {
      agentExitedAt = Date.now()
    }

    if (
      agentExitedAt !== null &&
      Date.now() - agentExitedAt >= POST_EXIT_GRACE_MS
    ) {
      return 'agent_exited_no_signal'
    }
  }

  return 'timeout'
}

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

  // State-aware addendum: cycle number, failing slugs, forbid-spec rule, and
  // journal guidance conditional on whether a journal exists. Skipped for
  // baseline (which stays harness-free) and for startup-failure healing
  // (`basePromptOverride`) where the shape is different.
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

  const agentCommand = buildAgentCommand(
    opts.agent,
    opts.sessionMode,
    opts.cycle,
    HEAL_PROMPT_FILE,
  )
  writeHealScript(agentCommand, opts.agent, opts.benchmarkUsageFile)

  unlinkSafe(HEAL_DONE_FILE)

  const tabCommand = `bash ${HEAL_SCRIPT_FILE}`
  openTab(opts.terminal, tabCommand, opts.cycle, opts.agent, opts.agentCwd)

  return waitForResult()
}

export function failureSignature(failed: unknown): string {
  if (!Array.isArray(failed)) return ''
  const slugs = failed
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' &&
            entry !== null &&
            'name' in entry &&
            typeof (entry as { name: unknown }).name === 'string'
          ? (entry as { name: string }).name
          : '',
    )
    .filter((s) => s.length > 0)
    .sort()
  return slugs.join('|')
}
