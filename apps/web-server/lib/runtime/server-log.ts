import fs from 'fs'
import path from 'path'

// Captures the canary-lab UI *server process's own* stdout/stderr to a
// per-launch log file under `<logsDir>/server/`, while still echoing to the
// terminal. This exists to diagnose why the server itself misbehaved or
// crashed — console output, Fastify route errors, uncaught exceptions — which
// otherwise live only in the launching terminal's scrollback.
//
// This is deliberately distinct from the per-run service logs in
// `<logsDir>/runs/<runId>/svc-*.log`. Service PTY output is read
// programmatically by the orchestrator and never reaches this process's
// stdout, so it is not duplicated here.
//
// Writes go through `fs.writeSync` rather than a buffered WriteStream so a
// crash can't lose the diagnostics that explain it — server stdout volume is
// low (narration + errors, not service output), so synchronous appends are
// cheap.

export const SERVER_LOG_DIR = 'server'
export const DEFAULT_SERVER_LOG_RETENTION = 10

const FILENAME_RE = /^canary-ui-.*\.log$/

export interface ServerLogHandle {
  logPath: string
  // Restores the original stream writes and crash handlers, then closes the
  // file. Not needed on normal process exit (the OS closes the fd), but kept
  // for the relaunch path and tests.
  dispose(): void
}

export function serverLogDir(logsDir: string): string {
  return path.join(logsDir, SERVER_LOG_DIR)
}

// Filesystem-safe, lexicographically-sortable timestamp so pruning can sort by
// name: `canary-ui-2026-06-08T14-30-05-123Z.log`.
export function serverLogFilename(date: Date): string {
  return `canary-ui-${date.toISOString().replace(/[:.]/g, '-')}.log`
}

export function resolveServerLogRetention(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CANARY_LAB_SERVER_LOG_RETENTION
  if (!raw) return DEFAULT_SERVER_LOG_RETENTION
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SERVER_LOG_RETENTION
  return parsed
}

export interface PruneServerLogsResult {
  kept: string[]
  removed: string[]
}

// Keeps the most recent N server logs and deletes the rest. Best-effort: any
// fs error is swallowed so logging setup never blocks server boot.
export function pruneServerLogs(
  logsDir: string,
  retention: number = resolveServerLogRetention(),
): PruneServerLogsResult {
  if (retention <= 0) return { kept: [], removed: [] }
  const dir = serverLogDir(logsDir)
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((n) => FILENAME_RE.test(n)).sort()
  } catch {
    return { kept: [], removed: [] }
  }
  if (names.length <= retention) return { kept: names, removed: [] }
  const removed = names.slice(0, names.length - retention)
  const kept = names.slice(names.length - retention)
  for (const n of removed) {
    try { fs.rmSync(path.join(dir, n), { force: true }) } catch { /* best-effort */ }
  }
  return { kept, removed }
}

export interface InstallServerLoggingOptions {
  now?: () => Date
  retention?: number
  // Injectable for tests so we don't tee the real process streams.
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  stderr?: Pick<NodeJS.WriteStream, 'write'>
  proc?: Pick<NodeJS.Process, 'on' | 'off' | 'exit' | 'pid'>
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

// Tee `stream.write` into the open fd while preserving the original write's
// arguments and return value (backpressure signal). Returns a restore fn.
function teeStream(
  stream: Pick<NodeJS.WriteStream, 'write'>,
  fd: number,
): () => void {
  const original = stream.write as NodeJS.WriteStream['write']
  const boundOriginal = original.bind(stream) as (...a: unknown[]) => boolean
  const patched = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    try {
      if (typeof chunk === 'string') fs.writeSync(fd, chunk)
      else if (chunk != null) fs.writeSync(fd, chunk as Uint8Array)
    } catch { /* never let logging break real output */ }
    return boundOriginal(chunk, ...rest)
  }
  ;(stream as { write: unknown }).write = patched
  // Restore the exact original reference, not a bound copy.
  return () => { (stream as { write: unknown }).write = original }
}

/**
 * Begin capturing the server process's own stdout/stderr to
 * `<logsDir>/server/canary-ui-<timestamp>.log`, echoing through to the
 * terminal unchanged. Also records uncaught exceptions and unhandled
 * rejections — the crashes this feature exists to diagnose.
 *
 * Uncaught exceptions use `uncaughtExceptionMonitor`, which logs *without*
 * altering Node's default crash-and-exit behavior. Unhandled rejections are
 * logged and then re-raised via `process.exit(1)` to match Node's default
 * termination (registering any `unhandledRejection` listener otherwise
 * suppresses that default).
 */
export function installServerLogging(
  logsDir: string,
  opts: InstallServerLoggingOptions = {},
): ServerLogHandle {
  const now = opts.now ?? (() => new Date())
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  const proc = opts.proc ?? process

  const dir = serverLogDir(logsDir)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, serverLogFilename(now()))
  const fd = fs.openSync(logPath, 'a')
  fs.writeSync(fd, `=== canary-lab ui — ${now().toISOString()} — pid ${proc.pid} ===\n`)

  // Prune after creating the new file (it sorts newest, so it's always kept).
  try { pruneServerLogs(logsDir, opts.retention) } catch { /* best-effort */ }

  const restoreStdout = teeStream(stdout, fd)
  const restoreStderr = teeStream(stderr, fd)

  const onUncaught = (err: Error): void => {
    try { fs.writeSync(fd, `\n=== uncaughtException — ${now().toISOString()} ===\n${formatError(err)}\n`) } catch { /* ignore */ }
  }
  const onRejection = (reason: unknown): void => {
    try { fs.writeSync(fd, `\n=== unhandledRejection — ${now().toISOString()} ===\n${formatError(reason)}\n`) } catch { /* ignore */ }
    // Match Node's default: an unhandled rejection terminates the process.
    proc.exit(1)
  }
  proc.on('uncaughtExceptionMonitor', onUncaught)
  proc.on('unhandledRejection', onRejection)

  let disposed = false
  return {
    logPath,
    dispose(): void {
      if (disposed) return
      disposed = true
      restoreStdout()
      restoreStderr()
      proc.off('uncaughtExceptionMonitor', onUncaught)
      proc.off('unhandledRejection', onRejection)
      try { fs.closeSync(fd) } catch { /* ignore */ }
    },
  }
}
