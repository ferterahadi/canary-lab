import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  openItermTabs,
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
}

const HEAL_PROMPT_FILE = path.join(LOGS_DIR, '.heal-prompt.txt')
const HEAL_SCRIPT_FILE = path.join(LOGS_DIR, '.heal-agent.sh')
const HEAL_DONE_FILE = path.join(LOGS_DIR, '.heal-agent-done')
const HEAL_FORMATTER_FILE = path.join(__dirname, 'heal-formatter.js')
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

function stripFrontmatter(content: string): string {
  // Strip a leading `---\n...\n---\n` block if present.
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end === -1) return content
  const after = content.indexOf('\n', end + 4)
  return after === -1 ? '' : content.slice(after + 1)
}

function loadPrompt(agent: HealAgent): string {
  const p = promptPathFor(agent)
  if (!fs.existsSync(p)) {
    throw new Error(
      `Heal prompt not found at ${p}. Run \`canary-lab upgrade\` to install it.`,
    )
  }
  return stripFrontmatter(fs.readFileSync(p, 'utf-8')).trim()
}

function buildAgentCommand(
  agent: HealAgent,
  sessionMode: HealSessionMode,
  cycle: number,
  promptFile: string,
): string {
  const useResume = sessionMode === 'resume' && cycle > 0
  const promptSub = `"$(cat ${JSON.stringify(promptFile)})"`

  if (agent === 'claude') {
    // --dangerously-skip-permissions: required for headless tool use; the heal
    // agent runs unattended and cannot answer permission prompts.
    // --output-format=stream-json + our formatter: so the tab shows live
    // progress instead of sitting blank for 1-5 minutes.
    const base =
      '--dangerously-skip-permissions --output-format=stream-json --verbose -p'
    const flags = useResume ? `--continue ${base}` : base
    const formatter = `node ${JSON.stringify(HEAL_FORMATTER_FILE)}`
    return `claude ${flags} ${promptSub} | ${formatter}`
  }

  // Codex exec runs autonomously by default. Resume semantics vary across
  // Codex versions; fall back to a fresh exec if the resume attempt errors.
  // --skip-git-repo-check: scaffold may not be a git repo yet.
  // --full-auto: required for the heal agent to write files (server edits,
  // diagnosis-journal.json, .rerun/.restart). Without it, codex runs in a
  // read-only sandbox and silently fails file writes.
  // --json + formatter: raw codex output is very verbose; the formatter emits
  // a compact timeline of commands, file changes, and messages.
  const codexBase = '--skip-git-repo-check --full-auto --json'
  const formatter = `node ${JSON.stringify(CODEX_FORMATTER_FILE)}`
  if (useResume) {
    return `(codex exec resume ${codexBase} ${promptSub} || codex exec ${codexBase} ${promptSub}) | ${formatter}`
  }
  return `codex exec ${codexBase} ${promptSub} | ${formatter}`
}

function writeHealScript(agentCommand: string): void {
  const script = `#!/bin/bash
set +e
echo "[canary-lab] starting heal agent — streaming progress below."
echo "[canary-lab] agent will write logs/.rerun (or logs/.restart) when done."
echo ""
${agentCommand}
status=\${PIPESTATUS[0]}
echo "$status" > ${JSON.stringify(HEAL_DONE_FILE)}
echo ""
echo "[canary-lab] agent exited with status $status"
echo "[canary-lab] you can close this tab."
`
  fs.writeFileSync(HEAL_SCRIPT_FILE, script, { mode: 0o755 })
}

const previousHealAgentIds: string[] = []

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
    if (previousHealAgentIds.length > 0) {
      closeItermSessionsByIds(previousHealAgentIds.splice(0))
    }
    closeItermSessionsByPrefix(['heal-agent-'])
    const ids = openItermTabs([tab], label)
    previousHealAgentIds.push(...ids)
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

  const prompt = loadPrompt(opts.agent)
  fs.writeFileSync(HEAL_PROMPT_FILE, prompt)

  const agentCommand = buildAgentCommand(
    opts.agent,
    opts.sessionMode,
    opts.cycle,
    HEAL_PROMPT_FILE,
  )
  writeHealScript(agentCommand)

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
