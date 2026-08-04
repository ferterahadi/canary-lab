import { useCallback, useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { ApplyTarget } from '@/shared/api/client'
import type { RunFixCaptureRepo, RunProposedPr } from '@/shared/api/types'
import { ConfirmModal } from '@/shared/ui/atoms'
import { Chip } from '@/shared/ui/StatusChip'
import { ServiceField } from './RunServicePanels'

// One repo of a run's repair, as a card — the unit both the Changes tab and the
// flight's Test Run stage render, so the two surfaces can't drift apart again
// (they were near-identical copies that had already diverged on which actions
// they offered).
//
// The card is built around one fact: by the time anyone reads it, the scratch
// worktree the agent edited is GONE. Teardown captures a patch and deletes the
// copy, so there is no branch to visit and nothing uncommitted anywhere. The
// primary action therefore has to CREATE the thing the user wants to look at —
// it lands the patch in the real repo as unstaged edits, then opens that repo
// in their editor, where the changed-files list is the view they actually came
// for. The patch text itself is deliberately not shown; reading a unified diff
// in a side panel is the thing this card replaced.

/** Per-repo progress of the apply-then-open action. */
type OpenState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; editor?: string }
  | { kind: 'failed'; reason: string }

/**
 * Shared owner for "put this repair somewhere I can read it".
 *
 * Lives above the cards because the preflight is one request for the whole run,
 * and because the confirm is modal — two cards must never each own a copy of
 * it. Callers render `confirm` once and spread `cardProps(repoName)` per card.
 */
export function useRepoOpener(runId: string, enabled: boolean) {
  const [targets, setTargets] = useState<ApplyTarget[] | null>(null)
  const [state, setState] = useState<Record<string, OpenState>>({})
  const [pending, setPending] = useState<ApplyTarget | null>(null)

  // The preflight reads the user's repos as they are RIGHT NOW, not as the run
  // snapshotted them at boot — they have had the whole run to edit their tree,
  // and whether it is dirty decides if opening it needs to ask first.
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.getRunApplyPreflight(runId)
      .then((r) => { if (live) setTargets(r.targets) })
      // A preflight we could not read must not disable the action: the apply
      // itself reports its own failure, so the worst case is asking nothing
      // and finding out on click, not a dead button.
      .catch(() => { if (live) setTargets([]) })
    return () => { live = false }
  }, [runId, enabled])

  const run = useCallback(async (repoName: string) => {
    setState((s) => ({ ...s, [repoName]: { kind: 'working' } }))
    try {
      const applied = await api.applyRunFixes(runId, repoName)
      const failure = applied.results.find((r) => !r.ok)
      if (failure) {
        setState((s) => ({ ...s, [repoName]: { kind: 'failed', reason: failure.reason ?? 'the patch did not apply' } }))
        return
      }
      // Only open once the edits are actually in the tree — opening first would
      // show the user an unchanged repo and read as "it did nothing".
      const opened = await api.openRunRepo(runId, repoName)
      setState((s) => ({
        ...s,
        [repoName]: opened.opened
          ? { kind: 'done', ...(opened.editor ? { editor: opened.editor } : {}) }
          : { kind: 'failed', reason: opened.error ?? 'the editor would not launch' },
      }))
    } catch (err) {
      setState((s) => ({ ...s, [repoName]: { kind: 'failed', reason: err instanceof Error ? err.message : String(err) } }))
    }
  }, [runId])

  const open = useCallback((repoName: string) => {
    const target = targets?.find((t) => t.repoName === repoName)
    // Ask only when the repo carries edits that are NOT this repair. Warning on
    // raw dirtiness would nag on every re-open, because by then the tree is
    // dirty with our own patch.
    if (target && target.foreignDirty.length > 0) { setPending(target); return }
    void run(repoName)
  }, [targets, run])

  const confirm = pending && (
    <ConfirmModal
      open
      title={`${pending.repoName} already has uncommitted changes`}
      confirmLabel="Apply and open"
      message={
        <>
          <p className="m-0 leading-relaxed">
            {countLabel(pending.foreignDirty.length)} in this repo
            {pending.branch ? <> on <code style={{ fontFamily: 'var(--font-mono)' }}>{pending.branch}</code></> : null}
            {' '}already changed before the repair lands. Both sets will show up together in your
            editor’s changed-files list.
          </p>
          <p className="m-0 mt-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            The files the repair touches are listed on the card, so you can tell them apart.
          </p>
        </>
      }
      onCancel={() => setPending(null)}
      onConfirm={() => { const t = pending; setPending(null); void run(t.repoName) }}
    />
  )

  return {
    confirm,
    /** Everything a card needs to render and drive its own primary action. */
    cardProps: (repoName: string) => ({
      target: targets?.find((t) => t.repoName === repoName),
      openState: state[repoName] ?? { kind: 'idle' as const },
      onOpen: () => open(repoName),
    }),
  }
}

function countLabel(n: number): string {
  return n === 1 ? '1 file' : `${n} files`
}

/** How many file paths a card lists before it stops. Past this the list stops
 *  being a legend you can scan against your editor and becomes a wall; the
 *  count in the header still tells the truth. */
export const FILE_LIST_LIMIT = 8

