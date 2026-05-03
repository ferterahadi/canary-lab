import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { ROOT } from './paths'
import { buildHealAddendum } from './heal-prompt-builder'

// Heal-agent command builders for the web-server orchestrator. The legacy
// CLI test runner (`canary-lab run`) used to live next to this file and
// drove `spawnHealAgent` directly via a foreground pty. That path was
// removed in 0.11 — the web orchestrator now invokes these commands via
// `RunOrchestrator`'s pty factory and streams output through PaneBroker.

export type HealAgent = 'claude' | 'codex'
export type HealSessionMode = 'resume' | 'new'

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

function extractHealPrompt(content: string): string | null {
  const startIdx = content.indexOf(HEAL_PROMPT_START)
  if (startIdx === -1) return null
  const endIdx = content.indexOf(HEAL_PROMPT_END, startIdx + HEAL_PROMPT_START.length)
  if (endIdx === -1) return null
  return content.slice(startIdx + HEAL_PROMPT_START.length, endIdx).trim()
}

function loadPrompt(agent: HealAgent, promptPath: string = promptPathFor(agent)): string {
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

const CLAUDE_FORMATTER_FILE = path.join(__dirname, 'claude-formatter.js')
const CODEX_FORMATTER_FILE = path.join(__dirname, 'codex-formatter.js')

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

export interface BuildAgentCommandOptions {
  /** Pin the resumed session/thread id explicitly. When set, overrides the
   *  cycle-driven `useResume` heuristic and pins to a known conversation.
   *  Required for interject. */
  resumeSessionId?: string
}

export function buildAgentCommand(
  agent: HealAgent,
  sessionMode: HealSessionMode,
  cycle: number,
  promptFile: string,
  mcpOutputDir?: string,
  opts: BuildAgentCommandOptions = {},
): string {
  const explicitResume = !!opts.resumeSessionId
  const useResume = explicitResume || (sessionMode === 'resume' && cycle > 0)
  const promptSub = `"$(cat ${JSON.stringify(promptFile)})"`

  if (agent === 'claude') {
    // Order matters: `--mcp-config` is variadic and would otherwise greedily
    // swallow the positional prompt argument as another config file (which
    // claude then `open()`s, tripping ENAMETOOLONG). Putting `-p` LAST means
    // the prompt sits cleanly behind it and `--mcp-config` is terminated
    // by the next flag.
    const baseFlags = `--dangerously-skip-permissions --output-format=stream-json --verbose`
    // The MCP config file lives next to the prompt file (i.e. under the
    // per-run heal directory).
    const mcpConfigFile = path.join(path.dirname(promptFile), 'mcp-config.json')
    const mcpFlag = mcpOutputDir ? ` ${buildClaudeMcpConfigArg(mcpOutputDir, mcpConfigFile)}` : ''
    const trailing = `-p`
    let head: string
    if (explicitResume) {
      head = `--resume ${JSON.stringify(opts.resumeSessionId)} ${baseFlags}`
    } else if (useResume) {
      head = `--continue ${baseFlags}`
    } else {
      head = baseFlags
    }
    const flags = `${head}${mcpFlag} ${trailing}`
    const formatter = `node ${JSON.stringify(CLAUDE_FORMATTER_FILE)}`
    return `claude ${flags} ${promptSub} | ${formatter}`
  }

  const codexBase = `--skip-git-repo-check --full-auto --json`
  const formatter = `node ${JSON.stringify(CODEX_FORMATTER_FILE)}`
  if (explicitResume) {
    // Fail loudly when the pinned id is bad — falling back to a fresh
    // session would silently lose conversation context.
    return `codex exec resume ${JSON.stringify(opts.resumeSessionId)} ${codexBase} ${promptSub} | ${formatter}`
  }
  if (useResume) {
    return `(codex exec resume ${codexBase} ${promptSub} || codex exec ${codexBase} ${promptSub}) | ${formatter}`
  }
  return `codex exec ${codexBase} ${promptSub} | ${formatter}`
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
  /** Project root where CLAUDE.md / AGENTS.md lives. Used for prompt loading. */
  projectRoot: string
  /** Per-run dir — the prompt file is written under <runDir>/heal-prompt.md. */
  runDir: string
  /** Defaults to 'new'. `resume` is mostly useful for the CLI; web runs are short-lived. */
  sessionMode?: HealSessionMode
  /** Override prompt path resolution (tests). */
  promptPath?: string
}

/**
 * Build a `buildCommand` function compatible with `AutoHealConfig.buildCommand`.
 * This is what wires the rich `buildAgentCommand` (claude/codex CLI invocation
 * with prompt file, MCP config, formatter pipeline) into the web-server's
 * orchestrator. Throws synchronously when the prompt source is missing or
 * malformed so the caller can decide to disable heal silently rather than
 * advertising a broken loop.
 */
export function buildOrchestratorHealCommand(opts: OrchestratorAutoHealFactoryOptions): (args: { cycle: number; outputDir: string }) => string {
  const sessionMode: HealSessionMode = opts.sessionMode ?? 'new'
  const promptPath = opts.promptPath
    ?? (opts.agent === 'claude'
      ? path.join(opts.projectRoot, 'CLAUDE.md')
      : path.join(opts.projectRoot, 'AGENTS.md'))
  // Eagerly load + extract the prompt block so a missing/malformed file
  // surfaces at config time, not on the first heal cycle.
  const basePrompt = loadPrompt(opts.agent, promptPath)
  const promptFile = path.join(opts.runDir, 'heal-prompt.md')
  // Per-run signal paths injected so the agent doesn't have to guess. The
  // shipped CLAUDE.md / AGENTS.md tells the agent to look for this header.
  const signalsDir = path.join(opts.runDir, 'signals')
  const pathsHeader = [
    `Signal paths for this run:`,
    `- Test/config-only fix → write \`${path.join(signalsDir, '.rerun')}\``,
    `- Service/app fix → write \`${path.join(signalsDir, '.restart')}\``,
  ].join('\n')

  return ({ cycle, outputDir }) => {
    const stateAddendum = buildHealAddendum({ cycle: cycle + 1 })
    const fullPrompt = [pathsHeader, basePrompt, stateAddendum].filter(Boolean).join('\n\n')
    fs.mkdirSync(path.dirname(promptFile), { recursive: true })
    fs.writeFileSync(promptFile, fullPrompt)
    return buildAgentCommand(opts.agent, sessionMode, cycle, promptFile, outputDir)
  }
}

/**
 * Companion to `buildOrchestratorHealCommand`: builds the resume invocation
 * used by `RunOrchestrator.interjectHealAgent`. Writes the user's interject
 * text to a dedicated prompt file so it doesn't clobber the cycle's main
 * heal prompt, then composes `claude --resume <sid> -p "<text>"` (or the
 * codex equivalent).
 */
export function buildOrchestratorInterjectCommand(
  opts: OrchestratorAutoHealFactoryOptions,
): (args: { sessionId: string; text: string; outputDir?: string }) => string {
  const interjectPromptFile = path.join(opts.runDir, 'heal-interject-prompt.md')
  return ({ sessionId, text, outputDir }) => {
    fs.mkdirSync(path.dirname(interjectPromptFile), { recursive: true })
    fs.writeFileSync(interjectPromptFile, text)
    // cycle is irrelevant when explicit resume id is set; pass 1 to satisfy
    // the signature.
    return buildAgentCommand(
      opts.agent,
      'resume',
      1,
      interjectPromptFile,
      outputDir,
      { resumeSessionId: sessionId },
    )
  }
}
