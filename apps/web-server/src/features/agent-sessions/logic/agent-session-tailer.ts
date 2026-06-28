import fs from 'fs'
import {
  type AgentEvent,
  type AgentKind,
  type AgentSessionRef,
  claudeSessionLogPath,
  locateLatestSessionLogForAgent,
  parseAgentSessionLine,
} from '../../agent-sessions/logic/agent-session-log'

// Tails an agent CLI's JSONL session log and emits normalized events as new
// lines are appended.
//
// Both claude and codex write their session JSONL incrementally during a run,
// so subscribers see the same event stream live as they would post-hoc via
// `loadAgentSessionLog`. The tailer:
//
//   1. Emits all currently-present events on attach (`replay`).
//   2. Watches the file with `fs.watch` and re-reads the tail on change,
//      emitting events parsed from the newly-appended bytes.
//   3. If the file doesn't exist yet (codex hasn't written the rollout file),
//      polls the parent directory until the matching log appears, then
//      switches to watch mode.
//
// `close()` stops the watcher and cancels any pending re-reads.

export interface TailHandle {
  close(): void
}

export interface TailOptions {
  // Initial reference. For codex, `logPath` may not exist yet — the tailer
  // will try `discoverRef` to locate it once it appears on disk.
  ref: AgentSessionRef
  onEvent(event: AgentEvent): void
  onError?(err: Error): void
  // Optional resolver for cases where `ref.logPath` is not yet known on disk
  // (codex spawns can't pin a session id up front). Called on a backoff until
  // it returns a ref whose `logPath` exists.
  discoverRef?(): AgentSessionRef | null
  onReady?(ref: AgentSessionRef): void
  // Overridable for tests; defaults match a 2-minute discovery window.
  pollIntervalMs?: number
  pollMaxAttempts?: number
}

const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_POLL_MAX_ATTEMPTS = 240

export function tailAgentSession(opts: TailOptions): TailHandle {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const pollMaxAttempts = opts.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS
  let closed = false
  let watcher: fs.FSWatcher | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollAttempts = 0
  let ref: AgentSessionRef = opts.ref
  // Track how many bytes of the file we've already parsed so re-reads on
  // change only emit newly-appended events.
  let bytesRead = 0
  let pendingFlush = false

  const emit = (events: AgentEvent[]): void => {
    for (const ev of events) {
      try { opts.onEvent(ev) } catch { /* subscriber failures must not crash the tailer */ }
    }
  }

  const reportError = (err: Error): void => {
    try { opts.onError?.(err) } catch { /* ignore */ }
  }

  const flush = (): void => {
    if (closed) return
    pendingFlush = false
    let raw: Buffer
    try {
      const fd = fs.openSync(ref.logPath, 'r')
      try {
        const stat = fs.fstatSync(fd)
        if (stat.size <= bytesRead) return
        const len = stat.size - bytesRead
        raw = Buffer.alloc(len)
        fs.readSync(fd, raw, 0, len, bytesRead)
        bytesRead = stat.size
      } finally {
        try { fs.closeSync(fd) } catch { /* ignore */ }
      }
    } catch (err) {
      reportError(err as Error)
      return
    }
    const text = raw.toString('utf-8')
    // The file may end mid-line. Split on '\n', keep complete lines, and
    // rewind `bytesRead` past any trailing partial line so the next flush
    // re-reads it once it's terminated.
    const lastNl = text.lastIndexOf('\n')
    const complete = lastNl === -1 ? '' : text.slice(0, lastNl)
    const trailingBytes = Buffer.byteLength(text.slice(lastNl + 1), 'utf-8')
    bytesRead -= trailingBytes
    if (!complete) return
    const events: AgentEvent[] = []
    for (const line of complete.split('\n')) {
      for (const ev of parseAgentSessionLine(ref.agent, line)) events.push(ev)
    }
    emit(events)
  }

  const scheduleFlush = (): void => {
    if (closed || pendingFlush) return
    pendingFlush = true
    // `fs.watch` can fire multiple events for a single append on some
    // platforms; coalesce into a single read on the next tick.
    setImmediate(flush)
  }

  const startWatching = (): void => {
    if (closed) return
    try {
      watcher = fs.watch(ref.logPath, { persistent: false }, () => scheduleFlush())
    } catch (err) {
      reportError(err as Error)
      return
    }
    try { opts.onReady?.(ref) } catch { /* subscriber failures must not crash the tailer */ }
    // Emit everything currently present.
    flush()
    // Some agents write the file in one go after our initial flush; trigger
    // an extra flush shortly after to catch that case.
    setTimeout(scheduleFlush, 100)
  }

  const tryResolve = (): void => {
    if (closed) return
    if (fs.existsSync(ref.logPath)) {
      startWatching()
      return
    }
    if (opts.discoverRef) {
      const discovered = opts.discoverRef()
      if (discovered && fs.existsSync(discovered.logPath)) {
        ref = discovered
        startWatching()
        return
      }
    }
    if (++pollAttempts > pollMaxAttempts) {
      reportError(new Error(`agent-session-tailer: gave up waiting for ${ref.logPath}`))
      return
    }
    pollTimer = setTimeout(tryResolve, pollIntervalMs)
  }

  tryResolve()

  return {
    close(): void {
      closed = true
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      if (watcher) {
        try { watcher.close() } catch { /* ignore */ }
        watcher = null
      }
    },
  }
}

// Convenience: build a `discoverRef` that re-runs the latest-session locator
// for a given runDir. Used by both the runs and drafts WS handlers when the
// JSONL path isn't pinned at spawn time (codex).
export function locatorForAgentInDir(
  agent: AgentKind,
  runDir: string,
  spawnedAt?: string,
): () => AgentSessionRef | null {
  return () => {
    const ref = locateLatestSessionLogForAgent(agent, runDir)
    if (!ref) return null
    if (spawnedAt) {
      // Skip stale sessions from before this spawn. mtime is a cheap proxy.
      try {
        const stat = fs.statSync(ref.logPath)
        if (stat.mtimeMs < Date.parse(spawnedAt) - 1000) return null
      } catch { return null }
    }
    return ref
  }
}

// Resolve the JSONL path that the tailer should watch given a directory the
// agent was launched in. For claude, the project dir + session uuid is
// deterministic; for codex we leave `logPath` empty and let the tailer's
// discover loop resolve it once it appears.
export function refForAgentSpawn(opts: {
  agent: AgentKind
  cwd: string
  sessionId?: string
}): AgentSessionRef {
  if (opts.agent === 'claude' && opts.sessionId) {
    return {
      agent: 'claude',
      sessionId: opts.sessionId,
      // Canonical resolver: honors CLAUDE_CONFIG_DIR + realpath/encoding rules
      // instead of recomputing `~/.claude/projects/...` (and `$HOME`) by hand.
      logPath: claudeSessionLogPath(opts.cwd, opts.sessionId),
    }
  }
  return {
    agent: opts.agent,
    sessionId: opts.sessionId ?? '',
    logPath: '',
  }
}
