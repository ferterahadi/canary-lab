import { useCallback, useState } from 'react'
import * as api from '@/shared/api/client'
import type { RunFixCapture, RunPrAttempt, RunProposedPr } from '@/shared/api/types'
import { DiffView } from '@/shared/ui/DiffView'
import { ProposePrDialog } from './ProposePrDialog'

// What the repair agent actually changed, on the run it changed it in.
//
// A run repairs in a throwaway working copy that is deleted at teardown, so the
// diff is the ONLY durable record — and it used to live exclusively on the
// flight page, which meant a repair could finish with the run screen showing no
// sign anything had happened. This tab is that record, per repo: how many files,
// the diff itself, and what became of the pull request.
//
// Per repo, not per service: several services can share one repo and therefore
// one working copy, so their fix is one diff. A repo with no local path (a
// tunnel, say) never gets a working copy and never appears here at all.

export function ChangesTab({
  runId,
  fixCapture,
  proposedPrs,
  prAttempt,
}: {
  runId: string
  fixCapture?: RunFixCapture
  proposedPrs?: RunProposedPr[]
  /** The last attempt, including its failures — the only place a captured fix
   *  with no PR can explain itself. */
  prAttempt?: RunPrAttempt
}) {
  const [prOpen, setPrOpen] = useState(false)
  const repos = fixCapture?.repos ?? []
  const prByRepo = new Map((proposedPrs ?? []).map((p) => [p.repoName, p]))
  const reasonByRepo = new Map(
    (prAttempt?.results ?? []).filter((r) => !r.ok && r.reason).map((r) => [r.repoName, r.reason!]),
  )

  if (repos.length === 0) {
    return (
      <div className="p-4 text-[12px]" style={{ color: 'var(--text-muted)' }} data-testid="changes-empty">
        Nothing was changed in your code on this run. A run only records changes when a repair
        agent edited something — a run that passed first time never started one.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="changes-tab">
      <p className="m-0 text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
        The repair ran in an isolated copy of your code — your repos were untouched. Each diff below
        is saved as a patch you can apply or open as a pull request.
      </p>
      {repos.map((repo) => (
        <RepoChanges
          key={repo.repoName}
          runId={runId}
          repoName={repo.repoName}
          files={repo.files}
          patchPath={repo.patchPath}
          pr={prByRepo.get(repo.repoName)}
          blockedReason={reasonByRepo.get(repo.repoName)}
          auto={prAttempt?.auto === true}
          onProposeClick={() => setPrOpen(true)}
        />
      ))}
      {/* The dialog's write goes through the run store, so the opened PR
          arrives here over the runs WebSocket — nothing to re-poll. */}
      <ProposePrDialog open={prOpen} onClose={() => setPrOpen(false)} runId={runId} />
    </div>
  )
}

function RepoChanges({
  runId,
  repoName,
  files,
  patchPath,
  pr,
  blockedReason,
  auto,
  onProposeClick,
}: {
  runId: string
  repoName: string
  files: number
  patchPath: string
  pr?: RunProposedPr
  blockedReason?: string
  auto: boolean
  onProposeClick: () => void
}) {
  const [diff, setDiff] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)

  // Fetch on first expand only: a patch can run to hundreds of kilobytes, and
  // several repos' worth on mount would be a wall of text nobody asked for.
  // The `fetched` latch covers the failure case too — a rejected read must not
  // be retried on every render, which is an endless request loop against a
  // patch file that is gone for good.
  const toggle = useCallback(() => {
    const next = !open
    setOpen(next)
    if (!next || fetched || loading) return
    setFetched(true)
    setLoading(true)
    api.getRunFixPatch(runId, repoName)
      .then((r) => setDiff(r.diff))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [open, fetched, loading, runId, repoName])

  return (
    <section
      className="flex min-w-0 flex-col gap-1.5 rounded-md px-3 py-2.5"
      style={{ background: 'var(--bg-elevated)' }}
      data-testid={`changes-repo-${repoName}`}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-[12px]">
        <span className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>{repoName}</span>
        <span style={{ color: 'var(--text-muted)' }}>·</span>
        <span style={{ color: 'var(--text-secondary)' }}>{files} file{files === 1 ? '' : 's'} changed</span>
      </div>

      <PrLine repoName={repoName} pr={pr} blockedReason={blockedReason} auto={auto} onProposeClick={onProposeClick} />

      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid={`changes-view-diff-${repoName}`}
          onClick={toggle}
          className="cl-button px-2 py-0.5 text-[11px]"
          style={{ color: 'var(--accent)' }}
        >
          {open ? 'Hide diff' : 'View diff'}
        </button>
        <button
          type="button"
          data-testid={`changes-open-editor-${repoName}`}
          onClick={() => { api.openEditor({ file: patchPath }).catch(() => {}) }}
          className="cl-button px-2 py-0.5 text-[11px]"
        >
          Open in editor
        </button>
        <button
          type="button"
          data-testid={`changes-copy-path-${repoName}`}
          onClick={() => { void navigator.clipboard?.writeText(patchPath).catch(() => {}) }}
          className="cl-button px-2 py-0.5 text-[11px]"
        >
          Copy path
        </button>
      </div>

      {open && (
        <div className="mt-1">
          {loading && <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Loading the diff…</div>}
          {error && <div className="text-[11px]" style={{ color: 'var(--danger)' }} data-testid={`changes-diff-error-${repoName}`}>{error}</div>}
          {diff !== null && <DiffView diff={diff} />}
        </div>
      )}
    </section>
  )
}

/** What became of the pull request for this repo — a link, the reason there
 *  isn't one, or the offer to open it by hand. Never silent: a captured fix with
 *  no PR and no explanation is the thing this tab exists to stop. */
function PrLine({
  repoName,
  pr,
  blockedReason,
  auto,
  onProposeClick,
}: {
  repoName: string
  pr?: RunProposedPr
  blockedReason?: string
  auto: boolean
  onProposeClick: () => void
}) {
  if (pr) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid={`changes-pr-${repoName}`}>
        <span style={{ color: 'var(--text-muted)' }}>{auto ? 'Draft pull request opened by this run' : 'Pull request opened'}</span>
        <a href={pr.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{pr.url}</a>
      </div>
    )
  }
  if (blockedReason) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid={`changes-pr-blocked-${repoName}`}>
        <span style={{ color: 'var(--text-muted)' }}>No pull request — {blockedReason}</span>
        <button type="button" onClick={onProposeClick} className="cl-button px-2 py-0.5 text-[11px]">Try again…</button>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid={`changes-pr-none-${repoName}`}>
      <span style={{ color: 'var(--text-muted)' }}>No pull request yet</span>
      <button type="button" onClick={onProposeClick} className="cl-button px-2 py-0.5 text-[11px]">Propose PR…</button>
    </div>
  )
}
