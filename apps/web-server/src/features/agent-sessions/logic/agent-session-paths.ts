// Locate, parse, and normalize the structured session log that the heal
// agent's CLI persists by itself.
//
// Both `claude` and `codex` write a JSONL session record outside our run
// directory:
//
//   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso-ts>-<uuid>.jsonl
//
// The shapes differ but carry the same information — user/assistant
// messages, tool calls, tool results, timestamps. The historical replay
// path renders the normalized stream instead of the raw PTY transcript,
// which is dominated by TUI redraw noise that doesn't replay cleanly.
//
// Locator strategy:
//   - claude: we pin the session UUID at spawn (`--session-id <uuid>`) so
//     the log path is fully determined by `runDir` + uuid.
//   - codex: no `--session-id` flag exists, so we discover the log
//     post-hoc by matching `session_meta.cwd === runDir` and
//     `session_meta.timestamp >= cycleStartedAt`. The runDir is unique
//     per run, so there's no cross-run ambiguity.

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentKind, AgentSessionRef } from './agent-session-log'

// ─── Config-dir resolution ─────────────────────────────────────────────────
//
// Each agent CLI stores its session JSONL under a config dir that the CLI
// itself lets you relocate via an env var — claude reads `CLAUDE_CONFIG_DIR`,
// codex reads `CODEX_HOME`. When unset they fall back to the conventional
// dotdir under the user's home. We resolve these EXACTLY as the CLIs do, so a
// relocated config home (multi-account, sandboxed, or CI setups) doesn't
// silently break session lookup — the failure mode is a blank AgentSessionView,
// which reads as "the agent produced nothing" rather than "we looked in the
// wrong place". `process.env` is read here (not threaded as a param) because
// the server process that reads a log is the same process that spawned the
// agent, so its env matches what the agent saw at spawn time.

export function claudeConfigDir(homeDir: string = os.homedir()): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  return override ? override : path.join(homeDir, '.claude')
}

export function codexConfigDir(homeDir: string = os.homedir()): string {
  const override = process.env.CODEX_HOME?.trim()
  return override ? override : path.join(homeDir, '.codex')
}

// ─── Claude locator ────────────────────────────────────────────────────────

