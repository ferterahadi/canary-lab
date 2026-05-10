import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { buildHealAddendum } from './heal-prompt-builder'
import { buildRunPaths } from './run-paths'
import { renderPersonalWikiMap } from '../../../../shared/runtime/personal-wiki'

// Heal-agent command builders for the web-server orchestrator. The orchestrator
// runs claude / codex as a long-lived interactive REPL (no `-p`, no formatter
// pipe). The shell command produced here is just the binary + flags — the
// per-cycle prompt is written to the pty's stdin by `RunOrchestrator` after
// spawn, which lets users type into the same session for smooth interjects.

export type HealAgent = 'claude' | 'codex'

export function isAgentCliAvailable(agent: HealAgent): boolean {
  try {
    execFileSync('which', [agent], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HEAL_PROMPT_TEMPLATE_PATH = path.join(__dirname, '../../prompts/heal-agent.md')

function loadPromptTemplate(promptPath: string = HEAL_PROMPT_TEMPLATE_PATH): string {
  if (!fs.existsSync(promptPath)) {
    throw new Error(
      `Heal prompt template not found at ${promptPath}. Rebuild or reinstall canary-lab.`,
    )
  }
  return fs.readFileSync(promptPath, 'utf-8').trim()
}

function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}

// Build a transient `--mcp-config` argument for `claude`. Writes the MCP
// servers JSON (registering `@playwright/mcp` with `--output-dir <outputDir>`
// so the agent's browser snapshots land in the per-failure dir) to
// `configFilePath`, and returns `--mcp-config "<configFilePath>"`.
//
// Why a file and not inline JSON: current `claude` versions try to `open()`
// the value as a path before falling back to JSON parsing. A multi-hundred-
// byte JSON literal trips ENAMETOOLONG (PATH_MAX is ~1024 on macOS) and the
// agent never starts. A file path always works.
export function buildClaudeMcpConfigArg(outputDir: string, configFilePath: string): string {
  const cfg = {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--output-dir', outputDir],
      },
    },
  }
  fs.mkdirSync(path.dirname(configFilePath), { recursive: true })
  fs.writeFileSync(configFilePath, JSON.stringify(cfg, null, 2))
  return `--mcp-config ${JSON.stringify(configFilePath)}`
}

export interface AgentSpawnArgs {
  /** Pin claude's session UUID. Lets the orchestrator know the id without
   *  parsing init frames; ignored by codex (no equivalent flag). */
  sessionId?: string
  /** Where Playwright MCP should write artifacts. When set, claude is spawned
   *  with `--mcp-config` pointing at a JSON file we write to `mcpConfigFile`
   *  describing the playwright server with `--output-dir <mcpOutputDir>`.
   *  When omitted, no `--mcp-config` flag is added. */
  mcpOutputDir?: string
  /** Path the MCP config JSON should be written to. Required when
   *  `mcpOutputDir` is set. Conventionally `<runDir>/mcp-config.json`. */
  mcpConfigFile?: string
  /** Path to the cycle-1 heal prompt. When set, the spawn command appends
   *  `"@<promptFile>"` as a positional argument so claude reads the file
   *  and processes its content as the first user message — bypassing the
   *  REPL's input editor entirely. The orchestrator writes the prompt
   *  body to this path BEFORE spawning. */
  promptFile?: string
}

/**
 * Build the spawn command for a long-lived REPL. Returns just the binary +
 * flags — the orchestrator writes the per-cycle prompt to the pty's stdin
 * after spawn, so this command does not include any `-p`/positional prompt.
 *
 * Permissions are intentionally NOT bypassed here. With the headless `-p`
 * flow we passed `--dangerously-skip-permissions` (resp. codex `--full-auto`)
 * because there was no human to approve tool calls. In REPL mode the user
 * is right there in the pane and can approve / deny each tool — bypassing
 * also hides MCP auth prompts the user needs to see.
 *
 * - claude: `claude [--session-id <uuid>] [--mcp-config <path>]`
 * - codex:  `codex`
 */
