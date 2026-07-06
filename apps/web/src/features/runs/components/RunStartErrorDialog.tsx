import { useEffect, useState } from 'react'
import { ApiError, asBranchMismatch, type RepoBranchMismatch } from '../../../shared/api/client'

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
        hint: 'This feature no longer exists — it may have been deleted or renamed. Reload and pick a feature that’s still listed.',
      }
    }
    if (err.status === 400) {
      return {
        title,
        detail,
        hint: 'The request was rejected. Pick a valid environment for this feature, then try again.',
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="cl-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="cl-modal w-[480px] p-5"
        style={{ background: 'var(--bg-elevated)' }}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label={mismatch ? 'Repos not on the feature’s branch' : 'Run failed to start'}
      >
        {mismatch
          ? <BranchMismatchBody mismatch={mismatch} onSwitchBranches={onSwitchBranches} onPinCurrent={onPinCurrent} onClose={onClose} />
          : <GenericErrorBody error={error} feature={feature} onRetry={onRetry} onClose={onClose} />}
      </div>
    </div>
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

  // The common case: every drifted repo shares one expected branch, and one
  // current branch. Name them when they agree; fall back to a generic label
  // when the repos diverge (still correct — the actions act per-repo).
  const expectedName = uniqueOrNull(repos.map((r) => r.expected))
  const currentName = uniqueOrNull(repos.map((r) => (r.isGitRepo && !r.detached ? r.current : null)))
  const repoLabel = n === 1 ? repos[0].name : `${n} repos`

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
      <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        Which branch should this run test?
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        <span className="font-mono">{mismatch.feature}</span> is set to always test{' '}
        <span className="font-mono">{expectedName ?? 'its configured branch'}</span>, but{' '}
        {n === 1 ? <><span className="font-mono">{repos[0].name}</span> is</> : `${n} repos are`} on{' '}
        <span className="font-mono">{currentName ?? 'another branch'}</span> right now — so running as-is would
        test the wrong code.
      </p>

      <div className="mt-3.5 flex flex-col gap-2">
        {onSwitchBranches && (
          <OptionCard
            branch={expectedName ?? 'Its configured branch'}
            role="the branch this feature targets"
            action={busy === 'switch'
              ? 'Switching…'
              : `Switch ${repoLabel} to ${expectedName ? 'it' : 'their branches'}, then run`}
            recommended
            disabled={busy !== null}
            onClick={run('switch', onSwitchBranches)}
          />
        )}
        {onPinCurrent && (
          <OptionCard
            branch={currentName ?? 'The current branches'}
            role="the branch you’re on now"
            action={busy === 'pin'
              ? 'Pinning…'
              : `Pin the feature to ${currentName ? 'it' : 'them'}, then run`}
            disabled={busy !== null}
            onClick={run('pin', onPinCurrent)}
          />
        )}
      </div>

      {n > 1 && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Affects {repos.map((r) => r.name).join(', ')}.
        </p>
      )}

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

// A single branch choice. The whole card is the button — big hit target, the
// branch name is the headline, and one line says exactly what picking it does.
function OptionCard({ branch, role, action, recommended, disabled, onClick }: {
  branch: string
  role: string
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
      className="cl-branch-option w-full rounded border px-3 py-2.5 text-left disabled:opacity-50"
      style={{ borderColor: recommended ? 'var(--accent)' : 'var(--border-default)' }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {branch}
        </span>
        <span className="text-[11px]" style={{ color: recommended ? 'var(--accent)' : 'var(--text-muted)' }}>
          {recommended ? 'recommended' : role}
        </span>
      </div>
      <div className="mt-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {action}
      </div>
    </button>
  )
}

function uniqueOrNull(values: Array<string | null>): string | null {
  const set = new Set(values.filter((v): v is string => !!v))
  return set.size === 1 ? [...set][0] : null
}
