import { useEffect, useRef, useState } from 'react'
import * as runsApi from '@/shared/api/runs'
import type { ProposePrResult } from '@/shared/api/runs'
import { Modal } from '@/shared/ui/Overlays'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { useMountedIdentity } from '@/shared/state/use-mounted-identity'
import { BLOCKED_HELP } from '../utils/pr-blocked-copy'

// R80 — the PR confirm dialog. Pushing to origin is teammate-visible, so a PR is
// never automatic: this is the explicit gate. It re-runs the preflight on open
// (auth changes outside the app — the enforcement point), shows a per-repo
// verdict with detect-and-instruct remediation for anything blocked, and opens
// PRs only for the pushable subset on confirm.

export function ProposePrDialog({
  open,
  onClose,
  runId,
  onProposed,
}: {
  open: boolean
  onClose: () => void
  runId: string
  /** Called after PRs are opened so the panel can re-poll for the links. */
  onProposed?: () => void
}) {
  const session = useMountedIdentity(JSON.stringify([open, runId]))
  const mounted = useMountedIdentity('propose-pr')
  const preflightRead = useLiveResource(null, open ? runId : null, () => runsApi.getRunPrPreflight(runId))
  const { value: preflight, loading } = preflightRead
  // A closed dialog does not cancel a server write. Keep its lock until the
  // request settles, while its results belong only to the originating session.
  const pending = useRef(new Set<string>())
  const [, renderPending] = useState(0)
  const busy = pending.current.has(runId)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ProposePrResult[] | null>(null)

  useEffect(() => { setResults(null); setError(null) }, [open, runId])

  const pushable = preflight?.repos.filter((r) => r.pushable) ?? []
  const eligible = open && preflightRead.confirmed && !loading && pushable.length > 0
  const propose = (): void => {
    if (!eligible || pending.current.has(runId)) return
    pending.current.add(runId)
    renderPending((version) => version + 1)
    setError(null)
    runsApi.proposeRunPr(runId)
      .then((r) => { if (session()) { setResults(r.results); onProposed?.() } })
      .catch((e: unknown) => { if (session()) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => {
        pending.current.delete(runId)
        if (mounted()) renderPending((version) => version + 1)
      })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="GitHub"
      title="Open a pull request from the fix"
      description={preflight?.gh.account ? `Signed in as ${preflight.gh.account}.` : undefined}
      testId="propose-pr-dialog"
      width={520}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="cl-button px-3 py-1 text-xs">
            {results ? 'Close' : 'Cancel'}
          </button>
          {!results && (
            <button
              type="button"
              data-testid="propose-pr-confirm"
              disabled={busy || !eligible}
              onClick={propose}
              className="cl-button-primary px-3 py-1 text-xs"
            >
              {busy ? 'Opening…' : pushable.length > 1 ? `Open ${pushable.length} PRs` : 'Open PR'}
            </button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        {loading && <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Checking GitHub access…</div>}
        {(error || preflightRead.error) && <div className="text-[12px]" style={{ color: 'var(--danger)' }}>{error || preflightRead.error}</div>}
        {!results && <button type="button" onClick={preflightRead.refresh} className="cl-button self-start px-3 py-1 text-xs">{preflightRead.error ? 'Retry' : 'Refresh'}</button>}

        {/* Results after proposing — PR links or per-repo failure reasons. */}
        {results && (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="propose-pr-results">
            {results.map((r) => (
              <li key={r.repoName} className="text-[12px]">
                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{r.repoName}</span>{' — '}
                {r.ok && r.pr
                  ? <a href={r.pr.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{r.pr.url}</a>
                  : <span style={{ color: 'var(--danger)' }}>{r.reason ?? 'failed'}</span>}
              </li>
            ))}
          </ul>
        )}

        {/* Per-repo preflight verdict, before proposing. */}
        {!results && preflight && preflight.repos.map((repo) => (
          <div key={repo.repoName} className="flex flex-col gap-0.5 rounded-md px-3 py-2" style={{ background: 'var(--bg-elevated)' }}>
            <div className="flex items-baseline gap-1.5 text-[12px]">
              <span aria-hidden style={{ color: repo.pushable ? 'var(--success)' : 'var(--warning)' }}>{repo.pushable ? '✓' : '!'}</span>
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{repo.repoName}</span>
              {repo.pushable && repo.origin && (
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  → {repo.origin.owner}/{repo.origin.name} : {repo.base}
                </span>
              )}
            </div>
            {repo.blocked && (
              <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {BLOCKED_HELP[repo.blocked.reason].line}
                {repo.blocked.detail && <span> {repo.blocked.detail}</span>}
                {BLOCKED_HELP[repo.blocked.reason].command && (
                  <code className="mt-0.5 block select-all rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                    {BLOCKED_HELP[repo.blocked.reason].command}
                  </code>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Says where the wording comes from, and why the confirm can sit for a
            while: an agent reads the diff first. Without this the pause after
            clicking reads as a hang. */}
        {!results && pushable.length > 0 && (
          <p className="m-0 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }} data-testid="propose-pr-authoring-note">
            The commit message and pull request description are written from the diff, so this can
            take a minute. Your repo is not touched — the commit is made in a scratch copy.
          </p>
        )}
      </div>
    </Modal>
  )
}
