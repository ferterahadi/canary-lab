import fs from 'fs'
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { modelArgs } from './agent-models'
import { startIdleTimer, type IdleTimer } from './agent-idle-timer'
import { resolveAgentBinary, isAgentKind, type HealAgent } from './agent-binary'
import { agentJobStore } from './agent-jobs/store'
import type { AgentJobRecordRef, AgentJobStatus } from './agent-jobs/types'

// One home for spawning an agent CLI (the Portify model): pipe stdout/stderr,
// reset the idle clock on every chunk (the liveness signal), kill on a genuine
// idle stall, and expose the child + a result promise. Every agent feature
// (wizard, coverage annotate/PRD, eval rewrite, portify, sabotage) composes this
// instead of re-implementing spawn+tee+idle. See the `cl_reuse-shared-logic` skill.

// The tools a read-only agent is allowed to hold. `--tools` is a hard
// capability allowlist, not a prompt instruction: the tools left out are absent
// from the session entirely, so the agent cannot use them even under
// `--dangerously-skip-permissions`. Verified against claude 2.1.220 — with this
// list the agent reports having no Edit and no Bash, and a file it was told to
// write is not created.
//
// It bounds BUILT-IN tools only. MCP tools come from the user's own config
// whether or not this spawn asks for any, so the allowlist alone left a
// read-only agent holding a browser — `--strict-mcp-config` below is what
// actually closes that.
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const

// Outbound tools no unattended canary agent has a use for. Every agent spawned
// through here works on local code the user already has: a scout reads a repo,
// portify edits ports, sabotage plants a bug. None of them need to fetch a URL
// or run a search, and an unattended window is the worst time to allow one.
//
// `--disallowedTools` is evaluated BEFORE `--dangerously-skip-permissions`, so
// the deny survives the bypass — verified against claude 2.1.220.
export const CLAUDE_DENIED_TOOLS = ['WebFetch', 'WebSearch'] as const

// The claude agentic argv — tools on, plus stream-json so stdout streams
// token-by-token (claude `-p` is otherwise silent during its final-message
// composition, which trips the idle clock). Consumed only for liveness + answer
// recovery; the live view is the session JSONL tail.
//
// Permissions ARE bypassed here, and have to be: `-p` has no human to approve a
// tool call, so a prompt would hang until the idle watchdog killed it. What the
// bypass must not mean is unbounded power — an agent whose job is to read and
// answer is spawned with `readOnly`, which takes the write tools away entirely
// rather than trusting it not to use them.
export function buildClaudeAgenticArgs(
  prompt: string,
  opts: { model?: string | null; sessionId?: string; resume?: boolean; readOnly?: boolean } = {},
): string[] {
  return [
    '-p', prompt,
    '--dangerously-skip-permissions',
    // No MCP server this spawn did not ask for. `--tools` bounds the BUILT-IN
    // tools only — measured on 2.1.220, a read-only spawn without this still
    // arrived holding whatever MCP servers the user happens to have connected,
    // `browser_run_code_unsafe` among them. None of these agents pass an
    // `--mcp-config`, so the correct set is empty: they read the workspace and
    // answer, and an unattended window is no place to inherit a human's
    // connected tools. (The heal REPL is a different builder and keeps its
    // Playwright MCP config.)
    '--strict-mcp-config',
    '--disallowedTools', CLAUDE_DENIED_TOOLS.join(','),
    ...(opts.readOnly ? ['--tools', CLAUDE_READ_ONLY_TOOLS.join(',')] : []),
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    ...modelArgs(opts.model ?? null),
    ...(opts.sessionId
      ? (opts.resume ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId])
      : []),
  ]
}

export interface AgentProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** Accumulated stdout (empty when `captureStdout` is false). */
  stdout: string
  /** Accumulated stderr (for error messages). */
  stderr: string
}

export interface AgentProcessHandle {
  child: ChildProcess
  /** Resolves on close; rejects only on a spawn 'error' (CLI missing / unlaunchable). */
  done: Promise<AgentProcessResult>
  stop: (signal?: NodeJS.Signals) => void
}

