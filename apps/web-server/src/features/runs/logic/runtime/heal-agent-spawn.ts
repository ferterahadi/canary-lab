import fs from 'fs'
import path from 'path'
import { HEAL_MODELS } from '../../../agent-sessions/logic/agent-models'
import { resolveAgentBinary, isAgentCliAvailable, type HealAgent, type AgentResolveDeps } from '../../../agent-sessions/logic/agent-binary'

// Heal-agent command builders for the web-server orchestrator. The orchestrator
// runs claude / codex as a long-lived interactive REPL (no `-p`, no formatter
// pipe). The shell command produced here is just the binary + flags — the
// per-cycle prompt is written to the pty's stdin by `RunOrchestrator` after
// spawn, which lets users type into the same session for smooth interjects.

// Standard UUID format (any version). Matches what `randomUUID()` and
// claude's session id format produce. Anchored so partial garbage in the
// file is rejected as invalid.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function readPriorSessionIdFromValue(value: string): string | null {
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed : null
}

/**
 * Read a previously-persisted agent session UUID from disk. Returns the
 * trimmed UUID when the file exists and contains a single valid UUID;
 * returns null when the file is missing, unreadable, empty, or contains
 * anything that doesn't look like a UUID.
 *
 * Used by `spawnHealAgentRepl` to resume the prior conversation on
 * Restart Heal instead of starting a fresh one with a new id.
 */
export function readPriorSessionId(sessionIdPath: string): string | null {
  let raw: string
  try { raw = fs.readFileSync(sessionIdPath, 'utf-8') } catch { return null }
  return readPriorSessionIdFromValue(raw)
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
   *  parsing init frames. For codex this is used only with `resume: true`,
   *  after the orchestrator has discovered and persisted the prior session id. */
  sessionId?: string
  /** Resume an existing claude conversation by `sessionId` instead of pinning
   *  a fresh one. When true with a `sessionId`, the spawn command emits
   *  `--resume <uuid>` (continues the prior conversation with history). When
   *  false (default), emits `--session-id <uuid>` (starts a new conversation
   *  pinned to that id). For codex, true with a `sessionId` emits
   *  `codex resume <uuid>`. */
  resume?: boolean
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
  /** Absolute path to the agent binary, from `resolveAgentBinary`. When set,
   *  the command launches via this quoted path instead of the bare `claude`/
   *  `codex` name — so the heal agent spawns even when the server's PATH is
   *  restricted (e.g. a Desktop-launched UI server). Omitted in unit tests,
   *  which keep asserting against the bare command name. */
  binaryPath?: string
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
 * File edits are the exception, and `--permission-mode acceptEdits` is how we
 * ask for them. Editing is the entire job of a repair agent: with per-edit
 * approval it writes the correct fix, stops on "Do you want to make this edit
 * to server.ts?", and is killed by the idle watchdog — the run then reports
 * "No code changes were made", which reads as a failed repair rather than an
 * unanswered question. Everything else still prompts in the pane.
 *
 * This was previously supplied by accident: Claude Code's own auto mode is on
 * by default and auto-approves edits. But auto mode is a per-MODEL capability
 * — measured on 2.1.220, a haiku session prints "auto mode unavailable for
 * this model" and drops to manual, and unattended repair stops dead. Asking
 * for the posture we need beats inheriting one we never requested.
 *
 * Claude session flag:
 * - `--session-id <uuid>`: starts a NEW conversation pinned to that uuid.
 *   Used on first spawn for a run so the orchestrator knows the id without
 *   parsing init frames.
 * - `--resume <uuid>`: resumes an EXISTING conversation by uuid. Used when
 *   restarting heal on a previously-failed run so the agent keeps its prior
 *   investigation history.
 *
 * - claude: `claude [--resume <uuid> | --session-id <uuid>] [--mcp-config <path>]`
 * - codex:  `codex` or `codex resume <uuid>`
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

  // The command head: an absolute, quoted binary path when resolved (works
  // under a restricted PATH), otherwise the bare agent name (PATH lookup).
  const head = args.binaryPath ? JSON.stringify(args.binaryPath) : agent

  // Optional `--model` — placed right after the binary so it reads as a global
  // flag for both claude and codex (before codex's `resume` subcommand). Empty
  // string when the feature runs on the agent default (HEAL_MODELS).
  const model = HEAL_MODELS[agent]
  const modelFlag = model ? ` --model ${JSON.stringify(model)}` : ''

  if (agent === 'claude') {
    const sid = args.sessionId
      ? (args.resume
        ? ` --resume ${JSON.stringify(args.sessionId)}`
        : ` --session-id ${JSON.stringify(args.sessionId)}`)
      : ''
    let mcp = ''
    if (args.mcpOutputDir) {
      if (!args.mcpConfigFile) {
        throw new Error('buildAgentSpawnCommand: mcpConfigFile is required when mcpOutputDir is set')
      }
      mcp = ` ${buildClaudeMcpConfigArg(args.mcpOutputDir, args.mcpConfigFile)}`
    }
    // No `--dangerously-skip-permissions` — every tool but file editing still
    // asks in the pane. `acceptEdits` is the one grant a repair agent needs to
    // be able to work unattended; see the note above.
    return `${head}${modelFlag} --permission-mode acceptEdits${sid}${mcp}${promptArg}`
  }
  // codex interactive REPL. No `--full-auto`: tool approvals stay
  // interactive in the pane. Codex has no `--session-id` analogue, so the
  // first run starts normally. Once the orchestrator discovers Codex's
  // persisted session id, Restart Heal can use `codex resume <id>`.
  if (args.resume && args.sessionId) {
    return `${head}${modelFlag} resume ${JSON.stringify(args.sessionId)}${promptArg}`
  }
  // Codex accepts a positional prompt the same way as claude.
  return `${head}${modelFlag}${promptArg}`
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
  deps: AgentResolveDeps = {},
): HealAgent | null {
  if (envOverride === 'claude' || envOverride === 'codex') {
    return isAgentCliAvailable(envOverride, deps) ? envOverride : null
  }
  if (envOverride !== undefined && envOverride !== '') {
    // Set but unrecognised — refuse to silently fall through, so a typoed
    // value like `clauude` doesn't pretend to work.
    return null
  }
  if (isAgentCliAvailable('claude', deps)) return 'claude'
  if (isAgentCliAvailable('codex', deps)) return 'codex'
  return null
}
