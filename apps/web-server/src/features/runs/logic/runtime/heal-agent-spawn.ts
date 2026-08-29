import fs from 'fs'
import path from 'path'
import { HEAL_MODELS, effortArgs, type StageModelChoice } from '../../../agent-sessions/logic/agent-models'
import { resolveAgentBinary, isAgentCliAvailable, type HealAgent, type AgentResolveDeps } from '../../../agent-sessions/logic/agent-binary'
import { internalAgentContextShellFlags } from '../../../agent-sessions/logic/agent-context-policy'

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
  /** Directories the agent must be able to read and write outside its cwd —
   *  the effective service repos it repairs. The
   *  agent's cwd is the run directory, so every repo it edits is out of scope
   *  by default and each first touch raises an "allow reading from …?" prompt
   *  that nothing answers under autopilot. Effective (worktree-aware) paths:
   *  pass service `cwd`s, not the feature's declared `localPath`s. */
  writableDirs?: readonly string[]
  /** Extra read-only context for Claude. Codex receives no `--add-dir` for
   * these paths because its workspace-write sandbox has no matching negative
   * path rule; Claude's invocation-local settings enforce the read-only half. */
  readableDirs?: readonly string[]
  /** Invocation-local Claude settings containing the run's sandbox boundary.
   * Ignored by Codex, whose workspace-write roots come from cwd + writableDirs. */
  isolationSettingsFile?: string
  /** Workspace root whose interactive Codex trust gate should be satisfied for
   *  this invocation. Codex applies trust to the repository root when its cwd
   *  is a nested run directory; a whole-map `-c projects={...}` override avoids
   *  the unattended REPL stalling without mutating the user's persistent
   *  config. Hooks are disabled for this invocation so trusted status cannot
   *  silently run hooks the user has not reviewed. Ignored by Claude, whose
   *  trust store has a separate pre-spawn helper. */
  workspaceRoot?: string
  /** The run's heal-stage model+effort plan, resolved and persisted at launch.
   *  The `CANARY_LAB_HEAL_MODEL` env pin still wins the MODEL half — it exists
   *  to demonstrate the repair loop on one server regardless of workspace
   *  config. Absent → the env pin alone, then agent default. */
  models?: StageModelChoice
}

export type AgentSpawnCommandDefaults = Pick<AgentSpawnArgs, 'mcpConfigFile' | 'binaryPath' | 'models'>

/**
 * Bind the run-specific spawn defaults once while forwarding every
 * orchestrator-supplied argument. Keeping this adapter here prevents route,
 * restart, and benchmark call sites from silently dropping a newly-added
 * spawn option such as `writableDirs` when they unpack the argument object.
 */
export function makeAgentSpawnCommandBuilder(
  agent: HealAgent,
  defaults: AgentSpawnCommandDefaults,
): (args: AgentSpawnArgs) => string {
  return (args) => buildAgentSpawnCommand(agent, { ...args, ...defaults })
}

function codexWorkspaceTrustFlag(workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return ''
  let root: string
  try { root = fs.realpathSync(workspaceRoot) } catch { root = path.resolve(workspaceRoot) }
  // Codex 0.146.0's TUI ignores a dotted projects.<root>.trust_level override,
  // but honors the complete projects map as an inline TOML table. JSON string
  // escaping is valid for its key; POSIX single-quote escaping keeps the value
  // inert as one shell argument, including `$()`/backticks. Trust would open a
  // second hook-review gate, so hooks are disabled for this unattended spawn.
  const override = `projects={${JSON.stringify(root)}={trust_level="trusted"}}`
  return ` --disable hooks -c '${override.replace(/'/g, `'"'"'`)}'`
}