export interface RunAgentProcessOpts {
  /**
   * The CLI to spawn. A bare agent kind (`'claude'` / `'codex'`) is resolved to
   * an absolute path via `resolveBinary` — so spawns survive a restricted PATH
   * (e.g. when the server is launched by Claude/Codex Desktop), and no call site
   * has to remember to resolve first. Any other string (an absolute path, a test
   * stub) is spawned verbatim.
   */
  command: string
  args: string[]
  cwd?: string
  /** Written to the child's stdin then closed (codex `-`); omit to close stdin empty. */
  stdin?: string
  /** Per-chunk hook, fired after the idle bump — tee to a log / forward to onOutput. */
  onChunk?: (text: string, stream: 'stdout' | 'stderr') => void
  /** Accumulate stdout into the result (for answer recovery). Default true. */
  captureStdout?: boolean
  /** Idle (no-activity) window in ms before SIGTERM. */
  idleMs: number
  /** How often the idle clock is checked (default 10s). */
  pollMs?: number
  /** File whose growth also counts as activity (claude session JSONL / logfile). */
  activityPath?: string
  /** Fired once when the idle window elapses, before the SIGTERM. */
  onIdle?: () => void
  /** Fired each poll while still within the idle window (e.g. a progress note). */
  onTick?: (idleMs: number) => void
  /** Override spawn (tests). */
  spawnImpl?: typeof nodeSpawn
  /** Override agent-kind → path resolution (tests). Defaults to resolveAgentBinary. */
  resolveBinary?: (agent: HealAgent) => string | null
  /**
   * Opt-in label that makes this child findable again after the fact, so an
   * owner can stop it without having kept the handle. A flight passes its stage
   * sidecar dir, which is why a paused stage can kill the agent it started
   * several call layers down (the spawn happens inside `defaultSpawnAgent`, the
   * PRD distiller, or the coverage annotator — none of which hand the handle
   * back). Callers with no such need omit it and are unaffected, except that
   * `stopAllAgentProcesses` sweeps them too on shutdown.
   */
  spawnScope?: string
  /**
   * Write a durable record for this spawn: `running` now, terminal on close. The
   * RUNNER owns that lifecycle rather than each caller, so there is exactly one
   * implementation of "started / done / failed / stopped" and a new agent feature
   * inherits it by passing a descriptor.
   *
   * Optional because there are two genuine caller classes: work a flight owns
   * (which has no record of its own), and jobs that already ARE records — the
   * standalone coverage job's manifest is durable, reconciled and surfaced
   * already, so a second per-spawn record would be the duplicate this repo's
   * reuse rule exists to prevent.
   */
  record?: AgentJobRecordRef
  /** Where records go. Required alongside `record`; absent → nothing is written. */
  agentJobLogsDir?: string
}

/** How long a stopped child gets to exit on SIGTERM before it is SIGKILLed. An
 *  agent CLI flushing its session JSONL needs a moment; one that has wedged must
 *  not hold a pause (or a server shutdown) open forever. */
const AGENT_STOP_GRACE_MS = 8_000

interface LiveAgentProcess {
  child: ChildProcess
  scope: string | undefined
  done: Promise<AgentProcessResult>
  /** Set when a stop was requested, so the record settles `stopped` rather than
   *  `failed` — "someone asked it to stop" and "it fell over" are different
   *  endings, and a reader of the row cannot tell them apart from an exit code. */
  stopRequestedBy?: 'user' | 'flight'
}

/** Every agent child currently running, keyed by the child itself so removal
 *  needs nothing but the `child` already in scope at settle time.
 *
 *  This exists because "stop" used to mean "stop waiting". A flight pause could
 *  abort its own poll while the CLI it spawned kept editing the user's repo, and
 *  quitting the server orphaned those children entirely — nothing tracked them,
 *  so `cleanup()` had nothing to kill. */
const liveAgentProcesses = new Map<ChildProcess, LiveAgentProcess>()

async function terminate(entry: LiveAgentProcess, graceMs: number, by: 'user' | 'flight' = 'flight'): Promise<void> {
  entry.stopRequestedBy = by
  try { entry.child.kill('SIGTERM') } catch { /* already dead */ }
  const escalate = setTimeout(() => {
    try { entry.child.kill('SIGKILL') } catch { /* already dead */ }
  }, graceMs)
  try {
    // Awaiting `done` is the whole point: the caller promised the work stopped,
    // so it must not return while the child is still exiting.
    await entry.done
  } catch {
    // `done` rejects only on a spawn 'error' — the process never ran, so there
    // is nothing left to wait for.
  } finally {
    clearTimeout(escalate)
  }
}

/** Stop every live child spawned under `scope`, resolving once they have all
 *  exited. Unknown scope → resolves immediately; a stage whose spawn already
 *  finished (or which never spawned, e.g. one parked on an external hand-off)
 *  is the normal no-op case, not an error. */
export async function stopAgentProcesses(
  scope: string,
  opts: { graceMs?: number; by?: 'user' | 'flight' } = {},
): Promise<void> {
  const matches = [...liveAgentProcesses.values()].filter((entry) => entry.scope === scope)
  await Promise.all(matches.map((entry) => terminate(entry, opts.graceMs ?? AGENT_STOP_GRACE_MS, opts.by ?? 'flight')))
}

/** Stop EVERY live agent child, scoped or not — the server-shutdown sweep.
 *  Without it a SIGTERM to the server left its agents re-parented and running:
 *  next-boot reconcile repaired the flight/portify RECORDS, but the processes
 *  kept going, and a claude agent kept editing the user's repo after the app it
 *  belonged to was gone. */
export async function stopAllAgentProcesses(): Promise<void> {
  const entries = [...liveAgentProcesses.values()]
  await Promise.all(entries.map((entry) => terminate(entry, AGENT_STOP_GRACE_MS)))
}

