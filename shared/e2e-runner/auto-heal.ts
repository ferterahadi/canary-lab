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

function promptPathFor(agent: HealAgent): string {
  return agent === 'claude'
    ? path.join(ROOT, '.claude', 'skills', 'heal-loop.md')
    : path.join(ROOT, '.codex', 'heal-loop.md')
}

export function stripFrontmatter(content: string): string {
  // Strip a leading `---\n...\n---\n` block if present.
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end === -1) return content
  const after = content.indexOf('\n', end + 4)
  return after === -1 ? '' : content.slice(after + 1)
}

export function loadPrompt(agent: HealAgent, promptPath: string = promptPathFor(agent)): string {
  const p = promptPath
  if (!fs.existsSync(p)) {
    throw new Error(
      `Heal prompt not found at ${p}. Run \`canary-lab upgrade\` to install it.`,
    )
  }
  return stripFrontmatter(fs.readFileSync(p, 'utf-8')).trim()
}

export function healAgentBanner(agent: HealAgent): string {
  return `[canary-lab] heal agent — ${agent} (using your CLI profile defaults for model + reasoning)`
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
  // diagnosis-journal.json, .rerun/.restart). Without it, codex runs in a
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
  banner: string,
  benchmarkUsageFile?: string,
): void {
  const benchmarkEnv = benchmarkUsageFile
    ? `export CANARY_LAB_BENCHMARK_USAGE_FILE=${JSON.stringify(benchmarkUsageFile)}\n`
    : ''
  const script = `#!/bin/bash
set +e
echo ${JSON.stringify(banner)}
echo "[canary-lab] starting heal agent — streaming progress below."
echo "[canary-lab] agent will write logs/.rerun (or logs/.restart) when done."
echo ""
${benchmarkEnv}${benchmarkEnv ? '\n' : ''}${benchmarkUsageFile ? `mkdir -p ${JSON.stringify(path.dirname(benchmarkUsageFile))}\n` : ''}${benchmarkUsageFile ? `: > ${JSON.stringify(benchmarkUsageFile)}\n` : ''}${benchmarkUsageFile ? '\n' : ''}${agentCommand}
status=\${PIPESTATUS[0]}
echo "$status" > ${JSON.stringify(HEAL_DONE_FILE)}
echo ""
echo "[canary-lab] agent exited with status $status"
echo "[canary-lab] you can close this tab."
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
): void {
  const tab = {
    dir: ROOT,
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

  const prompt = [
    loadPrompt(opts.agent),
    opts.promptAddendum?.trim(),
  ].filter(Boolean).join('\n\n')
  fs.writeFileSync(HEAL_PROMPT_FILE, prompt)

  const agentCommand = buildAgentCommand(
    opts.agent,
    opts.sessionMode,
    opts.cycle,
    HEAL_PROMPT_FILE,
  )
  writeHealScript(agentCommand, healAgentBanner(opts.agent), opts.benchmarkUsageFile)

  unlinkSafe(HEAL_DONE_FILE)

  const tabCommand = `bash ${HEAL_SCRIPT_FILE}`
  openTab(opts.terminal, tabCommand, opts.cycle, opts.agent)

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
