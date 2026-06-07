import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { encodeClaudeProjectDir } from '../../agent-session-log'
import type { HealAgent } from '../auto-heal'

// One-shot, headless agent run for the port-ification edits (mirrors the
// benchmark sabotage agent). Resolves on process exit; permissions auto-accept
// (no human in this loop). For claude we pin a session id on attempt 1 and
// `--resume` it on retries so the agent keeps context across attempts.

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
  return new Promise((resolve) => {
    const { agent, prompt, cwd, logPath, children, sessionId, resume } = opts
    const args =
      agent === 'claude'
        ? [
            '-p', prompt, '--dangerously-skip-permissions',
            ...(sessionId ? (resume ? ['--resume', sessionId] : ['--session-id', sessionId]) : []),
          ]
        : ['exec', '--full-auto', prompt]
    let out: number | 'ignore' = 'ignore'
    if (logPath) {
      try { out = fs.openSync(logPath, 'a') } catch { out = 'ignore' }
    }
    const child = spawn(agent, args, {
      cwd,
      stdio: typeof out === 'number' ? ['ignore', out, out] : 'ignore',
    })
    children?.add(child)
    const done = (): void => {
      children?.delete(child)
      if (typeof out === 'number') { try { fs.closeSync(out) } catch { /* noop */ } }
      resolve()
    }
    child.on('close', done)
    child.on('error', done)
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
