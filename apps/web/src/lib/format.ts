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

// Short timestamp (HH:MM:SS) extracted from an ISO string. Falls back to the
// raw input if it doesn't parse.
export function shortTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
