import type { AuditEntry, ExternalHealClientKind, RunLifecycleEvent } from '../../../shared/api/types'
import type { RunLifecyclePhase, RunLifecycleSeverity } from '../../../../../../shared/run-state'
import { formatDuration } from '../../../shared/lib/format'

export type TimelineRowSource = 'engine' | 'external'

// A display-ready row for the unified Run Logs timeline. Engine rows come from
// the orchestrator lifecycle; external rows come from the MCP audit trail. Both
// render with the same flat anatomy — external rows only add a muted client tag.
export interface TimelineRow {
  key: string
  ts: string
  severity: RunLifecycleSeverity
  headline: string
  detail: string | null
  durationLabel: string | null
  clientLabel: string | null
  source: TimelineRowSource
  event: RunLifecycleEvent | null
  isLastEngine: boolean
}

// Merge orchestrator lifecycle events and external MCP audit entries into one
// chronological timeline. Engine durations are measured between consecutive
// *engine* events (computed against the original array), so interleaved
// external rows never skew a "took Xs" gap.
export function buildTimelineRows(
  events: RunLifecycleEvent[],
  audit: AuditEntry[],
  opts: { now: number },
): TimelineRow[] {
  const rows: TimelineRow[] = [
    ...events.map((_event, idx) => engineRow(events, idx, opts.now)),
    ...audit.map((entry, idx) => externalRow(entry, idx)),
  ]
  rows.sort((a, b) => {
    const ta = Date.parse(a.ts)
    const tb = Date.parse(b.ts)
    if (ta !== tb) return ta - tb
    // Engine rows win ties so a duration gap anchors to the engine lifecycle.
    return sourceRank(a.source) - sourceRank(b.source)
  })
  return rows
}

function sourceRank(source: TimelineRowSource): number {
  return source === 'engine' ? 0 : 1
}

function engineRow(events: RunLifecycleEvent[], idx: number, now: number): TimelineRow {
  const event = events[idx]
  return {
    key: `engine:${event.id ?? `${event.updatedAt}:${idx}`}`,
    ts: event.updatedAt,
    severity: event.severity ?? 'info',
    headline: event.headline,
    detail: event.detail ?? null,
    durationLabel: lifecycleDurationLabel(events, idx, now),
    clientLabel: null,
    source: 'engine',
    event,
    isLastEngine: idx === events.length - 1,
  }
}

function externalRow(entry: AuditEntry, idx: number): TimelineRow {
  const mapped = mapExternalAction(entry.action)
  return {
    key: `external:${entry.ts}:${idx}`,
    ts: entry.ts,
    severity: mapped.severity,
    headline: mapped.headline,
    detail: formatArgsSummary(entry.args),
    durationLabel: null,
    clientLabel: entry.clientKind ? clientLabel(entry.clientKind) : null,
    source: 'external',
    event: null,
    isLastEngine: false,
  }
}

// Headlines are sentence-cased so external rows read like the engine lifecycle
// events they sit beside ("Starting services", "Run failed").
function mapExternalAction(action: string): { headline: string; severity: RunLifecycleSeverity } {
  switch (action) {
    case 'claim': return { headline: 'Claimed the heal', severity: 'success' }
    case 'claim-reconnect': return { headline: 'Reconnected to the heal', severity: 'success' }
    case 'claim-rejected': return { headline: 'Heal claim rejected', severity: 'error' }
    case 'stale-disconnect': return { headline: 'Went stale — disconnected', severity: 'warning' }
    case 'release': return { headline: 'Released the heal', severity: 'info' }
    case 'handoff': return { headline: 'Handed off the heal', severity: 'info' }
    default: return { headline: capitalize(action), severity: 'info' }
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

export function lifecycleDurationLabel(events: RunLifecycleEvent[], idx: number, now: number): string | null {
  const start = Date.parse(events[idx]?.updatedAt ?? '')
  if (!Number.isFinite(start)) return null
  const next = events[idx + 1]
  if (next) {
    const end = Date.parse(next.updatedAt)
    if (!Number.isFinite(end) || end < start) return null
    return `took ${formatDuration(end - start)}`
  }
  if (isTerminalLifecyclePhase(events[idx].phase)) return null
  return `for ${formatDuration(Math.max(0, now - start))}`
}

export function isTerminalLifecyclePhase(phase: RunLifecyclePhase): boolean {
  return phase === 'passed' || phase === 'failed' || phase === 'aborted' || phase === 'completed'
}

function formatArgsSummary(args: Record<string, unknown> | undefined): string | null {
  if (!args || Object.keys(args).length === 0) return null
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value == null) continue
    if (typeof value === 'string') {
      parts.push(`${key}=${truncate(value, 40)}`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${String(value)}`)
    } else {
      parts.push(`${key}=${truncate(JSON.stringify(value), 40)}`)
    }
    if (parts.length >= 3) break
  }
  return parts.length === 0 ? null : parts.join('  ')
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export function clientLabel(kind: ExternalHealClientKind): string {
  switch (kind) {
    case 'claude-cli': return 'Claude CLI'
    case 'claude-desktop': return 'Claude Desktop'
    case 'codex-cli': return 'Codex CLI'
    case 'codex-desktop': return 'Codex Desktop'
    case 'other': return 'External'
  }
}
