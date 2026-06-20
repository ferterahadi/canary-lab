import fs from 'fs'
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { modelArgs } from '../../agent-sessions/logic/agent-models'
import { startIdleTimer, type IdleTimer } from '../../agent-sessions/logic/agent-idle-timer'

// One home for spawning an agent CLI (the Portify model): pipe stdout/stderr,
// reset the idle clock on every chunk (the liveness signal), kill on a genuine
// idle stall, and expose the child + a result promise. Every agent feature
// (wizard, coverage annotate/PRD, eval rewrite, portify, sabotage) composes this
// instead of re-implementing spawn+tee+idle. See the `cl_reuse-shared-logic` skill.

// The claude agentic argv — tools on, plus stream-json so stdout streams
// token-by-token (claude `-p` is otherwise silent during its final-message
// composition, which trips the idle clock). Consumed only for liveness + answer
// recovery; the live view is the session JSONL tail.
export function buildClaudeAgenticArgs(
  prompt: string,
  opts: { model?: string | null; sessionId?: string; resume?: boolean } = {},
): string[] {
  return [
    '-p', prompt,
    '--dangerously-skip-permissions',
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
}

export function runAgentProcess(opts: RunAgentProcessOpts): AgentProcessHandle {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn
  const captureStdout = opts.captureStdout ?? true
  const useStdin = opts.stdin !== undefined
  const child = spawnImpl(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let idleTimer: IdleTimer | undefined

  const done = new Promise<AgentProcessResult>((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      idleTimer?.stop()
      if (err) reject(err)
      else resolve({ code, signal, stdout, stderr })
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

  try { child.stdin?.end(useStdin ? opts.stdin : undefined) } catch { /* ignore */ }

  return {
    child,
    done,
    stop: (signal: NodeJS.Signals = 'SIGTERM') => { try { child.kill(signal) } catch { /* already dead */ } },
  }
}
