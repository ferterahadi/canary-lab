import { useState } from 'react'
import { ApiError, asBranchMismatch, type RepoBranchMismatch } from '@/shared/api/client'
import { Modal } from '@/shared/ui/atoms'

// Maps a failed `POST /api/runs` into a human headline, the raw server reason,
// and a "what to do next" hint. Kept pure + exported so it's unit-testable
// without rendering. `detail` is the server's `{ error }` string (ApiError
// carries it as `.message`); `hint` is our guidance keyed off the status code.
export function describeRunStartError(err: unknown, feature: string): {
  title: string
  detail: string
  hint: string
} {
  const title = `Couldn’t start ${feature}`
  if (err instanceof ApiError) {
    // Prefer the server's `{ error }` reason; fall back to the Error message
    // (which `request()` already seeds from that body, but be defensive).
    const bodyError =
      err.body && typeof err.body === 'object' && typeof (err.body as { error?: unknown }).error === 'string'
        ? (err.body as { error: string }).error
        : undefined
    const detail = bodyError ?? err.message
    if (err.status === 404) {
      return {
        title,
        detail,
        hint: 'This suite no longer exists — it may have been deleted or renamed. Reload and pick a suite that’s still listed.',
      }
    }
    if (err.status === 400) {
      return {
        title,
        detail,
        hint: 'The request was rejected. Pick a valid environment for this suite, then try again.',
      }
    }
    if (err.status === 409) {
      return {
        title,
        detail,
        hint: 'This run can’t start yet — a precondition failed. Resolve what the message describes, then try again.',
      }
    }
    return {
      title,
      detail,
      hint: 'The server hit an error starting the run. Check the Canary Lab server logs, confirm the app repo and its services are reachable, then retry.',
    }
  }
  return {
    title: 'Couldn’t reach the server',
    detail: err instanceof Error ? err.message : String(err),
    hint: 'The Canary Lab server may have stopped or restarted. Confirm it’s running, then reload and retry.',
  }
}

interface Props {
  error: unknown
  /** The feature the user tried to start (for the headline). */
  feature: string
  /** Re-issue the same start request. Omitted when a retry can't be replayed. */
  onRetry?: () => void
  /** Branch-mismatch only: check out each repo's pinned branch, then retry. */
  onSwitchBranches?: () => Promise<void>
  /** Branch-mismatch only: re-pin the feature to the current branches, then retry. */
  onPinCurrent?: () => Promise<void>
  onClose: () => void
}

// Shown when a run-start request fails for any reason other than a same-app
// collision (that case has its own CollisionConfirmDialog). Two shapes:
//   • branch mismatch — the feature's repos aren't on their pinned branch: a
//     per-repo table plus Switch (checkout pinned) / Pin (adopt current) actions.
//   • everything else — the server's reason plus a next-step hint, so a failed
//     Run button never dead-ends silently.
// Mirrors the CollisionConfirmDialog pattern.
export function RunStartErrorDialog({ error, feature, onRetry, onSwitchBranches, onPinCurrent, onClose }: Props) {
  const mismatch = asBranchMismatch(error)

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      role="alertdialog"
      ariaLabel={mismatch ? 'Repos not on the suite’s branch' : 'Run failed to start'}
    >
      <div className="p-5">
        {mismatch
          ? <BranchMismatchBody mismatch={mismatch} onSwitchBranches={onSwitchBranches} onPinCurrent={onPinCurrent} onClose={onClose} />
          : <GenericErrorBody error={error} feature={feature} onRetry={onRetry} onClose={onClose} />}
      </div>
    </Modal>
  )
}

function GenericErrorBody({ error, feature, onRetry, onClose }: Pick<Props, 'error' | 'feature' | 'onRetry' | 'onClose'>) {
  const { title, detail, hint } = describeRunStartError(error, feature)
  return (
    <>
      <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed font-mono" style={{ color: 'var(--danger)' }}>
        {detail}
      </p>
      <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {hint}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="cl-button px-3 py-1 text-xs">
          Close
        </button>
        {onRetry && (
          <button type="button" onClick={onRetry} className="cl-button cl-button-primary px-3 py-1 text-xs">
            Retry
          </button>
        )}
      </div>
    </>
  )
}

