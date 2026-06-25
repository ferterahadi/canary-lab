import { useEffect, useMemo, useState } from 'react'
import type {
  ExternalHealSession,
  ExternalHealSessionStatus,
  RunStatus,
} from '../../../shared/api/types'
import { isTerminalRunStatus } from '../../../../../../shared/run-state'
import { clientKindToDesktopAgent, clientLabel as brandingClientLabel, clientTint } from './external-client-branding'
import { ExternalAgentCard, ExternalClientCta, StatusPill, useOpenAgentApp } from './ExternalAgentCard'

interface Props {
  runId: string
  runStatus: RunStatus
  session?: ExternalHealSession
}

// The "Heal agent" tab when external heal mode is active. When an external
// client has claimed the run, its transcript lives in the user's agent
// session rather than Canary Lab. When no claim exists yet, this panel makes
// that parked state explicit instead of rendering an empty local terminal.
export function ExternalHealPanel({ runId: _runId, runStatus, session }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const { opening, error: openError, open: onOpenAgent } = useOpenAgentApp()

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
  const displayedStatus = terminalStatus ?? session?.status ?? 'waiting'
  const isDisconnected = !terminalStatus && session?.status === 'disconnected'
  const isLive =
    Boolean(session) && !terminalStatus && (
      session?.status === 'connected' ||
      session?.status === 'healing' ||
      session?.status === 'running-tests'
    )
  const clientKind = session?.clientKind ?? 'other'
  const desktopAgent = session ? clientKindToDesktopAgent(session.clientKind) : null

  const tint = clientTint(clientKind)

  return (
    <ExternalAgentCard
      clientKind={clientKind}
      brandElevated
      fill
      eyebrow="External heal session"
      headline={headlineFor(clientKind, Boolean(session))}
      statusPill={
        displayedStatus && (
          <StatusPill label={statusLabel(displayedStatus)} palette={statusPalette(displayedStatus)} />
        )
      }
      meta={
        <>
          <span className="inline-flex items-center gap-1.5" style={{ color: heartbeatColor }}>
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
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
              <span aria-hidden style={{ opacity: 0.55 }}>·</span>
              {session.cycleCount} {session.cycleCount === 1 ? 'cycle' : 'cycles'}
            </span>
          )}
        </>
      }
      body={
        terminalStatus
          ? terminalMessage(terminalStatus, clientKind, Boolean(session))
          : isDisconnected
          ? `Lost connection to ${clientLabel(session.clientKind)}. The run is paused waiting for you to reconnect — Canary Lab keeps the claim, so the same session id can resume right where it left off.`
          : !session
          ? 'No external client has claimed this run yet. Canary Lab is waiting for an AI Agent MCP session to claim the run and send a restart or rerun signal.'
          : `Agent output is streaming in your ${clientLabel(session.clientKind)} window. This panel tracks the run; open your conversation to follow the agent's reasoning.`
      }
    >
      {desktopAgent && (
        <div className="mt-3 @[320px]:mt-4 @[480px]:mt-5">
          <ExternalClientCta
            tint={tint}
            label={`Open ${desktopAgent === 'claude' ? 'Claude' : 'Codex'}`}
            onClick={() => onOpenAgent(desktopAgent)}
            busy={opening !== null}
          />
        </div>
      )}
      {openError && (
        <div className="mt-3 text-[11px]" style={{ color: 'var(--danger)' }}>
          {openError}
        </div>
      )}
    </ExternalAgentCard>
  )
}

type PanelStatus = ExternalHealSessionStatus | Extract<RunStatus, 'passed' | 'failed' | 'aborted'>

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

// This surface labels an unknown client "AI Agent" (not the shared default
// "External Client") — keep that copy while reusing the shared switch.
function clientLabel(kind: ExternalHealSession['clientKind']): string {
  return brandingClientLabel(kind, 'AI Agent')
}

function headlineFor(
  kind: ExternalHealSession['clientKind'],
  hasSession: boolean,
): string {
  if (!hasSession) return 'AI Agent'
  return kind === 'other' ? 'AI Agent' : clientLabel(kind)
}
