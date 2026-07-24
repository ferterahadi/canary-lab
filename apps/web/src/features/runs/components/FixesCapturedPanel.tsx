import { useState } from 'react'
import * as api from '../../../shared/api/client'
import type { RunFixCapture, RunProposedPr } from '../../../shared/api/types'
import { PanelCard } from '../../../shared/ui/PanelCard'
import { ProposePrDialog } from './ProposePrDialog'

// R80 — "Fixes captured": the never-dead-end surface for a run's heal edits.
// A worktree run never touches the product repos, so this block is the ONLY way
// the fix reaches the user's tree. It always renders the patch path (Copy path ·
// Open in editor · Apply locally) so there is a next action even when a PR is
// impossible; a "Propose PR…" button opens the confirm dialog (which preflights
// per-repo push access), and any already-opened PRs link out per repo.

export function FixesCapturedPanel({
  fixCapture,
  runId,
  proposedPrs,
  onError,
  onProposed,
}: {
  fixCapture: RunFixCapture
  runId: string
  /** PRs already opened from this run (manifest.proposedPrs), shown per repo. */
  proposedPrs?: RunProposedPr[]
  onError?: (msg: string) => void
  /** Called after a PR is opened so the owner can re-poll for the fresh links. */
  onProposed?: () => void
}) {
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<{ results: api.ApplyFixResult[]; allOk: boolean } | null>(null)
  const [prOpen, setPrOpen] = useState(false)
  const report = (err: unknown): void => onError?.(err instanceof Error ? err.message : String(err))
  const prByRepo = new Map((proposedPrs ?? []).map((p) => [p.repoName, p]))

  if (fixCapture.repos.length === 0) return null

  const applyLocally = (): void => {
    setApplying(true)
    setApplyResult(null)
    api.applyRunFixes(runId)
      .then(setApplyResult)
      .catch(report)
      .finally(() => setApplying(false))
  }

  return (
    <div className="mt-2.5 w-full" data-testid="fixes-captured">
      <PanelCard kicker="Fixes captured">
        <p className="mb-2 text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
          The repair ran in an isolated worktree — your repos were untouched. The diff is saved as a patch you can apply.
        </p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {fixCapture.repos.map((repo) => (
            <li key={repo.repoName} className="flex min-w-0 flex-col gap-1 rounded-md px-3 py-2" style={{ background: 'var(--bg-elevated)' }}>
              <div className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                <span className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>{repo.repoName}</span>
                <span style={{ color: 'var(--text-muted)' }}>·</span>
                <span style={{ color: 'var(--text-secondary)' }}>{repo.files} file{repo.files === 1 ? '' : 's'}</span>
              </div>
              <div
                className="min-w-0 truncate text-[11px]"
                style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                title={repo.patchPath}
              >
                {repo.patchPath}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid={`fix-copy-path-${repo.repoName}`}
                  onClick={() => { void navigator.clipboard?.writeText(repo.patchPath).catch(report) }}
                  className="cl-button px-2 py-0.5 text-[11px]"
                >
                  Copy path
                </button>
                <button
                  type="button"
                  data-testid={`fix-open-editor-${repo.repoName}`}
                  onClick={() => { api.openEditor({ file: repo.patchPath }).catch(report) }}
                  className="cl-button px-2 py-0.5 text-[11px]"
                >
                  Open in editor
                </button>
                {prByRepo.has(repo.repoName) && (
                  <a
                    href={prByRepo.get(repo.repoName)!.url}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`fix-pr-link-${repo.repoName}`}
                    className="px-1 py-0.5 text-[11px]"
                    style={{ color: 'var(--accent)' }}
                  >
                    PR opened →
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="fix-apply-locally"
            disabled={applying}
            onClick={applyLocally}
            className="cl-button px-2.5 py-1 text-[11px]"
            style={{ color: 'var(--accent)' }}
            title="git apply --3way each patch into the real repo"
          >
            {applying ? 'Applying…' : 'Apply locally'}
          </button>
          <button
            type="button"
            data-testid="fix-propose-pr"
            onClick={() => setPrOpen(true)}
            className="cl-button px-2.5 py-1 text-[11px]"
            title="Open a pull request from the fix (asks first — pushing is teammate-visible)"
          >
            Propose PR…
          </button>
          {applyResult && (
            <span
              data-testid="fix-apply-result"
              className="text-[11px]"
              style={{ color: applyResult.allOk ? 'var(--success)' : 'var(--danger)' }}
            >
              {applyResult.allOk
                ? 'Applied to your repos.'
                : applyResult.results.filter((r) => !r.ok).map((r) => `${r.repoName}: ${r.reason ?? 'failed'}`).join(' · ')}
            </span>
          )}
        </div>
      </PanelCard>

      <ProposePrDialog open={prOpen} onClose={() => setPrOpen(false)} runId={runId} onProposed={onProposed} />
    </div>
  )
}
