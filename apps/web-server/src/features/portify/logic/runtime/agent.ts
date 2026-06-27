import fs from 'fs'
import os from 'os'
import path from 'path'
import { type ChildProcess } from 'child_process'
import { encodeClaudeProjectDir } from '../../../agent-sessions/logic/agent-session-log'
import { agentActivityPath } from '../../../agent-sessions/logic/agent-producer'
import { type HealAgent } from '../../../runs/logic/runtime/auto-heal'
import { PORTIFY_MODELS, modelArgs } from '../../../agent-sessions/logic/agent-models'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../../agent-sessions/logic/agent-process'

// Idle window: kill a wedged port-ify agent after this long with NO activity
// (no session-JSONL / log growth). No hard wall-clock — a slow-but-working agent
// is never punished (see agent-idle-timer.ts).
const PORTIFY_IDLE_TIMEOUT_MS = 5 * 60 * 1000

// A spawned claude/codex CLI emits this when the user's subscription quota is
// exhausted. It then exits 0 having made NO edits — which the double-boot
// verifier would mislabel "no port slots declared" and the orchestrator would
// burn every remaining attempt re-running into the same wall. Detect it in the
// streamed output so the run can fail fast with an actionable message instead.
const SESSION_LIMIT_RE = /hit your (session|usage) limit|(session|usage) limit reached|usage limit\b/i

/** True if the agent's streamed output says its session/usage quota is exhausted. */
export function isAgentSessionLimited(output: string): boolean {
  return SESSION_LIMIT_RE.test(output)
}

// One-shot, headless agent run for the port-ification edits (mirrors the
// benchmark sabotage agent). Resolves on process exit; permissions auto-accept
// (no human in this loop). For claude we pin a session id on attempt 1 and
// `--resume` it on retries so the agent keeps context across attempts.
//
// The runner resolves the bare agent kind to an ABSOLUTE path (see
// runAgentProcess): a UI server launched by a GUI client (e.g. Claude Desktop)
// has a minimal PATH that omits ~/.local/bin etc., so spawning the bare name
// would silently fail and the empty edit would read downstream as "no port
// slots declared". A genuine launch failure REJECTS so the orchestrator fails
// fast with a clear message instead of cycling through empty retries.

export function runPortifyAgent(opts: {
  agent: HealAgent
  prompt: string
  cwd: string
  logPath?: string
  children?: Set<ChildProcess>
  /** claude session id — set on attempt 1, reused on retries. */
  sessionId?: string
  /** true on a retry: resume the prior claude session instead of starting one. */
  resume?: boolean
}): Promise<void> {
  const { agent, prompt, cwd, logPath, children, sessionId, resume } = opts
  // Shared agent-process runner (spawn + tee + idle). claude gets stream-json for
  // liveness; the double-boot verifier judges the result, so we don't parse output.
  const args = agent === 'claude'
    ? buildClaudeAgenticArgs(prompt, { model: PORTIFY_MODELS.claude, sessionId, resume })
    : ['exec', '--full-auto', ...modelArgs(PORTIFY_MODELS.codex), prompt]
  let out: number | null = null
  if (logPath) {
    try { out = fs.openSync(logPath, 'a') } catch { out = null }
  }
  // Watch the stream for the quota sentinel. Carry a small tail across chunks so
  // a phrase split over a stream-json boundary is still matched; latch once seen.
  let sessionLimited = false
  let tail = ''
  const handle = runAgentProcess({
    command: agent,
    args,
    cwd,
    captureStdout: false,
    onChunk: (text) => {
      if (out !== null) { try { fs.writeSync(out, text) } catch { /* best effort */ } }
      if (!sessionLimited) {
        const probe = tail + text
        if (isAgentSessionLimited(probe)) sessionLimited = true
        tail = probe.slice(-200)
      }
    },
    idleMs: PORTIFY_IDLE_TIMEOUT_MS,
    activityPath: agentActivityPath(agent, cwd, sessionId, logPath ?? undefined),
  })
  children?.add(handle.child)
  const cleanup = (): void => {
    children?.delete(handle.child)
    if (out !== null) { try { fs.closeSync(out) } catch { /* noop */ } }
  }
  return handle.done.then(
    // Normal exit (any code) resolves — a non-zero agent still may have made
    // useful edits; the double-boot verifier is the real arbiter. The one
    // exception: a quota exhaustion makes "exit 0, no edits" indistinguishable
    // from a real empty result, so reject with a clear, non-burning message.
    () => {
      cleanup()
      if (sessionLimited) {
        throw new Error(
          `the ${agent} CLI hit its session/usage limit before completing the edit — ` +
          `re-run portify once the limit resets`,
        )
      }
    },
    // A spawn failure (CLI missing / not launchable) is NOT a normal run that
    // simply made no edits — record it to the log and reject so the caller can
    // report it instead of letting verify mislabel it "no port slots declared".
    (err: Error) => {
      const msg = `could not launch the ${agent} CLI: ${err.message}`
      if (out !== null) { try { fs.writeSync(out, `\n${msg}\n`) } catch { /* noop */ } }
      cleanup()
      throw new Error(msg)
    },
  )
}

// Write `<workflowDir>/agent-session.json` pointing at the claude native session
// log so the shared AgentSessionView can render the agent timeline (same ref
// shape the benchmark setup view uses).
export function writePortifyClaudeRef(workflowDir: string, cwd: string, sessionId: string): void {
  try {
    const realCwd = fs.realpathSync(cwd)
    const logPath = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(realCwd), `${sessionId}.jsonl`)
    const ref = { activeAgent: 'claude', sessions: { claude: { agent: 'claude', sessionId, logPath } } }
    fs.writeFileSync(path.join(workflowDir, 'agent-session.json'), JSON.stringify(ref, null, 2))
  } catch {
    /* best-effort — the UI falls back to the text log */
  }
}
