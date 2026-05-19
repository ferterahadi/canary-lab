import { useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type {
  ExternalHealSession,
  ExternalHealSessionStatus,
} from '../api/types'

interface Props {
  runId: string
  session: ExternalHealSession
}

// The "Heal agent" tab when an external AI client (Claude Desktop / Codex /
// Claude CLI / Codex CLI via MCP) holds the heal claim for this run. We
// intentionally do NOT mirror the agent's transcript here — that lives in the
// user's external session window. This panel surfaces who's healing, how
// lively the connection is, and a clear pointer back to the external client.
export function ExternalHealPanel({ runId: _runId, session }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const [opening, setOpening] = useState<'claude' | 'codex' | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

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
  const isLive =
    session.status === 'connected' ||
    session.status === 'healing' ||
    session.status === 'running-tests'
  const desktopAgent = clientKindToDesktopAgent(session.clientKind)

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

  const tint = clientTint(session.clientKind)

  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-y-auto p-3 @[400px]:p-4">
      <div
        className="relative overflow-hidden rounded-xl p-3.5 @[320px]:rounded-2xl @[320px]:p-4 @[480px]:p-6"
        style={{
          background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tint} 14%, transparent) 0%, transparent 55%), var(--bg-elevated)`,
          border: `1px solid color-mix(in srgb, ${tint} 24%, var(--border-default))`,
        }}
      >
        <div className="flex items-start gap-3 @[480px]:gap-4">
          <BrandMark clientKind={session.clientKind} tint={tint} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div
              className="text-[9px] font-medium uppercase @[320px]:text-[10px]"
              style={{ color: 'var(--text-muted)', letterSpacing: '0.14em' }}
            >
              External heal session
            </div>
            <h2
              className="mt-0.5 text-sm font-semibold @[320px]:mt-1 @[320px]:text-base @[480px]:mt-1.5 @[480px]:text-xl"
              style={{
                color: 'var(--text-primary)',
                letterSpacing: '-0.01em',
                lineHeight: 1.2,
              }}
            >
              {headlineFor(session.clientKind)}
            </h2>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[10px] @[320px]:mt-3 @[320px]:gap-x-2.5 @[320px]:text-[11px] @[480px]:mt-3.5">
          <StatusPill status={session.status} />
          <span
            className="inline-flex items-center gap-1.5"
            style={{ color: heartbeatColor }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: heartbeatColor,
                boxShadow: isLive ? `0 0 6px ${heartbeatColor}` : 'none',
              }}
              aria-hidden
            />
            {heartbeatLabel}
          </span>
          {session.cycleCount > 0 && (
            <span
              className="inline-flex items-center gap-1.5"
              style={{ color: 'var(--text-muted)' }}
            >
              <span aria-hidden style={{ opacity: 0.55 }}>·</span>
              {session.cycleCount} {session.cycleCount === 1 ? 'cycle' : 'cycles'}
            </span>
          )}
        </div>

        <p
          className="mt-3 text-[11px] leading-relaxed @[320px]:mt-4 @[320px]:text-xs @[480px]:mt-5 @[480px]:text-[13px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {isDisconnected
            ? `Lost connection to ${clientLabel(session.clientKind)}. The run is paused waiting for you to reconnect — Canary Lab keeps the claim, so the same session id can resume right where it left off.`
            : `Agent output is streaming in your ${clientLabel(session.clientKind)} window. This panel tracks the run; open your conversation to follow the agent's reasoning.`}
        </p>

        {desktopAgent && (
          <div className="mt-3 @[320px]:mt-4 @[480px]:mt-5">
            <button
              type="button"
              onClick={() => onOpenAgent(desktopAgent)}
              disabled={opening !== null}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider @[320px]:rounded-lg @[320px]:px-3.5 @[320px]:py-2 @[320px]:text-[11px] @[480px]:w-auto @[480px]:justify-start"
              style={{
                color: tint,
                background: `color-mix(in srgb, ${tint} 14%, transparent)`,
                border: `1px solid color-mix(in srgb, ${tint} 38%, transparent)`,
                opacity: opening === desktopAgent ? 0.6 : 1,
              }}
            >
              {opening === desktopAgent ? (
                'Opening…'
              ) : (
                <>
                  <span>Open {desktopAgent === 'claude' ? 'Claude' : 'Codex'}</span>
                  <span aria-hidden>→</span>
                </>
              )}
            </button>
          </div>
        )}
        {openError && (
          <div className="mt-3 text-[11px]" style={{ color: 'var(--danger)' }}>
            {openError}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: ExternalHealSessionStatus }) {
  const palette = statusPalette(status)
  return (
    <span
      className="rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
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

function BrandMark({
  clientKind,
  tint,
}: {
  clientKind: ExternalHealSession['clientKind']
  tint: string
}) {
  const isClaude = clientKind.startsWith('claude')
  const isCodex = clientKind.startsWith('codex')

  if (isClaude || isCodex) {
    const src = isClaude ? '/brand/claude.webp' : '/brand/codex.webp'
    const alt = isClaude ? 'Claude' : 'Codex'
    return (
      <div
        className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg @[320px]:h-12 @[320px]:w-12 @[320px]:rounded-xl @[480px]:h-14 @[480px]:w-14"
        style={{
          border: `1px solid color-mix(in srgb, ${tint} 30%, var(--border-default))`,
        }}
      >
        <img src={src} alt={alt} className="h-full w-full object-cover" />
      </div>
    )
  }

  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg @[320px]:h-12 @[320px]:w-12 @[320px]:rounded-xl @[480px]:h-14 @[480px]:w-14"
      style={{
        background: `color-mix(in srgb, ${tint} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tint} 30%, transparent)`,
        color: tint,
        fontFamily: 'var(--font-mono)',
      }}
      aria-hidden
    >
      <span className="text-base font-semibold">·</span>
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
    case 'claude-cli': return 'Claude (Desktop/CLI)'
    case 'claude-desktop': return 'Claude (Desktop/CLI)'
    case 'codex-cli': return 'Codex (Desktop/CLI)'
    case 'codex-desktop': return 'Codex (Desktop/CLI)'
    case 'other': return 'external client'
  }
}

function headlineFor(kind: ExternalHealSession['clientKind']): string {
  // Keep the heading short so it never wraps. The icon + colour already
  // identify the brand; the longer `clientLabel` (with the Desktop/CLI
  // qualifier) is reserved for the description copy where it has room.
  if (kind.startsWith('claude')) return 'Healing via Claude'
  if (kind.startsWith('codex')) return 'Healing via Codex'
  return 'Healing via external client'
}

function clientTint(kind: ExternalHealSession['clientKind']): string {
  if (kind.startsWith('claude')) return '#d39965'
  if (kind.startsWith('codex')) return '#7aa2f7'
  return 'var(--border-focus)'
}

function clientKindToDesktopAgent(
  kind: ExternalHealSession['clientKind'],
): 'claude' | 'codex' | null {
  if (kind.startsWith('claude')) return 'claude'
  if (kind.startsWith('codex')) return 'codex'
  return null
}
