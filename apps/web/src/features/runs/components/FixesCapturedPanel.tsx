import { useState } from 'react'
import type { RunFixCapture, RunProposedPr } from '@/shared/api/types'
import { PanelCard } from '@/shared/ui/PanelCard'
import { RepairedRepoCard, useRepoOpener } from './RepairedRepoCard'
import { ProposePrDialog } from './ProposePrDialog'

// R80 — "Fixes captured": the never-dead-end surface for a run's heal edits on
// the flight's Test Run stage.
//
// The cards are the SAME component the run's Changes tab renders, so a repair
// offers the same actions wherever it surfaces. What differs is the roster: a
// stage summarises the run it just watched, so only repaired repos appear here
// — the full "which repos were untouched" ledger belongs on the drill-through.

export function FixesCapturedPanel({
  fixCapture,
  runId,
  proposedPrs,
  onProposed,
}: {
  fixCapture: RunFixCapture
  runId: string
  /** PRs already opened from this run (manifest.proposedPrs), shown per repo. */
  proposedPrs?: RunProposedPr[]
  /** Called after a PR is opened so the owner can re-poll for the fresh links. */
  onProposed?: () => void
}) {
  const [prOpen, setPrOpen] = useState(false)
  const prByRepo = new Map((proposedPrs ?? []).map((p) => [p.repoName, p]))
  const opener = useRepoOpener(runId, fixCapture.repos.length > 0)

  if (fixCapture.repos.length === 0) return null

  return (
    <div className="mt-2.5 w-full" data-testid="fixes-captured">
      <PanelCard kicker="Fixes captured">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {fixCapture.repos.map((repo) => (
            <RepairedRepoCard
              key={repo.repoName}
              repoName={repo.repoName}
              repo={repo}
              {...opener.cardProps(repo.repoName)}
              {...(prByRepo.has(repo.repoName) ? { pr: prByRepo.get(repo.repoName)! } : {})}
              auto={false}
              onProposeClick={() => setPrOpen(true)}
            />
          ))}
        </ul>
      </PanelCard>

      {opener.confirm}
      <ProposePrDialog open={prOpen} onClose={() => setPrOpen(false)} runId={runId} onProposed={onProposed} />
    </div>
  )
}
