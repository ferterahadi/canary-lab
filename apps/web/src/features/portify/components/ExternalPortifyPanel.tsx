import type { PortifyManifest, PortifyStatus } from '../../../shared/api/client'
import { clientLabel, clientTint, shortSession, type ExternalClientKind } from '../../runs/components/external-client-branding'
import { ExternalAgentCard, ExternalClientCta, pillPalette, StatusPill } from '../../runs/components/ExternalAgentCard'

// Portify-side analog of ExternalDraftAgentPanel / ExternalHealPanel. When a
// port-ification workflow is driven by an external MCP client (the agent runs
// in the user's own Claude/Codex and edits the scratch worktree IN PLACE),
// there is no local agent transcript to render — the conversation lives in the
// user's window. This surfaces the workflow status, the worktree edit paths the
// client is acting on, and any verification feedback, with the same elevated-
// card / brand-monogram aesthetic the other external panels use.
export function ExternalPortifyPanel({ m }: { m: PortifyManifest }) {
  const clientKind = (m.external?.clientKind ?? 'other') as ExternalClientKind
  const failure = m.verification && !m.verification.ok ? m.verification.failureDetail : undefined

  return (
    <ExternalAgentCard
      clientKind={clientKind}
      fill
      eyebrow="External port-ification session"
      headline={clientKind === 'other' ? 'External Client' : clientLabel(clientKind)}
      subtitle={m.external?.conversationName}
      statusPill={<StatusPill label={statusLabel(m.status)} palette={statusPalette(m.status)} />}
      meta={
        m.external?.sessionId && (
          <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <span aria-hidden style={{ opacity: 0.55 }}>·</span>
            <span style={{ fontFamily: 'var(--font-mono)' }} title={m.external.sessionId}>
              {shortSession(m.external.sessionId)}
            </span>
          </span>
        )
      }
      body={bodyCopy(m.status, clientLabel(clientKind))}
    >
      {/* The worktree paths the client edits in place — only meaningful while
          the workflow is still live (the scratch worktrees are discarded on
          save/cancel). */}
      {(m.status === 'editing' || m.status === 'verifying') && m.repos.some((r) => r.worktreePath) && (
        <div className="mt-3 @[320px]:mt-4">
          <div
            className="mb-1.5 text-[9px] font-medium uppercase @[320px]:text-[10px]"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}
          >
            Editing in
          </div>
          <div className="flex flex-col gap-1">
            {m.repos.filter((r) => r.worktreePath).map((r) => (
              <div
                key={r.name}
                className="truncate rounded-md px-2.5 py-1.5 text-[10.5px] @[320px]:text-[11px]"
                style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}
                title={r.worktreePath}
              >
                <span style={{ color: 'var(--text-muted)' }}>{r.name}: </span>{r.worktreePath}
              </div>
            ))}
          </div>
        </div>
      )}

      {failure && (
        <div
          className="mt-3 rounded-md px-3 py-2 text-[11px] @[320px]:mt-4"
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--font-mono)',
            color: 'rgb(251,191,36)',
            background: 'var(--bg-base)',
            border: '1px solid var(--border-default)',
          }}
        >
          {failure}
        </div>
      )}

      {m.status === 'failed' && m.error && (
        <div
          className="mt-3 rounded-md px-3 py-2 text-[11px] @[320px]:mt-4"
          style={{
            color: 'var(--danger)',
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
          }}
        >
          {m.error}
        </div>
      )}

      {m.external?.sessionUrl && (
        <div className="mt-3 @[320px]:mt-4 @[480px]:mt-5">
          <ExternalClientCta tint={clientTint(clientKind)} label={`Open ${clientLabel(clientKind)}`} href={m.external.sessionUrl} />
        </div>
      )}
    </ExternalAgentCard>
  )
}

function statusLabel(status: PortifyStatus): string {
  switch (status) {
    case 'planning': return 'Setting up'
    case 'editing': return 'Editing'
    case 'verifying': return 'Verifying'
    case 'ready-to-save': return 'Ready to save'
    case 'saved': return 'Saved'
    case 'failed': return 'Failed'
    case 'aborted': return 'Cancelled'
  }
}

function statusPalette(status: PortifyStatus) {
  if (status === 'failed') return pillPalette('var(--danger)')
  if (status === 'aborted') return pillPalette('var(--text-muted)')
  if (status === 'saved') return pillPalette('var(--success)')
  if (status === 'ready-to-save') return pillPalette('var(--accent)')
  return pillPalette('var(--border-focus)')
}

function bodyCopy(status: PortifyStatus, agent: string): string {
  switch (status) {
    case 'planning':
      return `Setting up the scratch worktree(s). Once ready, ${agent} edits them in place to make every listener read an injected port.`
    case 'editing':
      return `${agent} is rewriting the listeners to read injected ports in the worktree(s) above (and declaring the matching \`ports\` slots in the feature config). The live work happens in your ${agent} window — Canary Lab has no local transcript. When the edits are done, ${agent} submits them and Canary Lab boots the stack twice to verify.`
    case 'verifying':
      return `Booting the stack twice on different ports to prove the rewrite works. This panel updates when verification settles.`
    case 'ready-to-save':
      return `Verified — booted twice on disjoint ports, both healthy. Review the diff and Save to capture it as the feature's ephemeral overlay (nothing is committed or merged).`
    case 'saved':
      return `Saved as the feature's ephemeral overlay. It now applies into a fresh per-run worktree before every boot, so the feature runs concurrently without a port clash.`
    case 'failed':
      return `The port-ification workflow could not be completed. See the detail below.`
    case 'aborted':
      return `This port-ification workflow was cancelled. The scratch worktree(s) were discarded; the product repo is untouched.`
  }
}
