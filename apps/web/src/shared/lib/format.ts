// Pure formatting helpers used by the read-only views.

import type { RunStatus } from '../api/types'

/**
 * @deprecated Use the `<RunStatusIndicator status={...} />` component instead.
 * The bordered-pill style this returns is no longer used in the UI — it
 * collided visually with destructive action buttons (Stop / Delete). Kept
 * exported only to avoid breaking any external consumer; new call sites
 * should not be added.
 */
export function statusBadgeClass(status: RunStatus): string {
  switch (status) {
    case 'passed':
      return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-300'
    case 'failed':
      return 'bg-rose-500/15 text-rose-700 border-rose-500/40 dark:text-rose-300'
    case 'running':
      return 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300'
    case 'healing':
      return 'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300'
    case 'aborted':
      return 'bg-zinc-500/15 text-zinc-700 border-zinc-500/40 dark:text-zinc-300'
    default:
      return 'bg-zinc-500/15 text-zinc-700 border-zinc-500/40 dark:text-zinc-300'
  }
}

// Format a duration (in milliseconds) as a short human string. Examples:
//   500   -> "0.5s"
//   12_500 -> "12.5s"
//   125_000 -> "2m 5s"
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds - minutes * 60)
  return `${minutes}m ${seconds}s`
}

// Compute duration from ISO start + (optional) end. If end is missing, treats
// the run as ongoing and returns null.
export function durationBetween(startedAt: string, endedAt?: string): number | null {
  if (!endedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, end - start)
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