export function buildAgentSpawnCommand(agent: HealAgent, args: AgentSpawnArgs = {}): string {
  // Positional `@<promptFile>` arg — claude reads the file at startup and
  // processes its content as the first user message. This sidesteps the
  // REPL's input editor entirely, which doesn't reliably submit multi-line
  // content sent via stdin paste. Writing the prompt body to disk first is
  // the orchestrator's responsibility.
  //
  // CRITICAL: the standalone `--` separator before the positional. Without
  // it, claude's variadic `--mcp-config <configs...>` would greedily slurp
  // the positional as another config file path (the file then doesn't
  // exist as JSON, claude reports `MCP config file not found`, and the
  // REPL exits before processing any prompt). `--` is the POSIX
  // end-of-options marker — commander.js (claude / codex's argv parser)
  // honors it.
  const promptArg = args.promptFile ? ` -- ${JSON.stringify(`@${args.promptFile}`)}` : ''

  if (agent === 'claude') {
    const sid = args.sessionId ? ` --session-id ${JSON.stringify(args.sessionId)}` : ''
    let mcp = ''
    if (args.mcpOutputDir) {
      if (!args.mcpConfigFile) {
        throw new Error('buildAgentSpawnCommand: mcpConfigFile is required when mcpOutputDir is set')
      }
      mcp = ` ${buildClaudeMcpConfigArg(args.mcpOutputDir, args.mcpConfigFile)}`
    }
    // No `--dangerously-skip-permissions` — REPL hands tool approval back
    // to the user.
    return `claude${sid}${mcp}${promptArg}`
  }
  // codex interactive REPL. No `--full-auto`: tool
  // approvals stay interactive in the pane. Codex has no `--session-id`
  // analogue; the orchestrator doesn't track a session id for codex (the
  // REPL stays alive across cycles so we never need to resume mid-run).
  // Codex accepts a positional prompt the same way as claude.
  return `codex${promptArg}`
}

/**
 * Pick which agent CLI to use for healing in the web orchestrator.
 *
 * - When `envOverride` is `'claude'` or `'codex'`, that exact agent is
 *   required — returns null when its CLI isn't on PATH.
 * - When `envOverride` is set to anything else (typo guard), returns null.
 * - When `envOverride` is unset, auto-detects: prefers claude when present,
 *   falls back to codex, returns null when neither is on PATH.
 */
export function pickAvailableHealAgent(
  envOverride: string | undefined = process.env.CANARY_LAB_HEAL_AGENT,
): HealAgent | null {
  if (envOverride === 'claude' || envOverride === 'codex') {
    return isAgentCliAvailable(envOverride) ? envOverride : null
  }
  if (envOverride !== undefined && envOverride !== '') {
    // Set but unrecognised — refuse to silently fall through, so a typoed
    // value like `clauude` doesn't pretend to work.
    return null
  }
  if (isAgentCliAvailable('claude')) return 'claude'
  if (isAgentCliAvailable('codex')) return 'codex'
  return null
}

export interface OrchestratorAutoHealFactoryOptions {
  agent: HealAgent
  /** Project root used to render repo-relative run paths in the prompt. */
  projectRoot: string
  /** Per-run dir — the prompt file is written under <runDir>/heal-prompt.md. */
  runDir: string
  /** Optional local personal wiki folder for distilled cross-session context. */
  personalWikiPath?: string | null
  /** Override prompt template path resolution (tests). */
  promptPath?: string
}

/**
 * Build a prompt-rendering function compatible with `AutoHealConfig.buildCyclePrompt`.
 * Returns the raw prompt text to write into the REPL's stdin — the orchestrator
 * pty.write()s it. The text is also persisted to `<runDir>/heal-prompt.md`
 * for debugging/forensics.
 */
export function buildOrchestratorHealPrompt(
  opts: OrchestratorAutoHealFactoryOptions,
): (args: { cycle: number; outputDir: string; userGuidance?: string }) => string {
  // Eagerly load the packaged template so a missing asset surfaces at config
  // time, not on the first heal cycle.
  const promptTemplate = loadPromptTemplate(opts.promptPath)
  const promptFile = path.join(opts.runDir, 'heal-prompt.md')
  const paths = buildRunPaths(opts.runDir)
  const runDirRel = path.relative(opts.projectRoot, opts.runDir) || opts.runDir
  const basePrompt = renderPromptTemplate(promptTemplate, {
    runDir: opts.runDir,
    runDirRel,
    healIndexPath: paths.healIndexPath,
    summaryPath: paths.summaryPath,
    failedDir: paths.failedDir,
    journalPath: paths.diagnosisJournalPath,
    restartSignal: paths.restartSignal,
    rerunSignal: paths.rerunSignal,
    personalWikiMap: renderPersonalWikiMap(opts.personalWikiPath),
  })

  return ({ cycle, userGuidance }) => {
    const stateAddendum = buildHealAddendum({
      cycle: cycle + 1,
      summaryPath: paths.summaryPath,
      journalPath: paths.diagnosisJournalPath,
    })
    const guidance = userGuidance?.trim()
      ? `User guidance for this restarted heal cycle:\n\n${userGuidance.trim()}`
      : ''
    const fullPrompt = [basePrompt, stateAddendum, guidance].filter(Boolean).join('\n\n')
    fs.mkdirSync(path.dirname(promptFile), { recursive: true })
    fs.writeFileSync(promptFile, fullPrompt)
    return fullPrompt
  }
}
