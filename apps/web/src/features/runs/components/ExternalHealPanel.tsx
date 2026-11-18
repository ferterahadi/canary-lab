import { useNow } from '@/shared/state/use-now'
import { useMemo } from 'react'
import type { ExternalHealSession, ExternalHealSessionStatus } from '@shared/run-manifest'
import { isTerminalRunStatus, type RunStatus } from '@shared/run-state'
import { clientLabel as brandingClientLabel, clientKindToDesktopAgent } from '@/shared/ui/external-client-branding'
import { ExternalAgentCard, ExternalClientCta, ExternalMetaFact, ExternalStatusPill, agentJobTone, pillPalette, useExternalClientAction, type PillPalette } from '@/shared/ui/ExternalAgentCard'
import { presentRunStatus } from '../utils/run-presentation'
import { AGENT_WAITING_STATE } from '../utils/run-waiting-state'

interface Props {
  runId: string
  runStatus: RunStatus
  session?: ExternalHealSession
}

// The "Heal Agent" tab when external heal mode is active. When an external
// client has claimed the run, its transcript lives in the user's agent
// session rather than Canary Lab. When no claim exists yet, this panel makes
// that parked state explicit instead of rendering an empty local terminal.
export function ExternalHealPanel({ runId: _runId, runStatus, session }: Props) {
  const now = useNow()
  const { action, error: openError } = useExternalClientAction({ clientKind: session?.clientKind ?? 'other' })

  const heartbeatMs = useMemo(() => {
    if (!session) return null
    const t = Date.parse(session.lastHeartbeatAt)
    return Number.isFinite(t) ? t : null
  }, [session])

  const ageMs = heartbeatMs == null ? null : Math.max(0, now - heartbeatMs)
  const heartbeatColor = isTerminalRunStatus(runStatus) ? 'var(--text-muted)' : ageColor(ageMs)

  const terminalStatus = isTerminalRunStatus(runStatus) ? runStatus : null
  const displayedStatus = terminalStatus ?? session?.status ?? (runStatus === 'healing' ? 'waiting' : null)
  const isLive =
    Boolean(session) && !terminalStatus && (
      session?.status === 'connected' ||
      session?.status === 'healing' ||
      session?.status === 'running-tests'
    )
  const clientKind = session?.clientKind ?? 'other'

  return (
    <ExternalAgentCard
      clientKind={clientKind}
      fill
      eyebrow="External agent session"
      headline={clientLabel(clientKind)}
      statusPill={
        displayedStatus && (
          <ExternalStatusPill label={statusLabel(displayedStatus)} palette={statusPalette(displayedStatus)} />
        )
      }
      meta={session && (
        <div className="cl-heal-session-facts">
          <ExternalMetaFact label="Heartbeat">
            {ageMs === null ? '—' : <span className="flex items-center gap-1.5 tabular-nums" style={{ color: heartbeatColor }}>
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: heartbeatColor,
                  boxShadow: isLive ? `0 0 6px ${heartbeatColor}` : 'none',
                }}
                aria-hidden
              />
              <span>{ageLabel(ageMs)}</span>
            </span>}
          </ExternalMetaFact>
          <ExternalMetaFact label="Cycles">{session.cycleCount}</ExternalMetaFact>
        </div>
      )}
      body={sessionMessage(runStatus, session)}
    >
      {action?.kind === 'app' && (
        <>
          <div className="cl-heal-session-launcher">
            <ExternalClientCta
              label={`Open ${action.agent === 'claude' ? 'Claude' : 'Codex'}`}
              compact
              onClick={action.open}
              busy={action.busy}
            />
          </div>
          {openError && (
            <div role="alert" className="mt-2 text-[11px]" style={{ color: 'var(--danger)' }}>
              {openError}
            </div>
          )}
        </>
      )}
    </ExternalAgentCard>
  )
}

function sessionMessage(runStatus: RunStatus, session?: ExternalHealSession): string | undefined {
  if (isTerminalRunStatus(runStatus)) return undefined
  if (!session) return runStatus === 'healing'
    ? 'Claim this run from an MCP-connected agent.'
    : 'No agent has claimed this run.'
  return session.status === 'disconnected' && !clientKindToDesktopAgent(session.clientKind)
    ? `Reconnect the same ${clientLabel(session.clientKind)} session to resume.`
    : undefined
}

type PanelStatus = ExternalHealSessionStatus | Extract<RunStatus, 'passed' | 'failed' | 'aborted'>

function statusLabel(status: PanelStatus): string {
  const runStatus = sharedRunPresentation(status)
  if (runStatus) return runStatus.label
  switch (status) {
    case 'connected': return 'Connected'
    case 'running-tests': return 'Running tests'
    case 'paused': return 'Paused'
    case 'disconnected': return 'Disconnected'
    default: return status
  }
}

function sharedRunPresentation(status: PanelStatus) {
  if (status === 'waiting') return presentRunStatus({ status: 'healing', waiting: AGENT_WAITING_STATE })
  if (status === 'healing' || status === 'passed' || status === 'failed' || status === 'aborted') {
    return presentRunStatus({ status })
  }
  return null
}

function statusPalette(status: PanelStatus): PillPalette {
  const runStatus = sharedRunPresentation(status)
  // The run's own chip fill, so this pill and the run-detail chip match.
  if (runStatus) return { ...pillPalette(runStatus.tone), bg: runStatus.background }
  if (status === 'disconnected') return pillPalette('var(--danger)')
  if (status === 'paused') return pillPalette('var(--warning)')
  if (status === 'running-tests') return agentJobTone('running')
  return pillPalette('var(--success)')
}

function ageLabel(ageMs: number): string {
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
// "External agent") — keep that copy while reusing the shared switch.
function clientLabel(kind: ExternalHealSession['clientKind']): string {
  return brandingClientLabel(kind, 'AI Agent')
}