// Claude encodes a project directory as the absolute path with every character
// outside `[A-Za-z0-9]` replaced by `-`. So `/Users/dev/foo` becomes
// `-Users-dev-foo`, and `/var/folders/s_/x` becomes `-var-folders-s--x`.
//
// This slug is an observed convention of the published CLI, and it CHANGED:
// older builds folded only `/`, leaving dots and underscores intact. Measured
// against a live install on 2026-08-04 (claude 2.1.220): of 119 project dirs in
// `~/.claude/projects`, the 118 written by recent builds are pure
// `[A-Za-z0-9-]`, and the single dir preserving an underscore was last written
// 2026-04-08. Assuming the old rule silently mislocated every log whose cwd held
// a `.` or `_` — which is every macOS temp dir (`/var/folders/s_/…`), so every
// demo, smoke, and temp-dir flight run.
//
// Treat this as a best guess at someone else's private format, not a contract:
// prefer `findClaudeLogBySessionId` whenever a pinned session id is in hand, and
// use `claudeProjectDirCandidates` when it isn't.
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// Every project-dir slug a log for `cwd` could plausibly live under, newest
// convention first. Lookups that have no session id to fall back on must try
// both, or a run whose log was written by an older CLI stops resolving the
// moment we adopt the new rule.
export function claudeProjectDirCandidates(cwd: string): string[] {
  const current = encodeClaudeProjectDir(cwd)
  const legacy = cwd.replace(/\//g, '-')
  return current === legacy ? [current] : [current, legacy]
}

// The path claude writes its session JSONL to for a pinned session id — computed
// even before the file exists (for idle-timer activity polling). Uses the real
// path because claude encodes the resolved cwd. Best-effort: callers stat it and
// treat a missing file as zero activity.
export function claudeSessionLogPath(cwd: string, sessionId: string, homeDir: string = os.homedir()): string {
  let real = cwd
  try { real = fs.realpathSync(cwd) } catch { /* fall back to the raw cwd */ }
  return path.join(claudeConfigDir(homeDir), 'projects', encodeClaudeProjectDir(real), `${sessionId}.jsonl`)
}

export function locateClaudeSessionLog(
  runDir: string,
  sessionId: string,
  homeDir: string = os.homedir(),
): string | null {
  if (!sessionId) return null
  const base = path.join(claudeConfigDir(homeDir), 'projects')
  // Claude encodes the RESOLVED cwd, so a symlinked runDir predicts the wrong
  // slug — same silent miss as a stale encoding rule.
  for (const encoded of claudeProjectDirCandidates(realpathOrSelf(runDir))) {
    const candidate = path.join(base, encoded, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  // The slug is a guess at claude's private format; the session id is ours,
  // pinned via `--session-id`, and globally unique. When the cwd-derived path
  // misses, scanning by id is strictly more reliable than a cleverer slug —
  // it's what `resolveWorkflowAgentRef` already does for the same reason.
  return findClaudeLogBySessionId(sessionId, homeDir)
}

// Locate a Claude session log by its (globally-unique) session id alone,
// scanning every project dir. Encoding-agnostic — Claude's project-dir slug
// isn't a pure `/`→`-` mapping (it also folds `_`→`-`, etc.), so when we know
// the cwd-derived path may be wrong we fall back to this.
export function findClaudeLogBySessionId(
  sessionId: string,
  homeDir: string = os.homedir(),
): string | null {
  if (!sessionId) return null
  const base = path.join(claudeConfigDir(homeDir), 'projects')
  let dirs: string[]
  try { dirs = fs.readdirSync(base) } catch { return null }
  for (const dir of dirs) {
    const candidate = path.join(base, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// Find the newest Claude session for a run directory without requiring a
// sidecar session id. Older/interrupted runs can lack `agent-session-id.txt`,
// but Claude still writes JSONL logs under the encoded run directory.
export function locateLatestClaudeSessionLog(
  runDir: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  const base = path.join(claudeConfigDir(homeDir), 'projects')
  let best: { logPath: string; sessionId: string; mtimeMs: number } | null = null
  // No session id here, so there's no by-id fallback to lean on — scan every
  // slug this cwd could have been written under and take the newest log across
  // all of them. A run straddling a CLI upgrade legitimately has logs in both.
  for (const encoded of claudeProjectDirCandidates(realpathOrSelf(runDir))) {
    const projectDir = path.join(base, encoded)
    for (const name of readDirNames(projectDir)) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      if (!sessionId) continue
      const candidate = path.join(projectDir, name)
      let stat: fs.Stats
      try { stat = fs.statSync(candidate) } catch { continue }
      if (!stat.isFile()) continue
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { logPath: candidate, sessionId, mtimeMs: stat.mtimeMs }
      }
    }
  }
  if (!best) return null
  return { agent: 'claude', sessionId: best.sessionId, logPath: best.logPath }
}

// ─── Codex locator ─────────────────────────────────────────────────────────

export interface CodexSessionMeta {
  id: string
  cwd: string
  timestamp: string
}

// First-line shape: `{ type: 'session_meta', timestamp, payload: { id, cwd, timestamp, ... } }`.
//
// Codex 0.130+ embeds the full agent base-instructions prompt inside
// `payload.base_instructions.text`, which pushes the first JSONL line well
// past 100 KB. Read in chunks until we hit `\n` (or hit `MAX_FIRST_LINE`)
// instead of capping at a fixed buffer — a too-small buffer truncates the
// JSON and makes the locator silently return null for every real session.
export function readCodexSessionMeta(jsonlPath: string): CodexSessionMeta | null {
  const firstLine = readFirstLine(jsonlPath)
  if (firstLine === null) return null
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string
      payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown }
    }
    if (parsed.type !== 'session_meta' || !parsed.payload) return null
    const { id, cwd, timestamp } = parsed.payload
    if (typeof id !== 'string' || typeof cwd !== 'string' || typeof timestamp !== 'string') return null
    return { id, cwd, timestamp }
  } catch {
    return null
  }
}

export const FIRST_LINE_CHUNK_BYTES = 64 * 1024

export const FIRST_LINE_MAX_BYTES = 2 * 1024 * 1024

export function readFirstLine(jsonlPath: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(jsonlPath, 'r')
    const chunks: Buffer[] = []
    let total = 0
    while (total < FIRST_LINE_MAX_BYTES) {
      const buf = Buffer.alloc(FIRST_LINE_CHUNK_BYTES)
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      const slice = buf.subarray(0, n)
      const nl = slice.indexOf(0x0a)
      if (nl >= 0) {
        chunks.push(slice.subarray(0, nl))
        return Buffer.concat(chunks).toString('utf-8')
      }
      chunks.push(slice)
      total += n
    }
    return chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : null
  } catch {
    return null
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* ignore */ }
  }
}

export function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p) } catch { return p }
}

