import type { ReactNode } from 'react'
import { clientLabel, shortSession, type ExternalClientKind } from './external-client-branding'
import { ExternalAgentCard, ExternalClientCta, ExternalMetaFact, useExternalClientAction } from './ExternalAgentCard'

interface Props {
  clientKind: ExternalClientKind
  sessionUrl?: string
  sessionId?: string
  conversationName?: string
  statusPill: ReactNode
  body: string
  displayLog: string
  logTestId: string
}

export function ExternalAgentMonitor({ clientKind, sessionUrl, sessionId, conversationName, statusPill, body, displayLog, logTestId }: Props) {
  const { action, error: openError } = useExternalClientAction({ clientKind, sessionUrl })
  return (
    <ExternalAgentCard
      clientKind={clientKind}
      eyebrow="External agent session"
      headline={clientLabel(clientKind)}
      subtitle={conversationName}
      statusPill={statusPill}
      meta={
        sessionId && (
          <ExternalMetaFact label="Session" title={sessionId}>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{shortSession(sessionId)}</span>
          </ExternalMetaFact>
        )
      }
      body={body}
      action={action?.kind === 'link' ? (
        <ExternalClientCta label={`Open ${clientLabel(clientKind)}`} href={action.href} />
      ) : (
        action && (
          <ExternalClientCta
            label={`Open ${action.agent === 'claude' ? 'Claude' : 'Codex'}`}
            onClick={action.open}
            busy={action.busy}
          />
        )
      )}
    >
      <pre
        data-testid={logTestId}
        style={{
          margin: '12px 0 0', maxHeight: 300, overflow: 'auto', fontSize: 12, lineHeight: 1.5,
          color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        {displayLog}
      </pre>

      {openError && (
        <div className="mt-3 text-[11px]" style={{ color: 'var(--danger)' }}>
          {openError}
        </div>
      )}
    </ExternalAgentCard>
  )
}
