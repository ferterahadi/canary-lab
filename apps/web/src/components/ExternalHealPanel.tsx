import { useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type {
  ExternalHealSession,
  ExternalHealSessionStatus,
  RunLifecycleEvent,
} from '../api/types'

interface Props {
  runId: string
  session: ExternalHealSession
  lifecycleEvents?: RunLifecycleEvent[]
}

// The "Heal agent" tab when an external AI client (Claude Desktop / Codex /
// Claude CLI / Codex CLI via MCP) holds the heal claim for this run. We
// intentionally do NOT mirror the agent's transcript here — that lives in the
// user's external session window. This panel surfaces:
//   • who's healing (kind + conversation name + session id)
//   • how lively the connection is (heartbeat + status pill)
//   • a thin lifecycle ribbon so the user still sees the run moving
//   • a clear pointer back to the external client
export function ExternalHealPanel({ runId: _runId, session, lifecycleEvents }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const [opening, setOpening] = useState<'claude' | 'codex' | null>(null)
  const [copied, setCopied] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  // Re-render once a second so the relative heartbeat label stays fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const heartbeatMs = useMemo(() => {
    const t = Date.parse(session.lastHeartbeatAt)
    return Number.isFinite(t) ? t : null
  }, [session.lastHeartbeatAt])

  const ageMs = heartbeatMs == null ? null : Math.max(0, now - heartbeatMs)
  const heartbeatColor = ageColor(ageMs)
  const heartbeatLabel = ageLabel(ageMs)

  const isDisconnected = session.status === 'disconnected'
  const desktopAgent = clientKindToDesktopAgent(session.clientKind)
  const displayName = session.conversationName?.trim() || `Session ${session.sessionId.slice(0, 8)}`

  const onOpenAgent = async (agent: 'claude' | 'codex'): Promise<void> => {
    setOpening(agent)
    setOpenError(null)
    try {
      await api.openAgentApp(agent)
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : `Could not open ${agent}`)
    } finally {
      setOpening(null)
    }
  }

  const onCopySessionId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(session.sessionId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API may be unavailable in some browser contexts. Silent.
    }
  }

  const tintForClient = clientTint(session.clientKind)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div
        className="rounded-xl p-5"
        style={{
          background: `linear-gradient(140deg, color-mix(in srgb, ${tintForClient} 8%, var(--bg-elevated)) 0%, var(--bg-elevated) 70%)`,
          border: `1px solid color-mix(in srgb, ${tintForClient} 26%, var(--border-default))`,
        }}
      >
        <div className="flex items-start gap-4">
          <ClientMonogram clientKind={session.clientKind} tint={tintForClient} />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              External heal session
            </div>
            <div
              className="mt-0.5 text-base font-semibold"
              style={{ color: 'var(--text-primary)' }}
            >
              {headlineFor(session.clientKind)}
            </div>
            <div
              className="mt-1.5 truncate text-lg"
              style={{ color: 'var(--text-primary)' }}
              title={displayName}
            >
              {displayName}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <button
                type="button"
                onClick={onCopySessionId}
                className="rounded-md px-2 py-0.5"
                style={{
                  border: '1px solid var(--border-default)',
                  color: copied ? 'var(--success)' : 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                }}
                title="Copy session id"
              >
                {copied ? 'Copied' : `id ${session.sessionId.slice(0, 12)}`}
              </button>
              <span className="opacity-70">·</span>
              <span style={{ color: heartbeatColor }}>{heartbeatLabel}</span>
              <span className="opacity-70">·</span>
              <StatusPill status={session.status} />
              {session.cycleCount > 0 && (
                <>
                  <span className="opacity-70">·</span>
                  <span>{session.cycleCount} {session.cycleCount === 1 ? 'cycle' : 'cycles'}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div
          className="mt-4 text-xs leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}
        >
          {isDisconnected
            ? `Lost connection to ${clientLabel(session.clientKind)}. The run is paused waiting for you to reconnect — Canary Lab keeps the claim, so the same session id can resume right where it left off.`
            : `Agent output is streaming in your ${clientLabel(session.clientKind)} window. This panel tracks the run; open your conversation to follow the agent's reasoning.`}
        </div>

        {desktopAgent && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onOpenAgent(desktopAgent)}
              disabled={opening !== null}
              className="rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider"
              style={{
                color: tintForClient,
                background: `color-mix(in srgb, ${tintForClient} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${tintForClient} 40%, transparent)`,
                opacity: opening === desktopAgent ? 0.6 : 1,
              }}
            >
              {opening === desktopAgent
                ? 'Opening…'
                : `Open ${clientLabel(session.clientKind)} →`}
            </button>
          </div>
        )}
        {openError && (
          <div className="mt-2 text-[11px]" style={{ color: 'var(--danger)' }}>{openError}</div>
        )}
      </div>

      <LifecycleRibbon events={lifecycleEvents} status={session.status} />
    </div>
  )
}

function StatusPill({ status }: { status: ExternalHealSessionStatus }) {
  const palette = statusPalette(status)
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
      style={{
        color: palette.fg,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
      }}
    >
      {statusLabel(status)}
    </span>
  )
}

