import { useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { AuditEntry, ExternalHealClientKind, RunStatus } from '../api/types'
import { isTerminalRunStatus } from '../../../../shared/run-state'

interface Props {
  runId: string
  runStatus: RunStatus
}

// Activity log for external MCP commands. Tails `<runDir>/external-commands.jsonl`
// via /api/runs/:runId/audit. Polls every 2s while the run is still active; for
// terminal runs the log is final so a single read is enough.
export function ActivityTab({ runId, runStatus }: Props) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const terminal = isTerminalRunStatus(runStatus)

  useEffect(() => {
    let cancelled = false
    const fetchAudit = async (): Promise<void> => {
      try {
        const res = await api.getRunAudit(runId)
        if (cancelled) return
        setEntries(res.entries)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load activity')
      }
    }
    void fetchAudit()
    if (terminal) return () => { cancelled = true }
    const id = window.setInterval(() => { void fetchAudit() }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [runId, terminal])

  if (entries === null && error === null) {
    return <ActivityFrame><LoadingState /></ActivityFrame>
  }
  if (error && entries === null) {
    return <ActivityFrame><ErrorState message={error} /></ActivityFrame>
  }
  const list = entries ?? []
  if (list.length === 0) {
    return <ActivityFrame><EmptyState /></ActivityFrame>
  }

  return (
    <ActivityFrame>
      <Header count={list.length} live={!terminal} />
      <ol className="@container relative mt-3 space-y-1.5">
        <RailSpine />
        {list.map((entry, index) => (
          <AuditRow key={`${entry.ts}:${index}`} entry={entry} />
        ))}
      </ol>
    </ActivityFrame>
  )
}

function ActivityFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-y-auto scrollbar-thin p-3 @[400px]:p-4">
      {children}
    </div>
  )
}

function Header({ count, live }: { count: number; live: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div>
        <h2
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-secondary)' }}
        >
          Activity
        </h2>
        <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
          {count} {count === 1 ? 'event' : 'events'} from external clients
        </div>
      </div>
      {live && (
        <span
          className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full canary-pulse"
            style={{ background: 'var(--success)' }}
          />
          Live
        </span>
      )}
    </div>
  )
}

function RailSpine() {
  // A thin vertical rail anchoring the action dots. Sits at `left: 12px` on
  // small panes, `left: 16px` on wider ones — matches the dot column.
  return (
    <div
      aria-hidden
      className="absolute top-0 bottom-0 w-px @[480px]:left-[18px] left-[14px]"
      style={{
        background: 'linear-gradient(to bottom, var(--border-default) 0%, color-mix(in srgb, var(--border-default) 40%, transparent) 100%)',
      }}
    />
  )
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false)
  const tint = clientTint(entry.clientKind)
  const outcome = inferOutcome(entry)
  const hasDetail = Boolean(entry.args) || Boolean(entry.result)
  const time = formatTime(entry.ts)
  const date = formatDate(entry.ts)
  const summary = formatArgsSummary(entry.args)

  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((open) => !open)}
        className={`cl-card-hover w-full rounded-md py-2 pl-7 pr-3 text-left @[480px]:rounded-lg @[480px]:py-2.5 @[480px]:pl-9 @[480px]:pr-4 ${
          hasDetail ? 'cursor-pointer' : 'cursor-default'
        }`}
        style={{
          background: 'var(--bg-elevated)',
          border: `1px solid color-mix(in srgb, ${tint} 12%, var(--border-default))`,
        }}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <span
          aria-hidden
          className="absolute h-2.5 w-2.5 rounded-full @[480px]:h-3 @[480px]:w-3 @[480px]:left-[12px] left-[8px]"
          style={{
            top: '14px',
            background: outcome.dot,
            boxShadow: outcome.live ? `0 0 0 3px color-mix(in srgb, ${outcome.dot} 18%, transparent)` : `0 0 0 3px var(--bg-base)`,
            border: outcome.live ? 'none' : `1px solid color-mix(in srgb, ${outcome.dot} 60%, transparent)`,
          }}
        />
        <div className="flex min-w-0 items-start gap-2.5 @[480px]:gap-3">
          <BrandMonogram clientKind={entry.clientKind} tint={tint} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span
                className="truncate text-[12px] font-medium @[480px]:text-[13px]"
                style={{
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '-0.005em',
                }}
                title={entry.action}
              >
                {entry.action}
              </span>
              <OutcomePill outcome={outcome} />
            </div>
            <div
              className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]"
              style={{ color: 'var(--text-muted)' }}
            >
              <time
                dateTime={entry.ts}
                title={`${date} ${time}`}
                className="tabular-nums"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {time}
              </time>
              {entry.sessionId && (
                <>
                  <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                  <span
                    className="truncate"
                    title={entry.sessionId}
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {shortSession(entry.sessionId)}
                  </span>
                </>
              )}
              {entry.clientKind && (
                <>
                  <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                  <span style={{ color: tint }}>{clientLabel(entry.clientKind)}</span>
                </>
              )}
            </div>
            {summary && (
              <div
                className="mt-1 truncate text-[10.5px] @[480px]:text-[11px]"
                style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
                title={summary}
              >
                {summary}
              </div>
            )}
          </div>
          {hasDetail && (
            <span
              aria-hidden
              className="shrink-0 self-start text-[10px]"
              style={{ color: 'var(--text-muted)', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
            >
              ▸
            </span>
          )}
        </div>
      </button>
      {expanded && hasDetail && (
        <div
          className="mt-1 ml-7 mr-1 rounded-md p-2 text-[10.5px] @[480px]:ml-9 @[480px]:rounded-lg @[480px]:p-3 @[480px]:text-[11px]"
          style={{
            background: 'var(--bg-base)',
            border: '1px solid var(--border-default)',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
          }}
        >
          {entry.args && Object.keys(entry.args).length > 0 && (
            <DetailBlock label="args" body={entry.args} />
          )}
          {entry.result && Object.keys(entry.result).length > 0 && (
            <DetailBlock label="result" body={entry.result} />
          )}
        </div>
      )}
    </li>
  )
}