// Every CLI spawned through here is a runner-spawned agent (benchmark sabotage,
// portify, coverage, wizard, …). If such an agent connects back to Canary Lab's
// MCP it must be tagged a PTY client so the heal-claim policy blocks it from
// claiming its own run — see heal-claim-policy.ts. Tagging here (rather than at
// each call site) makes it impossible to forget: any new agent feature inherits
// the block for free. `CANARY_LAB_MCP_CLIENT_KIND` is read first by the MCP
// bridge's `inferMcpClientKind`, so this wins over process-lineage sniffing.
function runnerPtyClientKind(command: string): 'claude-pty' | 'codex-pty' | null {
  const base = command.split('/').pop()!
  if (/claude/i.test(base)) return 'claude-pty'
  if (/codex/i.test(base)) return 'codex-pty'
  return null
}

export function runAgentProcess(opts: RunAgentProcessOpts): AgentProcessHandle {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn
  const resolveBinary = opts.resolveBinary ?? resolveAgentBinary
  const captureStdout = opts.captureStdout ?? true
  const useStdin = opts.stdin !== undefined
  // Resolve a bare agent kind to an absolute path (bare fallback so a genuine
  // ENOENT still surfaces through the 'error' path); spawn anything else as-is.
  const command = isAgentKind(opts.command) ? (resolveBinary(opts.command) ?? opts.command) : opts.command
  const ptyKind = runnerPtyClientKind(command)
  const child = spawnImpl(command, opts.args, {
    cwd: opts.cwd,
    stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: ptyKind
      ? { ...process.env, CANARY_LAB_MCP_CLIENT_KIND: ptyKind }
      : process.env,
  })

  let stdout = ''
  let stderr = ''
  let idleTimer: IdleTimer | undefined

  // Best-effort throughout: a record is bookkeeping, and losing it must never take
  // the spawn down with it.
  const jobs = opts.record && opts.agentJobLogsDir ? agentJobStore(opts.agentJobLogsDir) : null
  if (jobs && opts.record) {
    try {
      jobs.save({
        ...opts.record,
        scope: opts.spawnScope,
        startedAt: new Date().toISOString(),
        status: 'running',
      })
    } catch { /* bookkeeping only */ }
  }
  const settleRecord = (
    status: AgentJobStatus,
    patch: Partial<{ exitCode: number; note: string; stoppedBy: 'user' | 'flight' }> = {},
  ): void => {
    if (!jobs || !opts.record) return
    try {
      jobs.patch(opts.record.jobId, { status, endedAt: new Date().toISOString(), ...patch })
    } catch { /* bookkeeping only */ }
  }

  const done = new Promise<AgentProcessResult>((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      idleTimer?.stop()
      // Read the stop intent BEFORE dropping the registry entry — it is where the
      // "someone asked" flag lives, and it is what separates a `stopped` ending
      // from a `failed` one for a reader who has only the row.
      const stoppedBy = liveAgentProcesses.get(child)?.stopRequestedBy
      liveAgentProcesses.delete(child)
      if (err) {
        settleRecord('failed', { note: `The agent could not be launched: ${err.message}` })
        reject(err)
        return
      }
      if (stoppedBy) settleRecord('stopped', { stoppedBy, note: 'Stopped on request; it did not finish its work.' })
      else if (code === 0) settleRecord('done')
      else settleRecord('failed', { ...(code === null ? {} : { exitCode: code }), note: `The agent exited ${signal ? `on ${signal}` : `with code ${code}`}.` })
      resolve({ code, signal, stdout, stderr })
    }
    // Register the lifecycle listeners BEFORE starting the idle timer: a mocked
    // (or pathologically fast) timer could fire onIdle → kill → 'close'
    // synchronously, and the close listener must already be attached to catch it.
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      if (captureStdout) stdout += text
      idleTimer?.bump()
      opts.onChunk?.(text, 'stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderr += text
      idleTimer?.bump()
      opts.onChunk?.(text, 'stderr')
    })
    child.on('error', (err) => finish(err, null, null))
    child.on('close', (code, signal) => finish(null, code, signal))
    idleTimer = startIdleTimer({
      idleMs: opts.idleMs,
      pollMs: opts.pollMs,
      activity: opts.activityPath
        ? () => { try { return fs.statSync(opts.activityPath!).size } catch { return 0 } }
        : undefined,
      onTick: opts.onTick,
      onIdle: () => { opts.onIdle?.(); try { child.kill('SIGTERM') } catch { /* already dead */ } },
    })
  })

  // Registered unconditionally: nothing above can have settled yet. The only
  // paths to `finish` are the child's own 'close'/'error' events and the idle
  // timer, and the timer is a setInterval — so the earliest any of them can fire
  // is a later tick, by which point this entry exists for `finish` to delete.
  liveAgentProcesses.set(child, { child, scope: opts.spawnScope, done })

  try { child.stdin?.end(useStdin ? opts.stdin : undefined) } catch { /* ignore */ }

  return {
    child,
    done,
    stop: (signal: NodeJS.Signals = 'SIGTERM') => { try { child.kill(signal) } catch { /* already dead */ } },
  }
}
