// Pure formatting helpers used by the read-only views.

import type { RunStatus } from '../api/types'

// Tailwind class string per status. Picked once here so the badge component
// stays trivial and the mapping is testable.
export function statusBadgeClass(status: RunStatus): string {
  switch (status) {
    case 'passed':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
    case 'failed':
      return 'bg-rose-500/20 text-rose-300 border-rose-500/40'
    case 'running':
      return 'bg-sky-500/20 text-sky-300 border-sky-500/40'
    case 'healing':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40'
    case 'aborted':
      return 'bg-zinc-500/20 text-zinc-300 border-zinc-500/40'
    default:
      return 'bg-zinc-500/20 text-zinc-300 border-zinc-500/40'
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