function DetailBlock({ label, body }: { label: string; body: Record<string, unknown> }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[9.5px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <pre
        className="overflow-x-auto whitespace-pre-wrap"
        style={{ color: 'var(--text-secondary)' }}
      >
        {JSON.stringify(body, null, 2)}
      </pre>
    </div>
  )
}

function OutcomePill({ outcome }: { outcome: Outcome }) {
  if (!outcome.label) return null
  return (
    <span
      className="rounded-full px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider"
      style={{
        color: outcome.dot,
        background: `color-mix(in srgb, ${outcome.dot} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${outcome.dot} 28%, transparent)`,
      }}
    >
      {outcome.label}
    </span>
  )
}

function BrandMonogram({
  clientKind,
  tint,
}: {
  clientKind: ExternalHealClientKind | null
  tint: string
}) {
  const monogram = clientKind === null
    ? '·'
    : clientKind.startsWith('claude')
      ? 'C'
      : clientKind.startsWith('codex')
        ? 'X'
        : '∗'
  return (
    <span
      aria-hidden
      className="mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold @[480px]:h-6 @[480px]:w-6 @[480px]:rounded-md @[480px]:text-[11px]"
      style={{
        color: tint,
        background: `color-mix(in srgb, ${tint} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tint} 28%, transparent)`,
        fontFamily: 'var(--font-mono)',
      }}
    >
      {monogram}
    </span>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center px-4 py-8 text-center">
      <div className="max-w-[360px]">
        <div
          aria-hidden
          className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full"
          style={{
            border: '1px dashed var(--border-default)',
            color: 'var(--text-muted)',
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16 }}>∅</span>
        </div>
        <div className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          No external client activity recorded for this run.
        </div>
        <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Commands issued through the MCP server will appear here.
        </div>
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex h-full items-center justify-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
      Loading activity…
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="m-3 rounded-md p-3 text-[11px]" style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)', color: 'var(--danger)' }}>
      Failed to load activity: {message}
    </div>
  )
}

interface Outcome {
  label: string | null
  dot: string
  live: boolean
}

function inferOutcome(entry: AuditEntry): Outcome {
  const action = entry.action
  if (action === 'claim-rejected') {
    return { label: 'rejected', dot: 'var(--danger)', live: false }
  }
  if (action === 'stale-disconnect') {
    return { label: 'stale', dot: 'var(--warning)', live: false }
  }
  if (action === 'release') {
    return { label: 'released', dot: 'var(--text-muted)', live: false }
  }
  if (action === 'handoff') {
    return { label: 'handoff', dot: 'var(--accent)', live: false }
  }
  if (action === 'claim' || action === 'claim-reconnect') {
    return { label: action === 'claim-reconnect' ? 'reconnect' : 'claim', dot: 'var(--success)', live: false }
  }
  // Generic non-status events get no pill, just a neutral dot.
  return { label: null, dot: 'var(--border-focus)', live: false }
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
  if (parts.length === 0) return null
  return parts.join('  ')
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function shortSession(sessionId: string): string {
  if (sessionId.length <= 10) return sessionId
  return `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`
}

function clientLabel(kind: ExternalHealClientKind): string {
  switch (kind) {
    case 'claude-cli': return 'Claude CLI'
    case 'claude-desktop': return 'Claude Desktop'
    case 'codex-cli': return 'Codex CLI'
    case 'codex-desktop': return 'Codex Desktop'
    case 'other': return 'External'
  }
}

function clientTint(kind: ExternalHealClientKind | null): string {
  if (!kind) return 'var(--border-focus)'
  if (kind.startsWith('claude')) return '#d39965'
  if (kind.startsWith('codex')) return '#7aa2f7'
  return 'var(--border-focus)'
}

function formatTime(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(time))
}

function formatDate(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(time))
}
