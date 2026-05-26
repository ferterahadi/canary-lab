import { useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type {
  ExternalHealSession,
  ExternalHealSessionStatus,
  RunStatus,
} from '../api/types'
import { isTerminalRunStatus } from '../../../../shared/run-state'

interface Props {
  runId: string
  runStatus: RunStatus
  session?: ExternalHealSession
}

// The "Heal agent" tab when external heal mode is active. When an external
// client has claimed the run, its transcript lives in the user's Claude/Codex
// session rather than Canary Lab. When no claim exists yet, this panel makes
// that parked state explicit instead of rendering an empty local terminal.
export function ExternalHealPanel({ runId: _runId, runStatus, session }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const [opening, setOpening] = useState<'claude' | 'codex' | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const heartbeatMs = useMemo(() => {
    if (!session) return null
    const t = Date.parse(session.lastHeartbeatAt)
    return Number.isFinite(t) ? t : null
  }, [session])

  const ageMs = heartbeatMs == null ? null : Math.max(0, now - heartbeatMs)
  const heartbeatColor = ageColor(ageMs)
  const heartbeatLabel = ageLabel(ageMs)

  const terminalStatus = isTerminalRunStatus(runStatus) ? runStatus : null
  const displayedStatus = terminalStatus ? null : session?.status ?? 'waiting'
  const isDisconnected = !terminalStatus && session?.status === 'disconnected'
  const isLive =
    Boolean(session) && !terminalStatus && (
      session?.status === 'connected' ||
      session?.status === 'healing' ||
      session?.status === 'running-tests'
    )
  const clientKind = session?.clientKind ?? 'other'
  const desktopAgent = session ? clientKindToDesktopAgent(session.clientKind) : null

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

  const tint = clientTint(clientKind)

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
          <BrandMark clientKind={clientKind} tint={tint} />
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
              {headlineFor(clientKind, Boolean(session))}
            </h2>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[10px] @[320px]:mt-3 @[320px]:gap-x-2.5 @[320px]:text-[11px] @[480px]:mt-3.5">
          {displayedStatus && <StatusPill status={displayedStatus} />}
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
          {session && session.cycleCount > 0 && (
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
          {terminalStatus
            ? terminalMessage(terminalStatus, clientKind, Boolean(session))
            : isDisconnected
            ? `Lost connection to ${clientLabel(session.clientKind)}. The run is paused waiting for you to reconnect — Canary Lab keeps the claim, so the same session id can resume right where it left off.`
            : !session
            ? 'No external client has claimed this run yet. Canary Lab is waiting for a Claude or Codex MCP session to claim the run and send a restart or rerun signal.'
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

type PanelStatus = ExternalHealSessionStatus | Extract<RunStatus, 'passed' | 'failed' | 'aborted'>

function StatusPill({ status }: { status: PanelStatus }) {
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
    const alt = clientLabel(clientKind)
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
        background: `linear-gradient(135deg, color-mix(in srgb, ${tint} 22%, transparent), color-mix(in srgb, ${tint} 8%, transparent))`,
        border: `1px solid color-mix(in srgb, ${tint} 38%, var(--border-default))`,
        color: tint,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, white 7%, transparent), 0 10px 24px color-mix(in srgb, ${tint} 14%, transparent)`,
      }}
      role="img"
      aria-label="External client"
    >
      <svg
        viewBox="0 0 32 32"
        width="30"
        height="30"
        fill="none"
        aria-hidden="true"
        className="h-7 w-7 @[320px]:h-8 @[320px]:w-8"
      >
        <rect
          x="6"
          y="8"
          width="20"
          height="14"
          rx="3"
          fill="currentColor"
          opacity="0.13"
        />
        <rect
          x="6"
          y="8"
          width="20"
          height="14"
          rx="3"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M11 13h10M11 17h6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.72"
        />
        <path
          d="M16 22v3M11.5 25h9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}

function statusLabel(status: PanelStatus): string {
  switch (status) {
    case 'passed': return 'Passed'
    case 'failed': return 'Failed'
    case 'aborted': return 'Aborted'
    case 'connected': return 'Connected'
    case 'waiting': return 'Waiting'
    case 'healing': return 'Healing'
    case 'running-tests': return 'Running tests'
    case 'paused': return 'Paused'
    case 'disconnected': return 'Disconnected'
  }
}

function statusPalette(status: PanelStatus): { fg: string; bg: string; border: string } {
  if (status === 'failed' || status === 'disconnected') {
    return {
      fg: 'var(--danger)',
      bg: 'color-mix(in srgb, var(--danger) 12%, transparent)',
      border: 'color-mix(in srgb, var(--danger) 40%, transparent)',
    }
  }
  if (status === 'aborted') {
    return {
      fg: 'var(--text-muted)',
      bg: 'color-mix(in srgb, var(--text-muted) 12%, transparent)',
      border: 'color-mix(in srgb, var(--text-muted) 34%, transparent)',
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

function terminalMessage(
  status: Extract<RunStatus, 'passed' | 'failed' | 'aborted'>,
  clientKind: ExternalHealSession['clientKind'],
  hasSession: boolean,
): string {
  if (!hasSession) {
    return status === 'failed'
      ? 'No external client is actively waiting for a signal.'
      : 'No external client is active for this run.'
  }
  const agent = clientLabel(clientKind)
  return status === 'failed'
    ? `The ${agent} heal session is no longer actively waiting for a signal.`
    : `The ${agent} heal session is no longer active for this run.`
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

function headlineFor(
  kind: ExternalHealSession['clientKind'],
  hasSession: boolean,
): string {
  if (!hasSession) return 'External Client'
  return kind === 'other' ? 'External Client' : clientLabel(kind)
}

function clientTint(kind: ExternalHealSession['clientKind']): string {
  if (kind.startsWith('claude')) return '#d39965'
  if (kind.startsWith('codex')) return '#7aa2f7'
  return 'var(--border-focus)'
}

function clientKindToDesktopAgent(
  kind: ExternalHealSession['clientKind'],
): 'claude' | 'codex' | null {
  if (kind === 'claude-desktop') return 'claude'
  if (kind === 'codex-desktop') return 'codex'
  return null
}
