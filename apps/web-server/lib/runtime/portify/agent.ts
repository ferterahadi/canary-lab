import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { claudeSessionLogPath, encodeClaudeProjectDir } from '../../agent-session-log'
import { resolveAgentBinary, type HealAgent } from '../auto-heal'
import { PORTIFY_MODELS, modelArgs } from '../../agent-models'
import { startIdleTimer, type IdleTimer } from '../../agent-idle-timer'

// Idle window: kill a wedged port-ify agent after this long with NO activity
// (no session-JSONL / log growth). No hard wall-clock — a slow-but-working agent
// is never punished (see agent-idle-timer.ts).
const PORTIFY_IDLE_TIMEOUT_MS = 5 * 60 * 1000

// One-shot, headless agent run for the port-ification edits (mirrors the
// benchmark sabotage agent). Resolves on process exit; permissions auto-accept
// (no human in this loop). For claude we pin a session id on attempt 1 and
// `--resume` it on retries so the agent keeps context across attempts.
//
// Resolves the binary to an ABSOLUTE path (resolveAgentBinary) rather than
// spawning the bare command name. A UI server launched by a GUI client (e.g.
// Claude Desktop) has a minimal PATH that omits ~/.local/bin etc.; agent
// detection already probes those well-known homes, so the spawn must use the
// SAME resolution — otherwise a detected agent silently fails to launch and
// the empty edit reads downstream as "no port slots declared". A launch
// failure REJECTS so the orchestrator fails fast with a clear message instead
// of cycling through empty retries.

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
  return new Promise((resolve, reject) => {
    const { agent, prompt, cwd, logPath, children, sessionId, resume } = opts
    const args =
      agent === 'claude'
        ? [
            '-p', prompt, '--dangerously-skip-permissions',
            // stream-json keeps stdout flowing (token deltas) so the idle clock
            // resets during a long claude inference — same liveness mechanism as
            // every other agent runner. Consumed only for liveness; the verifier
            // judges the result, so we don't parse the output.
            '--output-format=stream-json', '--include-partial-messages', '--verbose',
            ...modelArgs(PORTIFY_MODELS.claude),
            ...(sessionId ? (resume ? ['--resume', sessionId] : ['--session-id', sessionId]) : []),
          ]
        : ['exec', '--full-auto', ...modelArgs(PORTIFY_MODELS.codex), prompt]
    // Absolute path when resolvable; bare name otherwise so spawn surfaces a
    // real ENOENT through the 'error' handler below.
    const bin = resolveAgentBinary(agent) ?? agent
    let out: number | null = null
    if (logPath) {
      try { out = fs.openSync(logPath, 'a') } catch { out = null }
    }
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    children?.add(child)
    let idleTimer: IdleTimer | undefined
    // Tee output to the debug log and reset the idle clock on every chunk — the
    // primary liveness signal, same as the wizard/coverage runners.
    const onChunk = (chunk: Buffer): void => {
      idleTimer?.bump()
      if (out !== null) { try { fs.writeSync(out, chunk) } catch { /* best effort */ } }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    const cleanup = (): void => {
      idleTimer?.stop()
      children?.delete(child)
      if (out !== null) { try { fs.closeSync(out) } catch { /* noop */ } }
    }
    // Backstop activity signal: session-JSONL growth (claude) / log growth (codex).
    const activityPath = agent === 'claude' && sessionId
      ? claudeSessionLogPath(cwd, sessionId)
      : logPath
    idleTimer = startIdleTimer({
      idleMs: PORTIFY_IDLE_TIMEOUT_MS,
      activity: activityPath ? () => { try { return fs.statSync(activityPath).size } catch { return 0 } } : undefined,
      onIdle: () => { child.kill('SIGTERM') },
    })
    // Normal exit (any code) resolves — a non-zero agent still may have made
    // useful edits; the double-boot verifier is the real arbiter.
    child.on('close', () => { cleanup(); resolve() })
    // A spawn failure (CLI missing / not launchable) is NOT a normal run that
    // simply made no edits — record it to the log and reject so the caller can
    // report it instead of letting verify mislabel it "no port slots declared".
    child.on('error', (err) => {
      const msg = `could not launch the ${agent} CLI (${bin}): ${err.message}`
      if (out !== null) { try { fs.writeSync(out, `\n${msg}\n`) } catch { /* noop */ } }
      cleanup()
      reject(new Error(msg))
    })
  })
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
