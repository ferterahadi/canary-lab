import { useApplyPreflight } from '../state/use-apply-preflight'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as runsApi from '@/shared/api/runs'
import type { ApplyTarget } from '@/shared/api/runs'
import type { RunFixCaptureRepo, RunProposedPr } from '@shared/run-state'
import { StatusDot } from '@/shared/ui/atoms'
import { ConfirmModal } from '@/shared/ui/Overlays'
import { editorLabel } from '@/features/config/components/settings-options'
import { fileCountLabel, isTestPath } from '../utils/repair-files'
import { prBlockedLine } from '../utils/pr-blocked-copy'
import { CopyIconButton } from './RunServicePanels'
import { cycleReviewFromPatch } from '@shared/test-view/cycle-review'
import { DisclosureCaret, HintIcon } from '@/shared/ui/Icons'
import { CycleFileReview } from './CycleFileReview'
import { FieldRow } from './ResultRows'
import { displayError } from '@/shared/api/error-message'

// One repo of a run's repair, as a card — the unit both the Changes tab and the
// flight's Test Run stage render, so the two surfaces can't drift apart again
// (they were near-identical copies that had already diverged on which actions
// they offered).
//
// While the run is active, Open in editor shows the isolated worktree without
// applying it to the source repo. After teardown removes that worktree, the
// same action applies the final patch to the source repo before opening it.
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
  | { kind: 'done'; editor?: string; provisional?: boolean }
  | { kind: 'failed'; reason: string }

/**
 * Shared owner for "put this repair somewhere I can read it".
 *
 * Lives above the cards because the preflight is one request for the whole run,
 * and because the confirm is modal — two cards must never each own a copy of
 * it. Callers render `confirm` once and spread `cardProps(repoName)` per card.
 */
export function useRepoOpener(runId: string, finalCapture: boolean, provisional = false) {
  const preflight = useApplyPreflight(runId, finalCapture)
  const targets = preflight.value?.targets
  const refreshPreflight = preflight.refresh
  const identity = JSON.stringify([runId, provisional, finalCapture])
  const current = useRef({ identity, generation: 0 })
  if (current.current.identity !== identity) current.current = { identity, generation: current.current.generation + 1 }
  const generation = current.current.generation
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [state, setState] = useState<Record<string, OpenState>>({})
  const [pending, setPending] = useState<ApplyTarget | null>(null)

  useEffect(() => {
    setState({})
    setPending(null)
  }, [runId, provisional])

  const run = useCallback(async (repoName: string) => {
    const alive = () => mounted.current && current.current.generation === generation
    const update = (value: OpenState) => { if (alive()) setState((s) => ({ ...s, [repoName]: value })) }
    update({ kind: 'working' })
    try {
      if (provisional) {
        const opened = await runsApi.openRunRepo(runId, repoName)
        update(opened.opened
          ? { kind: 'done', provisional: true, ...(opened.editor ? { editor: opened.editor } : {}) }
          : { kind: 'failed', reason: opened.error ?? 'the editor would not launch' })
        return
      }
      const applied = await runsApi.applyRunFixes(runId, repoName)
      if (!alive()) return
      const failure = applied.results.find((r) => !r.ok)
      if (failure) {
        update({ kind: 'failed', reason: failure.reason ?? 'the patch did not apply' })
        return
      }
      // Only open once the edits are actually in the tree — opening first would
      // show the user an unchanged repo and read as "it did nothing".
      const opened = await runsApi.openRunRepo(runId, repoName)
      update(opened.opened
        ? { kind: 'done', ...(opened.editor ? { editor: opened.editor } : {}) }
        : { kind: 'failed', reason: opened.error ?? 'the editor would not launch' })
    } catch (err) {
      update({ kind: 'failed', reason: displayError(err) })
    } finally {
      if (alive() && !provisional) refreshPreflight()
    }
  }, [runId, provisional, generation, refreshPreflight])

  const open = useCallback((repoName: string) => {
    if (!provisional && !preflight.confirmed) return
    const target = targets?.find((t) => t.repoName === repoName)
    // Ask only when the repo carries edits that are NOT this repair. Warning on
    // raw dirtiness would nag on every re-open, because by then the tree is
    // dirty with our own patch.
    if (target && target.foreignDirty.length > 0) { setPending(target); return }
    void run(repoName)
  }, [targets, run, provisional, preflight.confirmed])

  const pendingTarget = targets?.find((t) => t.repoName === pending?.repoName) ?? pending
  const confirm = pendingTarget && (
    <ConfirmModal
      open
      title={pendingTarget.foreignDirty.length ? `${pendingTarget.repoName} already has uncommitted changes` : `${pendingTarget.repoName} has no unrelated changes`}
      confirmLabel="Apply and open"
      confirmDisabled={!preflight.confirmed || !pendingTarget.ready}
      message={
        <>
          <p className="m-0 leading-relaxed">
            {pendingTarget.foreignDirty.length ? <>
              {fileCountLabel(pendingTarget.foreignDirty.length)} in this repo
              {pendingTarget.branch ? <> on <code style={{ fontFamily: 'var(--font-mono)' }}>{pendingTarget.branch}</code></> : null}
              {' '}already changed before the repair lands. Both sets will show up together in your
              editor’s changed-files list.
            </> : 'The unrelated changes are gone. You can apply this repair and open it in your editor.'}
          </p>
          <p className="m-0 mt-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            The files the repair touches are listed on the card, so you can tell them apart.
          </p>
        </>
      }
      onCancel={() => setPending(null)}
      onConfirm={() => { const t = pendingTarget; setPending(null); void run(t.repoName) }}
    />
  )

  return {
    confirm,
    /** Everything a card needs to render and drive its own primary action. */
    cardProps: (repoName: string) => ({
      runId,
      target: targets?.find((t) => t.repoName === repoName),
      preflight: provisional ? undefined : {
        confirmed: preflight.confirmed, error: preflight.error, refresh: preflight.refresh,
      },
      openState: state[repoName] ?? { kind: 'idle' as const },
      onOpen: () => open(repoName),
    }),
  }
}

