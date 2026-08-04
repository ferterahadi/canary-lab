import { useCallback, useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { ApplyTarget } from '@/shared/api/client'
import type { RunFixCaptureRepo, RunProposedPr } from '@/shared/api/types'
import { ConfirmModal, StatusDot } from '@/shared/ui/atoms'
import { editorLabel } from '@/features/config/components/settings-options'
import { fileCountLabel, groupByDirectory, isTestPath } from '../utils/repair-files'
import { prBlockedLine } from '../utils/pr-blocked-copy'
import { CopyIconButton } from './RunServicePanels'
import { RepairPatchDialog } from './RepairPatchDialog'

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
// for. The patch text itself stays off the card; reading a unified diff in a
// side panel is the thing this card replaced.
//
// What the card does NOT print is deliberate. The repo root is the header's
// tooltip (plus a hover copy button), not a row: it repeated most of the patch
// path character for character, and both truncated before the part that told
// them apart. Paths in general are plumbing — the file list is the payload, so
// it gets the primary text colour and everything else stays secondary.

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
            {fileCountLabel(pending.foreignDirty.length)} in this repo
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
      runId,
      target: targets?.find((t) => t.repoName === repoName),
      openState: state[repoName] ?? { kind: 'idle' as const },
      onOpen: () => open(repoName),
    }),
  }
}

/** How many file paths a card lists before it rolls them up per directory. Past
 *  this the list stops being a legend you can scan against your editor and
 *  becomes a wall; which areas were touched is the question that survives. */
export const FILE_LIST_LIMIT = 8

/** How many directory rows the rollup shows before folding the tail into a
 *  count — the same wall problem one level up. */
export const DIR_ROLLUP_LIMIT = 6

