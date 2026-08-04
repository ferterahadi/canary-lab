import { useState } from 'react'
import type { RepoBranchSnapshot, RunFixCapture, RunPrAttempt, RunProposedPr } from '@/shared/api/types'
import { RunPane } from './RunPane'
import { RepairedRepoCard, useRepoOpener } from './RepairedRepoCard'
import { ProposePrDialog } from './ProposePrDialog'

// What the repair agent actually changed, on the run it changed it in.
//
// Every repo the feature declares gets a card, not just the ones that changed:
// with several repos in play, "which of these did the agent touch?" is the
// question the tab is opened to answer, and a list that silently omits the
// untouched ones answers it only by absence. Repos with a repair sort to the
// top — the ones that need reading come first.
//
// Per repo, not per service: several services can share one repo and therefore
// one working copy, so their fix is one diff. Splitting the cards per service
// would either duplicate that diff or invent a division git cannot make.

export function ChangesTab({
  runId,
  fixCapture,
  proposedPrs,
  prAttempt,
  repoBranches,
}: {
  runId: string
  fixCapture?: RunFixCapture
  proposedPrs?: RunProposedPr[]
  /** The last attempt, including its failures — the only place a captured fix
   *  with no PR can explain itself. */
  prAttempt?: RunPrAttempt
  /** Every repo the run booted from, which is the roster the untouched cards
   *  come from. Absent on runs recorded before it was captured; the tab then
   *  falls back to showing only what changed. */
  repoBranches?: RepoBranchSnapshot[]
}) {
  const [prOpen, setPrOpen] = useState(false)
  const repos = fixCapture?.repos ?? []
  const changed = new Map(repos.map((r) => [r.repoName, r]))
  const prByRepo = new Map((proposedPrs ?? []).map((p) => [p.repoName, p]))
  const reasonByRepo = new Map(
    (prAttempt?.results ?? []).filter((r) => !r.ok && r.reason).map((r) => [r.repoName, r.reason!]),
  )
  const opener = useRepoOpener(runId, repos.length > 0)

  if (repos.length === 0) {
    return (
      <RunPane padded>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }} data-testid="changes-empty">
          Nothing was changed in your code on this run. A run only records changes when a repair
          agent edited something — a run that passed first time never started one.
        </div>
      </RunPane>
    )
  }

  return (
    <RunPane padded>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="changes-tab">
        {rosterFor(repos.map((r) => r.repoName), repoBranches).map((repoName) => (
          <RepairedRepoCard
            key={repoName}
            repoName={repoName}
            {...(changed.has(repoName) ? { repo: changed.get(repoName)! } : {})}
            {...opener.cardProps(repoName)}
            {...(prByRepo.has(repoName) ? { pr: prByRepo.get(repoName)! } : {})}
            {...(reasonByRepo.has(repoName) ? { blockedReason: reasonByRepo.get(repoName)! } : {})}
            auto={prAttempt?.auto === true}
            onProposeClick={() => setPrOpen(true)}
          />
        ))}
      </ul>
      {opener.confirm}
      {/* The dialog's write goes through the run store, so the opened PR
          arrives here over the runs WebSocket — nothing to re-poll. */}
      <ProposePrDialog open={prOpen} onClose={() => setPrOpen(false)} runId={runId} />
    </RunPane>
  )
}

/**
 * Repo names to render, repaired ones first. The roster is the run's own repo
 * list; a repaired repo missing from it is still listed rather than dropped —
 * the capture is the harder evidence of the two, and losing a card that has a
 * patch behind it would be the one failure this tab cannot afford.
 */
export function rosterFor(changedNames: string[], repoBranches?: RepoBranchSnapshot[]): string[] {
  const changed = new Set(changedNames)
  const untouched = (repoBranches ?? []).map((r) => r.name).filter((name) => !changed.has(name))
  return [...changedNames, ...untouched]
}