/** How many edited test files the warning row names; the editor's file
 *  picker holds the rest. */
export const FILE_LIST_LIMIT = 8

export function RepairedRepoCard({
  runId,
  repoName,
  repo,
  target,
  preflight,
  openState,
  onOpen,
  pr,
  blockedReason,
  auto,
  provisional = false,
  liveWorktreeRoot,
  canUseFinalCapture,
  onProposeClick,
  capturedAt,
  defaultExpanded = false,
}: {
  runId: string
  repoName: string
  /** Absent for a repo the repair never touched — the card still renders, so
   *  "nothing changed here" is a stated fact rather than a missing row. */
  repo?: RunFixCaptureRepo
  target?: ApplyTarget
  preflight?: { confirmed: boolean; error: string | null; refresh: () => void }
  openState: OpenState
  onOpen: () => void
  pr?: RunProposedPr
  blockedReason?: string
  auto: boolean
  provisional?: boolean
  liveWorktreeRoot?: string
  canUseFinalCapture: boolean
  onProposeClick: () => void
  /** The capture's timestamp: an open patch re-reads when it moves, so live
   *  edits during healing reach the editor without a reopen. */
  capturedAt?: string
  /** Opens on the editor — the Changes tab expands its first repaired repo. */
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const changed = repo !== undefined
  const names = repo?.fileNames ?? []
  const repoRoot = provisional ? liveWorktreeRoot ?? '' : target?.repoRoot ?? repo?.repoRoot ?? ''
  // The repo isn't where the run left it, so there is nothing to apply into and
  // nothing to open; the PR dialog says why a pull request can't go out either.
  const moved = target?.ready === false
  const tests = names.filter(isTestPath)
  const waitForStop = 'Available after this run stops and captures its final changes.'

  const preflightLine = preflight && !preflight.confirmed
  // Only what explains the header's Open in editor — its result, or why it is
  // disabled — earns a row; the header already says everything else.
  const openLine = preflightLine || openState.kind === 'failed' || openState.kind === 'done'
  const prLine = pr !== undefined || blockedReason !== undefined
  // The head's hairline closes the title strip, so only bands after the first
  // draw their own.
  const bands = [tests.length > 0, changed && expanded, changed && openLine, changed && prLine]
  const ruled = (index: number) => bands.slice(0, index).some(Boolean)

  return (
    <li className="cl-card group/card overflow-hidden" data-testid={`changes-repo-${repoName}`}>
      <div className={`cl-card-head${bands.some(Boolean) ? '' : ' border-b-0'}`}>
        {changed ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left"
            data-testid={`changes-toggle-${repoName}`}
            title={repoRoot || undefined}
          >
            <DisclosureCaret open={expanded} />
            <span className="min-w-0 truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{repoName}</span>
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid={`changes-state-${repoName}`}>{fileCountLabel(repo!.files)}</span>
            {target?.inRepo && (
              <span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }} title={IN_REPO[target.inRepo].hint} data-testid={`changes-in-repo-${repoName}`}>
                {IN_REPO[target.inRepo].label}
              </span>
            )}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2 pl-5" title={repoRoot || undefined}>
            <span className="min-w-0 truncate text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{repoName}</span>
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid={`changes-state-${repoName}`}>unchanged</span>
          </span>
        )}
        {repoRoot && <CopyIconButton label="repo path" value={repoRoot} />}
        {changed && !moved && (
          <button
            type="button"
            data-testid={`changes-open-repo-${repoName}`}
            onClick={onOpen}
            disabled={openState.kind === 'working' || (!provisional && (!canUseFinalCapture || preflight?.confirmed === false))}
            title={provisional ? 'Opens this run’s isolated worktree without applying its edits' : 'Applies the repair into this repo as uncommitted changes, then opens it'}
            className="cl-button shrink-0 px-2 py-0.5 text-[11px]"
          >
            {openState.kind === 'working' ? 'Opening…' : 'Open in editor'}
          </button>
        )}
        {changed && (
          <span title={canUseFinalCapture ? undefined : waitForStop} className={`inline-flex shrink-0 ${canUseFinalCapture ? '' : 'cursor-not-allowed'}`}>
            <button
              type="button"
              data-testid={`changes-propose-${repoName}`}
              onClick={onProposeClick}
              disabled={!canUseFinalCapture}
              aria-label={canUseFinalCapture ? 'Commit and open PR' : `Commit and open PR. ${waitForStop}`}
              className="cl-button px-2 py-0.5 text-[11px] disabled:pointer-events-none disabled:opacity-50"
              title={canUseFinalCapture ? 'Commits the repair on its own branch and opens a pull request — the message and body are written by an agent from the diff' : undefined}
            >
              Commit &amp; open PR…
            </button>
          </span>
        )}
      </div>

      {tests.length > 0 && (
        // A repair is supposed to fix the app, not the test — so an edited spec
        // stays in view whether or not the editor is open.
        <dl className="m-0" data-testid={`changes-tests-${repoName}`}>
          <FieldRow label="Tests" mark={<HintIcon glyph="!" hint="A repair fixes the app, not the test. Review these edits first." />}>
            <p className="m-0" style={{ color: 'var(--text-primary)' }}>
              {tests.length === 1 ? 'Edits 1 test file' : `Edits ${tests.length} test files`} — review these first
            </p>
            <ul className="m-0 mt-0.5 flex list-none flex-col p-0">
              {tests.slice(0, FILE_LIST_LIMIT).map((f) => (
                <li key={f} className="min-w-0 truncate text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={f}>{f}</li>
              ))}
            </ul>
          </FieldRow>
        </dl>
      )}

      {changed && expanded && (
        <div className={ruled(1) ? 'border-t' : ''} style={{ borderColor: 'var(--border-default)' }}>
          <RepoPatch runId={runId} repoName={repoName} capturedAt={capturedAt} />
        </div>
      )}

      {changed && (openLine || prLine) && (
        <dl className="m-0">
          {openLine && (
            <FieldRow label="Open" first={!ruled(2)}>
              {preflightLine && (
                <div role="status" className="text-[11px] text-muted">
                  {preflight!.error ? `Repository status unavailable: ${preflight!.error}` : 'Checking current repository status…'}
                  {target && ' Last known status shown.'}
                  <button type="button" className="cl-button ml-2 px-2 py-0.5" onClick={preflight!.refresh}>Refresh status</button>
                </div>
              )}
              <OpenOutcome repoName={repoName} state={openState} />
            </FieldRow>
          )}
          {prLine && (
            <FieldRow label="Pull request" first={!ruled(3)}>
              <PrLine repoName={repoName} pr={pr} blockedReason={blockedReason} auto={auto} />
            </FieldRow>
          )}
        </dl>
      )}
    </li>
  )
}