function BranchMismatchBody({ mismatch, onSwitchBranches, onPinCurrent, onClose }: {
  mismatch: RepoBranchMismatch
  onSwitchBranches?: () => Promise<void>
  onPinCurrent?: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState<'switch' | 'pin' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const repos = mismatch.repos
  const n = repos.length
  const repoLabel = n === 1 ? repos[0].name : `${n} repos`

  // Each choice is described by the branch it lands every repo on — Switch →
  // each repo's configured `expected`; Pin → each repo's `current`. When those
  // agree across repos we show one branch name; when they diverge we list them
  // per repo. Either way each card shows an END STATE, never a `from → to` diff.
  const switchRows = repos.map((r) => ({ repo: r.name, branch: r.expected }))
  const pinRows = repos.map((r) => ({ repo: r.name, branch: currentBranchLabel(r) }))
  const expectedName = uniqueOrNull(switchRows.map((r) => r.branch))
  const currentName = uniqueOrNull(pinRows.map((r) => r.branch))

  const run = (which: 'switch' | 'pin', fn?: () => Promise<void>) => async (): Promise<void> => {
    if (!fn) return
    setBusy(which)
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }

  return (
    <>
      <h2 className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        <GitBranchIcon />
        Which branch should this run test?
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        <span className="font-mono">{mismatch.feature}</span> is set to always test{' '}
        <span className="font-mono">{expectedName ?? 'specific branches'}</span>, but{' '}
        {n === 1 ? <><span className="font-mono">{repos[0].name}</span> is</> : `its ${n} repos are`} on{' '}
        <span className="font-mono">{currentName ?? 'other branches'}</span> right now — so running as-is would
        test the wrong code.
      </p>

      <div className="mt-3.5 flex flex-col gap-2">
        {onSwitchBranches && (
          <OptionCard
            singleBranch={expectedName}
            title="The branches this suite targets"
            rows={switchRows}
            sideLabel="recommended"
            action={busy === 'switch' ? 'Switching…' : `Switch ${repoLabel}, then run`}
            recommended
            disabled={busy !== null}
            onClick={run('switch', onSwitchBranches)}
          />
        )}
        {onPinCurrent && (
          <OptionCard
            singleBranch={currentName}
            title="The branches you’re on now"
            rows={pinRows}
            sideLabel="pins each where it is"
            action={busy === 'pin' ? 'Pinning…' : `Pin the suite to ${currentName ? 'it' : 'these'}, then run`}
            disabled={busy !== null}
            onClick={run('pin', onPinCurrent)}
          />
        )}
      </div>

      {actionError && (
        <p className="mt-2 text-[12px] leading-relaxed font-mono" style={{ color: 'var(--danger)' }}>
          {actionError}
        </p>
      )}

      <div className="mt-3.5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={busy !== null}
          className="cl-button px-3 py-1 text-xs disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </>
  )
}

// A single branch choice — the whole card is the button. When every repo lands
// on the same branch (`singleBranch`), that name is the headline. When they
// diverge, the headline is `title` and each repo's resulting branch is listed.
// The recommended card carries the accent wash + a badge; both show a trailing
// chevron so the card reads as clickable.
function OptionCard({ singleBranch, title, rows, sideLabel, action, recommended, disabled, onClick }: {
  singleBranch: string | null
  title: string
  rows: Array<{ repo: string; branch: string }>
  sideLabel: string
  action: string
  recommended?: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`cl-branch-option ${recommended ? 'cl-branch-option-rec' : ''} flex w-full items-start gap-3 rounded px-3 py-2.5 text-left disabled:opacity-50`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={`${singleBranch ? 'font-mono' : ''} text-[13px] font-medium`}
            style={{ color: 'var(--text-primary)' }}
          >
            {singleBranch ?? title}
          </span>
          {recommended
            ? <span className="cl-badge-accent">Recommended</span>
            : <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{sideLabel}</span>}
        </div>
        {!singleBranch && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {rows.map((r) => (
              <div key={r.repo} className="flex items-baseline justify-between gap-3 font-mono text-[12px]">
                <span style={{ color: 'var(--text-secondary)' }}>{r.repo}</span>
                <span style={{ color: 'var(--text-primary)' }}>{r.branch}</span>
              </div>
            ))}
          </div>
        )}
        <div
          className="mt-1 text-[12px]"
          style={{ color: recommended ? 'var(--text-primary)' : 'var(--text-secondary)' }}
        >
          {action}
        </div>
      </div>
      <ChevronRightIcon />
    </button>
  )
}

function GitBranchIcon() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ color: 'var(--text-muted)' }} aria-hidden="true"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg
      className="cl-branch-chevron mt-0.5 shrink-0"
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function currentBranchLabel(r: { isGitRepo: boolean; detached: boolean; current: string | null }): string {
  if (!r.isGitRepo) return 'not a git repo'
  if (r.detached) return 'detached HEAD'
  return r.current ?? 'unknown'
}

function uniqueOrNull(values: Array<string | null>): string | null {
  const set = new Set(values.filter((v): v is string => !!v))
  return set.size === 1 ? [...set][0] : null
}
