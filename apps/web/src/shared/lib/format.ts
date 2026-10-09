// Pure formatting helpers used by the read-only views.

/** Sentence-case a state word for display: only the FIRST character is raised,
 *  so a two-word label stays "Needs approval" rather than the title-cased
 *  "Needs Approval" a CSS `text-transform: capitalize` would produce. */
export function capitalizeFirst(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1)
}

// Format a duration (in milliseconds) as a short human string. Examples:
//   500   -> "0.5s"
//   12_500 -> "12.5s"
//   125_000 -> "2m 5s"
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  // The cut-offs sit where the printed value rolls over, not at the raw value:
  // 59.96s prints as "60.0s" and 21m 59.6s as "21m 60s" if each part is
  // rounded after the split.
  if (totalSeconds < 59.95) {
    return `${totalSeconds.toFixed(1)}s`
  }
  const whole = Math.round(totalSeconds)
  return `${Math.floor(whole / 60)}m ${whole % 60}s`
}

// A still-running clock, in whole seconds. Distinct from `formatDuration`: that
// one reports a *measured* duration and prints a tenth, which a once-a-second
// tick doesn't have — so a live clock through it would always read a false
// ".0". Rolls up past a minute so a long wait stays readable ("1200s" -> "20m
// 00s"). Examples: 0 -> "0s", 12 -> "12s", 74 -> "1m 14s", 3700 -> "1h 02m".
export function formatElapsedSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s'
  const secs = Math.floor(seconds)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  if (mins < 60) return `${mins}m ${pad(secs % 60)}s`
  return `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`
}

/** Raw milliseconds between two ISO stamps; null when either is missing or
 *  unparseable. Signed — each public reader decides what a reversed pair means. */
function spanMs(startedAt: string | undefined, endedAt: string | undefined): number | null {
  if (!startedAt || !endedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return end - start
}

// Compute duration from ISO start + (optional) end. If end is missing, treats
// the run as ongoing and returns null. A reversed pair clamps to 0: a run's
// measured duration feeds `formatDuration`, which has no "unknown" rendering.
export function durationBetween(startedAt: string, endedAt?: string): number | null {
  const ms = spanMs(startedAt, endedAt)
  return ms == null ? null : Math.max(0, ms)
}

/** Compact wall-clock span between two ISO stamps ("4s", "2m 14s", "1h 03m"),
 *  rounded to the nearest second. Null when either stamp is missing or
 *  unparseable, or the end precedes the start — a reversed pair is a clock
 *  problem, and printing "0s" for it would claim a measurement. */
export function formatSpan(startedAt: string | undefined, endedAt: string | undefined): string | null {
  const ms = spanMs(startedAt, endedAt)
  if (ms == null || ms < 0) return null
  return formatElapsedSeconds(Math.round(ms / 1000))
}

// Human-readable byte size. Examples: 0 -> "0 B", 2048 -> "2 KB",
// 1.5 GB -> "1.5 GB". One decimal below 100 of a unit, whole numbers above.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

// Thousands-separated count for display: 27627 -> "27,627". Grouped by hand
// rather than via toLocaleString because the separator must not depend on the
// browser's locale — a band tile and its test have to agree on the same string.
export function formatCount(n: number): string {
  return `${n}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Compact "time ago" from an ISO string, relative to `now` (ms). Examples:
// "just now", "5m ago", "3h ago", "12d ago". Falls back to the raw input if
// it doesn't parse.
export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const secs = Math.max(0, Math.round((now - t) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

// Short timestamp (HH:MM:SS) extracted from an ISO string. Falls back to the
// raw input if it doesn't parse.
export function shortTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Short date + time ("Oct 1, 14:02") in the viewer's locale — a stable stamp
 *  for a label that stays on screen, where a relative age would go stale.
 *  Falls back to the raw input if it doesn't parse. */
export function shortDateTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** "Today 14:02" for a stamp from the viewer's current day, otherwise
 *  `shortDateTime` ("Oct 1, 14:02"). A bare clock time on a list that spans
 *  days reads every row as tonight. Falls back to the raw input if it doesn't
 *  parse. */
export function dayTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  if (d.toDateString() !== new Date(now).toDateString()) return shortDateTime(iso)
  return `Today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

/** Cap `text` at `max` characters, the last one an ellipsis when it was cut. */
export function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The first non-blank line, trimmed and capped — a row is one line tall. */
export function firstLineOf(text: string, max = 160): string {
  return truncateText(text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '', max)
}

/** Joins names the way a sentence writes a list: "a", "a and b", "a, b and c". */
export function joinNatural(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** A long session id as its head and tail (`019a2b…7f3c`). Both ends, because
 *  time-ordered ids (Codex's UUIDv7) share a prefix across sessions started
 *  close together; an id of 12 characters or fewer is already short. */
export function shortSession(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId
  return `${sessionId.slice(0, 6)}…${sessionId.slice(-4)}`
}

/** Short, stable run reference for an identity line — the trailing token of
 *  the run id (`…-z6kc` → `z6kc`), falling back to the whole id. */
export function shortRunRef(runId: string): string {
  const tail = runId.split(/[-_]/).pop()
  return tail && tail.length >= 3 ? tail : runId
}

export function formatLocalDateTime(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(time))
}