/**
 * Build the spawn command for a long-lived REPL. Returns just the binary +
 * flags — the orchestrator writes the per-cycle prompt to the pty's stdin
 * after spawn, so this command does not include any `-p`/positional prompt.
 *
 * The permission posture asks for exactly what an UNATTENDED repair needs, and
 * no more. The REPL was originally treated as interactive — "the user is right
 * there in the pane and can approve each tool" — but that describes the
 * exception, not the operating mode: heal runs on autopilot behind a 300s idle
 * watchdog, and a prompt nobody answers is indistinguishable from a hung agent.
 *
 * Three separate gates can each strand a repair, and they need different flags:
 *
 * 1. **File edits** — `acceptEdits` covered these, and only these. Editing is
 *    the entire job: with per-edit approval the agent writes the correct fix,
 *    stops on "Do you want to make this edit to server.ts?", and dies to the
 *    watchdog. The run then says "No code changes were made" — blaming the
 *    agent for an unanswered question.
 * 2. **Bash commands** — NOT covered by `acceptEdits`, which grants edits plus
 *    `mkdir`/`touch`/`mv`/`cp` only. Everything else goes to Claude Code's
 *    command-safety classifier, and a glob or `$var` expansion defeats static
 *    classification (it reports `Contains simple_expansion`) — which also means
 *    a prefix-scoped `Bash(cat:*)` allow rule cannot cover it. Observed live on
 *    2026-08-04: the agent finished a complete, correct repair, then froze
 *    reading its own evidence files, and the run reported FAILED 3/8.
 * 3. **Directory scope** — the agent's cwd is the run directory, so every repo
 *    it must edit is outside it and the first touch asks "allow reading from
 *    …?". `--add-dir` per `writableDirs` is what settles this one; no
 *    permission mode does.
 *
 * `--permission-mode auto` covers 1 and 2 while keeping the background safety
 * classifier that `--dangerously-skip-permissions` discards — the narrowest
 * posture that actually closes the freeze. Codex's equivalent is `-a never`.
 *
 * KNOWN HAZARD: auto mode's availability is a per-MODEL capability — measured
 * on 2.1.220, a haiku session prints "auto mode unavailable for this model" and
 * drops to manual, where even edits prompt. A weak model pinned via
 * `CANARY_LAB_HEAL_MODEL` can therefore still freeze, and more readily than
 * under `acceptEdits`. That failure is no longer silent: the classifier's
 * `approval-prompt` cause names it, and the loop's inferred-restart arm means a
 * repair finished before the freeze is still verified rather than discarded.
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
  // flag for both claude and codex (before codex's `resume` subcommand). The
  // env pin wins over the run's persisted plan (see AgentSpawnArgs.models);
  // empty string when the stage runs on the agent default. Effort has no env
  // pin — it comes from the plan alone, spelled in each CLI's own knob.
  const model = HEAL_MODELS[agent] ?? args.models?.model ?? null
  const modelFlag = model ? ` --model ${JSON.stringify(model)}` : ''
  const effortFlag = effortArgs(agent, args.models?.effort ?? null)
    .map((arg) => ` ${JSON.stringify(arg)}`)
    .join('')
  const contextFlags = internalAgentContextShellFlags(agent)

  // Both CLIs spell it `--add-dir`. Claude also gets the suite as read-only
  // context; its isolation settings deny edits and sandbox writes there.
  // Codex gets only writable roots because it has no equivalent negative path
  // override. Deduped: two services in one repo can share a cwd.
  const addDirs = [...new Set([
    ...(args.writableDirs ?? []),
    ...(agent === 'claude' ? (args.readableDirs ?? []) : []),
  ])]
    .map((dir) => ` --add-dir ${JSON.stringify(dir)}`)
    .join('')

  if (agent === 'claude') {
    const isolation = args.isolationSettingsFile
      ? ` --setting-sources "" --settings ${JSON.stringify(args.isolationSettingsFile)}`
      : ''
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
    // Still not `--dangerously-skip-permissions`: `auto` keeps Claude Code's
    // background safety classifier in the loop, which the blanket bypass drops.
    return `${head}${modelFlag}${effortFlag}${contextFlags}${isolation} --permission-mode auto${addDirs}${sid}${mcp}${promptArg}`
  }
  // codex interactive REPL. `-a never` is codex's spelling of the same posture:
  // it never asks for approval, and a command the sandbox refuses comes back to
  // the model as an execution failure it can react to — a failure it can report
  // rather than a prompt it waits on. `--sandbox workspace-write` is explicit
  // because Codex rejects every `--add-dir` at startup under its default
  // permissions. Not `--dangerously-bypass-approvals-and-sandbox`, which drops
  // the sandbox too. `--add-dir` then makes the repos writable under that
  // sandbox; without it `-a never` would turn the freeze into a silent write
  // failure, since escalation-on-approval can no longer happen. Codex has no
  // `--session-id` analogue, so the first run starts normally. Once the
  // orchestrator discovers Codex's persisted session id, Restart Heal can use
  // `codex resume <id>`.
  const codexAuto = `${effortFlag}${contextFlags} -a never --sandbox workspace-write${codexWorkspaceTrustFlag(args.workspaceRoot)}${addDirs}`
  if (args.resume && args.sessionId) {
    return `${head}${modelFlag}${codexAuto} resume ${JSON.stringify(args.sessionId)}${promptArg}`
  }
  // Codex accepts a positional prompt the same way as claude.
  return `${head}${modelFlag}${codexAuto}${promptArg}`
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