export function RepairedRepoCard({
  runId,
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
  runId: string
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
  const [patchOpen, setPatchOpen] = useState(false)
  const changed = repo !== undefined
  const names = repo?.fileNames ?? []
  const repoRoot = target?.repoRoot ?? repo?.repoRoot ?? ''
  // The repo isn't where the run left it, so there is nothing to apply into and
  // nothing to open — the patch becomes the only route to the repair.
  const moved = target?.ready === false
  const tests = names.filter(isTestPath)
  const source = names.filter((f) => !isTestPath(f))
  const rolled = names.length > FILE_LIST_LIMIT
  const dirs = rolled ? groupByDirectory(source) : []
  const foldedDirs = Math.max(0, dirs.length - DIR_ROLLUP_LIMIT)
  // Whether the card is telling the whole story. It isn't when the list was
  // rolled up — and it isn't for a capture recorded before file names were kept
  // either, which is the case that must not lose its way to the patch.
  const listedEverything = !rolled && names.length >= (repo?.files ?? 0)

  return (
    <li className="cl-card group/card p-3" data-testid={`changes-repo-${repoName}`}>
      <div className="flex min-w-0 items-center gap-2">
        {/* Sky for a repair waiting to be reviewed — the app's in-progress hue,
            and this is unfinished work until it's read or merged. An untouched
            repo takes the idle dot rather than going unmarked. No pulse: this
            state isn't changing while you look at it. */}
        <StatusDot state={changed ? 'running' : 'idle'} pulse={false} />
        <div
          className="min-w-0 flex-1 truncate text-xs font-medium"
          style={{ color: changed ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          title={repoRoot || undefined}
        >
          {repoName}
        </div>
        {repoRoot && <CopyIconButton label="repo path" value={repoRoot} />}
        <span className="cl-rubric shrink-0" data-testid={`changes-state-${repoName}`}>
          {changed ? fileCountLabel(repo!.files) : 'unchanged'}
        </span>
      </div>

      {changed && tests.length > 0 && (
        // A repair is supposed to fix the app, not the test — so an edited spec
        // is the one thing on this card that must not sit at position 23 of a
        // flat list.
        <div className="mt-2" data-testid={`changes-tests-${repoName}`}>
          <div className="flex items-center gap-2">
            <StatusDot state="warning" pulse={false} />
            <span className="text-[11px]" style={{ color: 'var(--warning)' }}>
              {tests.length === 1 ? '1 test file was edited' : `${tests.length} test files were edited`} — review these first
            </span>
          </div>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 pl-[18px]">
            {tests.slice(0, FILE_LIST_LIMIT).map((f) => (
              <li
                key={f}
                className="min-w-0 truncate text-[11px]"
                style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}
                title={f}
              >
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {changed && !rolled && source.length > 0 && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-0.5 p-0" data-testid={`changes-files-${repoName}`}>
          {source.map((f) => (
            <li
              key={f}
              className="min-w-0 truncate text-[11px]"
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}
              title={f}
            >
              {f}
            </li>
          ))}
        </ul>
      )}

      {changed && rolled && (
        <div
          className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5"
          data-testid={`changes-dirs-${repoName}`}
        >
          {dirs.slice(0, DIR_ROLLUP_LIMIT).map((g) => (
            <div key={g.dir} className="col-span-2 grid grid-cols-subgrid">
              <span
                className="min-w-0 truncate text-[11px]"
                style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}
                title={g.dir}
              >
                {g.dir}
              </span>
              <span className="text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                {g.count}
              </span>
            </div>
          ))}
          {foldedDirs > 0 && (
            <span className="col-span-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              +{foldedDirs} more {foldedDirs === 1 ? 'directory' : 'directories'}
            </span>
          )}
        </div>
      )}

      {changed && (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {moved ? (
              <button
                type="button"
                data-testid={`changes-view-patch-${repoName}`}
                onClick={() => setPatchOpen(true)}
                title="Shows the captured diff — this repo can no longer be opened"
                className="cl-button cl-button-primary px-2.5 py-1 text-[11px]"
              >
                View patch
              </button>
            ) : (
              <button
                type="button"
                data-testid={`changes-open-repo-${repoName}`}
                onClick={onOpen}
                disabled={openState.kind === 'working'}
                title="Applies the repair into this repo as uncommitted changes, then opens it"
                className="cl-button cl-button-primary px-2.5 py-1 text-[11px]"
              >
                {openState.kind === 'working' ? 'Opening…' : 'Open in editor'}
              </button>
            )}
            <button
              type="button"
              data-testid={`changes-propose-${repoName}`}
              onClick={onProposeClick}
              className="cl-button px-2.5 py-1 text-[11px]"
              title="Commits the repair on its own branch and opens a pull request — the message and body are written by an agent from the diff"
            >
              Commit &amp; open PR…
            </button>
            {/* One entrance to the dialog per card: `View patch` already is it
                when the repo has moved. */}
            {!listedEverything && !moved && (
              <button
                type="button"
                data-testid={`changes-all-files-${repoName}`}
                onClick={() => setPatchOpen(true)}
                className="cl-button px-2.5 py-1 text-[11px]"
              >
                All {repo!.files} files
              </button>
            )}
          </div>

          <div className="mt-2 flex flex-col gap-1">
            <OpenOutcome repoName={repoName} state={openState} target={target} />
            <PrLine
              repoName={repoName}
              pr={pr}
              blockedReason={blockedReason}
              auto={auto}
            />
          </div>

          <RepairPatchDialog
            open={patchOpen}
            onClose={() => setPatchOpen(false)}
            runId={runId}
            repoName={repoName}
            files={repo!.files}
            fileNames={names}
          />
        </>
      )}
    </li>
  )
}

/** One outcome line: a status dot and a sentence. Used for both halves of the
 *  card's footer so the open result and the PR result read as one register. */
function OutcomeLine({
  state,
  tone,
  testId,
  children,
}: {
  state: 'success' | 'failed' | 'warning' | 'idle'
  tone: string
  testId: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2 text-[11px]" data-testid={testId} style={{ color: tone }}>
      <StatusDot state={state} pulse={false} className="mt-1" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

/** The result of the last open attempt, and — before any attempt — the reason
 *  this repo can't be opened at all. Silence here is the failure mode this card
 *  exists to avoid. */
function OpenOutcome({ repoName, state, target }: { repoName: string; state: OpenState; target?: ApplyTarget }) {
  if (state.kind === 'failed') {
    return (
      <OutcomeLine state="failed" tone="var(--danger)" testId={`changes-open-error-${repoName}`}>
        {state.reason}
      </OutcomeLine>
    )
  }
  if (state.kind === 'done') {
    return (
      <OutcomeLine state="success" tone="var(--success)" testId={`changes-open-done-${repoName}`}>
        Applied to your repo{state.editor ? ` · opened in ${editorLabel(state.editor)}` : ''}
      </OutcomeLine>
    )
  }
  if (state.kind === 'idle' && target?.ready === false) {
    return (
      <OutcomeLine state="warning" tone="var(--warning)" testId={`changes-open-blocked-${repoName}`}>
        {target.reason}
      </OutcomeLine>
    )
  }
  return null
}

/** What became of the pull request for this repo — a link, or the reason there
 *  isn't one. Never silent: a captured fix with no PR and no explanation is the
 *  thing this card exists to stop. The retry lives on the `Commit & open PR…`
 *  button a row above, which opens the same dialog. */
export function PrLine({
  repoName,
  pr,
  blockedReason,
  auto,
}: {
  repoName: string
  pr?: RunProposedPr
  blockedReason?: string
  auto: boolean
}) {
  if (pr) {
    return (
      <OutcomeLine state="success" tone="var(--text-muted)" testId={`changes-pr-${repoName}`}>
        {auto ? 'Draft pull request opened by this run' : 'Pull request opened'}{' '}
        <a href={pr.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{pr.url}</a>
      </OutcomeLine>
    )
  }
  if (blockedReason) {
    return (
      <OutcomeLine state="warning" tone="var(--text-muted)" testId={`changes-pr-blocked-${repoName}`}>
        No pull request — {prBlockedLine(blockedReason)}
      </OutcomeLine>
    )
  }
  return null
}