function ClientMonogram({ clientKind, tint }: { clientKind: ExternalHealSession['clientKind']; tint: string }) {
  const letters = clientKind.startsWith('claude') ? 'CL' : clientKind.startsWith('codex') ? 'CX' : '·'
  return (
    <div
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-base font-semibold"
      style={{
        background: `color-mix(in srgb, ${tint} 18%, transparent)`,
        color: tint,
        border: `1px solid color-mix(in srgb, ${tint} 35%, transparent)`,
        fontFamily: 'var(--font-mono)',
      }}
      aria-hidden
    >
      {letters}
    </div>
  )
}

function LifecycleRibbon({
  events,
  status,
}: {
  events: RunLifecycleEvent[] | undefined
  status: ExternalHealSessionStatus
}) {
  const recent = useMemo(() => {
    if (!events || events.length === 0) return []
    // Take the last ~6 distinct headlines so the ribbon stays readable.
    const acc: RunLifecycleEvent[] = []
    for (let i = events.length - 1; i >= 0 && acc.length < 6; i -= 1) {
      const e = events[i]
      if (!acc.some((seen) => seen.headline === e.headline)) acc.unshift(e)
    }
    return acc
  }, [events])

  if (recent.length === 0) {
    return (
      <div
        className="rounded-lg px-4 py-3 text-xs"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-muted)',
        }}
      >
        {status === 'waiting'
          ? 'Waiting for next agent action.'
          : 'Run lifecycle will appear here as the orchestrator progresses.'}
      </div>
    )
  }

  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
        Run lifecycle
      </div>
      <ol className="flex flex-col gap-1.5">
        {recent.map((event, idx) => {
          const isLast = idx === recent.length - 1
          return (
            <li key={`${event.updatedAt}-${idx}`} className="flex items-start gap-2 text-xs">
              <span
                className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: isLast ? 'var(--border-focus)' : 'var(--text-muted)',
                  opacity: isLast ? 1 : 0.6,
                }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div style={{ color: 'var(--text-primary)' }}>{event.headline}</div>
                {event.detail && (
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>{event.detail}</div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function statusLabel(status: ExternalHealSessionStatus): string {
  switch (status) {
    case 'connected': return 'Connected'
    case 'waiting': return 'Waiting'
    case 'healing': return 'Healing'
    case 'running-tests': return 'Running tests'
    case 'paused': return 'Paused'
    case 'disconnected': return 'Disconnected'
  }
}

function statusPalette(status: ExternalHealSessionStatus): { fg: string; bg: string; border: string } {
  if (status === 'disconnected') {
    return {
      fg: 'var(--danger)',
      bg: 'color-mix(in srgb, var(--danger) 12%, transparent)',
      border: 'color-mix(in srgb, var(--danger) 40%, transparent)',
    }
  }
  if (status === 'paused') {
    return {
      fg: 'var(--warning)',
      bg: 'color-mix(in srgb, var(--warning) 12%, transparent)',
      border: 'color-mix(in srgb, var(--warning) 40%, transparent)',
    }
  }
  if (status === 'healing' || status === 'running-tests') {
    return {
      fg: 'var(--border-focus)',
      bg: 'color-mix(in srgb, var(--border-focus) 12%, transparent)',
      border: 'color-mix(in srgb, var(--border-focus) 40%, transparent)',
    }
  }
  // connected / waiting
  return {
    fg: 'var(--success)',
    bg: 'color-mix(in srgb, var(--success) 12%, transparent)',
    border: 'color-mix(in srgb, var(--success) 40%, transparent)',
  }
}

function ageLabel(ageMs: number | null): string {
  if (ageMs == null) return 'No heartbeat yet'
  if (ageMs < 1500) return 'just now'
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`
  return `${Math.round(ageMs / 3_600_000)}h ago`
}

function ageColor(ageMs: number | null): string {
  if (ageMs == null) return 'var(--text-muted)'
  if (ageMs > 15_000) return 'var(--danger)'
  if (ageMs > 10_000) return 'var(--warning)'
  return 'var(--text-secondary)'
}

function clientLabel(kind: ExternalHealSession['clientKind']): string {
  switch (kind) {
    case 'claude-cli': return 'Claude CLI'
    case 'claude-desktop': return 'Claude Desktop'
    case 'codex-cli': return 'Codex CLI'
    case 'codex-desktop': return 'Codex Desktop'
    case 'other': return 'external client'
  }
}

function headlineFor(kind: ExternalHealSession['clientKind']): string {
  if (kind === 'other') return 'Healing via external client'
  return `Healing via ${clientLabel(kind)}`
}

function clientTint(kind: ExternalHealSession['clientKind']): string {
  // Slight palette differentiation so Claude and Codex feel distinct without
  // either dominating. Falls back to the existing focus accent for 'other'.
  if (kind.startsWith('claude')) return '#d39965' // warm sand
  if (kind.startsWith('codex')) return '#7aa2f7'  // cool indigo
  return 'var(--border-focus)'
}

function clientKindToDesktopAgent(
  kind: ExternalHealSession['clientKind'],
): 'claude' | 'codex' | null {
  if (kind.startsWith('claude')) return 'claude'
  if (kind.startsWith('codex')) return 'codex'
  return null
}