// Walk codex's date-bucketed session dirs from the cycle's start date through
// the next two days (covers UTC date rollover and unusually long cycles).
// Match by realpath(cwd) and timestamp >= cycleStartedAt. Return the newest
// match — heal agents are spawned sequentially, so there's typically one.
export function locateCodexSessionLog(
  runDir: string,
  cycleStartedAt: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  const startMs = Date.parse(cycleStartedAt)
  if (!Number.isFinite(startMs)) return null
  const wantedCwd = realpathOrSelf(runDir)

  const sessionsRoot = path.join(codexConfigDir(homeDir), 'sessions')
  if (!fs.existsSync(sessionsRoot)) return null

  const startDate = new Date(startMs)
  const datesToScan: Array<{ y: string; m: string; d: string }> = []
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const d = new Date(startDate.getTime() + dayOffset * 86_400_000)
    datesToScan.push({
      y: d.getUTCFullYear().toString().padStart(4, '0'),
      m: (d.getUTCMonth() + 1).toString().padStart(2, '0'),
      d: d.getUTCDate().toString().padStart(2, '0'),
    })
  }

  let best: { logPath: string; sessionId: string; ts: number } | null = null
  for (const { y, m, d } of datesToScan) {
    const dir = path.join(sessionsRoot, y, m, d)
    for (const name of readDirNames(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const candidate = path.join(dir, name)
      const meta = readCodexSessionMeta(candidate)
      if (!meta) continue
      const metaTs = Date.parse(meta.timestamp)
      if (!Number.isFinite(metaTs) || metaTs < startMs) continue
      if (realpathOrSelf(meta.cwd) !== wantedCwd) continue
      if (!best || metaTs > best.ts) {
        best = { logPath: candidate, sessionId: meta.id, ts: metaTs }
      }
    }
  }
  if (!best) return null
  return { agent: 'codex', sessionId: best.sessionId, logPath: best.logPath }
}

// ─── Workflow-dir agent-session ref (benchmark, portify) ─────────────────────
//
// Benchmark + portify both spawn a one-shot agent in a scratch worktree and
// surface its session through the shared AgentSessionView. They write a
// `<dir>/agent-session.json` the endpoint/WS resolve from:
//   - claude: the log path is fully determined by cwd + the pinned session id,
//     so persist the ref eagerly.
//   - codex:  there is no `--session-id` flag, so the log path isn't known at
//     spawn — persist the cwd + spawn time and discover the session post-hoc
//     (live), exactly like the heal/draft codex path.

export interface CodexDiscoveryHint {
  cwd: string
  spawnedAt: string
}

export function readCodexDiscoveryHint(raw: string): CodexDiscoveryHint | null {
  let obj: unknown
  try { obj = JSON.parse(raw) } catch { return null }
  const disc = (obj as { codexDiscovery?: unknown })?.codexDiscovery
  if (!disc || typeof disc !== 'object') return null
  const { cwd, spawnedAt } = disc as { cwd?: unknown; spawnedAt?: unknown }
  if (typeof cwd !== 'string' || typeof spawnedAt !== 'string') return null
  return { cwd, spawnedAt }
}

// Find the newest Codex session for a run directory without requiring a cycle
// start timestamp. Older/interrupted runs can lack the `agent-session-id.txt`
// sidecar; Codex's own JSONL session store is the only durable record in that
// case.
//
// Walks YYYY/MM/DD descending and stops at the first day with a cwd match.
// Bucket dates are zero-padded strings, so reverse-sorted lexical order is
// also reverse-sorted by date.
export function locateLatestCodexSessionLog(
  runDir: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  const wantedCwd = realpathOrSelf(runDir)
  const sessionsRoot = path.join(codexConfigDir(homeDir), 'sessions')

  // Codex filenames follow `rollout-<ISO-ts>-<id>.jsonl`, so lex-descending
  // order matches chronological order. Iterate newest-first and return on the
  // first cwd match — avoids reading every JSONL's first line when only the
  // newest one matters.
  for (const y of readDirNames(sessionsRoot).sort().reverse()) {
    const yearDir = path.join(sessionsRoot, y)
    for (const m of readDirNames(yearDir).sort().reverse()) {
      const monthDir = path.join(yearDir, m)
      for (const d of readDirNames(monthDir).sort().reverse()) {
        const dayDir = path.join(monthDir, d)
        for (const name of readDirNames(dayDir).sort().reverse()) {
          if (!name.endsWith('.jsonl')) continue
          const candidate = path.join(dayDir, name)
          const meta = readCodexSessionMeta(candidate)
          if (!meta) continue
          if (realpathOrSelf(meta.cwd) !== wantedCwd) continue
          if (!Number.isFinite(Date.parse(meta.timestamp))) continue
          return { agent: 'codex', sessionId: meta.id, logPath: candidate }
        }
      }
    }
  }
  return null
}

export function readDirNames(dir: string): string[] {
  try { return fs.readdirSync(dir) } catch { return [] }
}

// Dispatch the per-agent "latest session for this run dir" locator. Each
// agent CLI stores its sessions under a different layout, so the two
// underlying functions can't share a path; this just selects between them.
export function locateLatestSessionLogForAgent(
  agent: AgentKind,
  runDir: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  return agent === 'claude'
    ? locateLatestClaudeSessionLog(runDir, homeDir)
    : locateLatestCodexSessionLog(runDir, homeDir)
}

export function safeMtimeMs(p: string): number {
  try { return fs.statSync(p).mtimeMs } catch { return 0 }
}