/** Where the repair stands in the user's own repo. The run edited an isolated
 *  copy, so a card with a diff must not read as a change already made. */
const IN_REPO = {
  absent: { label: 'Not in your repo', hint: 'The agent edited an isolated copy. Open in editor applies it here as uncommitted changes; a merged pull request lands it.' },
  uncommitted: { label: 'In your repo, uncommitted', hint: 'Your working tree holds this repair, not yet committed.' },
  committed: { label: 'Already in your repo', hint: 'Your repo holds this repair, committed.' },
} as const

/** The repo's captured patch in the code editor the repair cycles use, read
 *  when the card opens and again whenever the capture moves. */
function RepoPatch({ runId, repoName, capturedAt }: { runId: string; repoName: string; capturedAt?: string }) {
  const [patch, setPatch] = useState<runsApi.RunFixPatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setError(null)
    runsApi.getRunFixPatch(runId, repoName)
      .then((r) => { if (live) setPatch(r) })
      .catch((e: unknown) => { if (live) setError(displayError(e)) })
    return () => { live = false }
  }, [runId, repoName, capturedAt])
  const files = useMemo(() => patch ? cycleReviewFromPatch(patch.diff) : [], [patch])
  if (error) return <p className="m-0 px-3 py-2.5 text-[11px]" style={{ color: 'var(--danger)' }} data-testid={`changes-patch-error-${repoName}`}>{error}</p>
  if (!patch) return <p className="m-0 px-3 py-2.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>Reading the patch…</p>
  return (
    <div data-testid={`changes-patch-${repoName}`}>
      {files.length > 0
        ? <CycleFileReview files={files} cycle={0} span="run" bare />
        : <p className="m-0 px-3 py-2.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>The patch holds no file changes.</p>}
    </div>
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

/** The result of the last open attempt. */
function OpenOutcome({ repoName, state }: { repoName: string; state: OpenState }) {
  if (state.kind === 'failed') {
    return (
      <OutcomeLine state="failed" tone="var(--text-secondary)" testId={`changes-open-error-${repoName}`}>
        {state.reason}
      </OutcomeLine>
    )
  }
  if (state.kind === 'done') {
    return (
      <OutcomeLine state="success" tone="var(--text-secondary)" testId={`changes-open-done-${repoName}`}>
        {state.provisional ? 'Opened live run worktree' : 'Applied to your repo'}{state.editor ? ` · opened in ${editorLabel(state.editor)}` : ''}
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