export function RepairedRepoCard({
  repoName,
  repo,
  target,
  openState,
  onOpen,
  pr,
  blockedReason,
  auto,
  onProposeClick,
}: {
  repoName: string
  /** Absent for a repo the repair never touched — the card still renders, so
   *  "nothing changed here" is a stated fact rather than a missing row. */
  repo?: RunFixCaptureRepo
  target?: ApplyTarget
  openState: OpenState
  onOpen: () => void
  pr?: RunProposedPr
  blockedReason?: string
  auto: boolean
  onProposeClick: () => void
}) {
  const changed = repo !== undefined
  const names = repo?.fileNames ?? []
  const hidden = Math.max(0, (repo?.files ?? 0) - Math.min(names.length, FILE_LIST_LIMIT))

  return (
    <li className="cl-card group/card p-3" data-testid={`changes-repo-${repoName}`}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
          {repoName}
        </div>
        {/* Sky for a repair waiting to be reviewed — the app's in-progress hue,
            and this is unfinished work until it's read or merged. Untouched
            repos state themselves in muted grey rather than going unlabelled. */}
        <Chip
          tone={changed ? 'var(--accent)' : 'var(--text-muted)'}
          chrome="fill"
          uppercase
          label={changed ? `${repo!.files} ${repo!.files === 1 ? 'file' : 'files'}` : 'unchanged'}
          testId={`changes-state-${repoName}`}
        />
      </div>

      {changed && names.length > 0 && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-0.5 p-0" data-testid={`changes-files-${repoName}`}>
          {names.slice(0, FILE_LIST_LIMIT).map((f) => (
            <li
              key={f}
              className="min-w-0 truncate text-[11px]"
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
              title={f}
            >
              {f}
            </li>
          ))}
          {hidden > 0 && (
            <li className="text-[11px]" style={{ color: 'var(--text-muted)' }}>+{hidden} more</li>
          )}
        </ul>
      )}

      <div className="mt-2.5 grid grid-cols-[34px_minmax(0,1fr)_20px] items-center gap-x-2.5 gap-y-1.5">
        <ServiceField label="repo" value={target?.repoRoot ?? repo?.repoRoot ?? ''} />
        {/* The patch stays reachable but stops being the headline: it is the
            fallback for a repo whose path is gone, not the way to read a fix. */}
        {changed && <ServiceField label="patch" value={repo!.patchPath} />}
      </div>

      {changed && (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid={`changes-open-repo-${repoName}`}
              onClick={onOpen}
              disabled={openState.kind === 'working' || target?.ready === false}
              title={target?.ready === false
                ? target.reason
                : 'Applies the repair into this repo as uncommitted changes, then opens it'}
              className="cl-button cl-button-primary px-2.5 py-1 text-[11px]"
            >
              {openState.kind === 'working' ? 'Opening…' : 'Open in editor'}
            </button>
            <button
              type="button"
              data-testid={`changes-propose-${repoName}`}
              onClick={onProposeClick}
              className="cl-button px-2.5 py-1 text-[11px]"
              title="Commits the repair on its own branch and opens a pull request — the message and body are written by an agent from the diff"
            >
              Commit &amp; open PR…
            </button>
            <OpenOutcome repoName={repoName} state={openState} target={target} />
          </div>
          <PrLine
            repoName={repoName}
            pr={pr}
            blockedReason={blockedReason}
            auto={auto}
            onProposeClick={onProposeClick}
          />
        </>
      )}
    </li>
  )
}

/** The result of the last open attempt, and — before any attempt — the reason
 *  the button is dead when the repo has moved out from under the run. Silence
 *  here is the failure mode this card exists to avoid. */
function OpenOutcome({ repoName, state, target }: { repoName: string; state: OpenState; target?: ApplyTarget }) {
  if (state.kind === 'failed') {
    return (
      <span className="text-[11px]" style={{ color: 'var(--danger)' }} data-testid={`changes-open-error-${repoName}`}>
        {state.reason}
      </span>
    )
  }
  if (state.kind === 'done') {
    return (
      <span className="text-[11px]" style={{ color: 'var(--success)' }} data-testid={`changes-open-done-${repoName}`}>
        Applied · opened{state.editor ? ` in ${state.editor}` : ''}
      </span>
    )
  }
  if (state.kind === 'idle' && target?.ready === false) {
    return (
      <span className="text-[11px]" style={{ color: 'var(--warning)' }} data-testid={`changes-open-blocked-${repoName}`}>
        {target.reason}
      </span>
    )
  }
  return null
}

/** What became of the pull request for this repo — a link, the reason there
 *  isn't one, or the offer to open it by hand. Never silent: a captured fix with
 *  no PR and no explanation is the thing this card exists to stop. */
export function PrLine({
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
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]" data-testid={`changes-pr-${repoName}`}>
        <span style={{ color: 'var(--text-muted)' }}>{auto ? 'Draft pull request opened by this run' : 'Pull request opened'}</span>
        <a href={pr.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{pr.url}</a>
      </div>
    )
  }
  if (blockedReason) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]" data-testid={`changes-pr-blocked-${repoName}`}>
        <span style={{ color: 'var(--text-muted)' }}>No pull request — {blockedReason}</span>
        <button type="button" onClick={onProposeClick} className="cl-button px-2 py-0.5 text-[11px]">Try again…</button>
      </div>
    )
  }
  return null
}
