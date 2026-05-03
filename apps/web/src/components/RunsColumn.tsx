import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RunIndexEntry, TransientAction } from '../api/types'
import { formatDuration, durationBetween, shortTime } from '../lib/format'
import { canPauseHeal, canStop, canDelete, canCancelHeal, deriveDisplayStatus } from '../lib/run-actions'
import { ApiError, pauseHealRun, stopRun, deleteRun, cancelHealRun } from '../api/client'
import { RunStatusIndicator } from './RunStatusIndicator'

interface Props {
  feature: string | null
  envs?: string[]
  runs: RunIndexEntry[]
  selectedRunId: string | null
  onSelectRun: (runId: string | null) => void
  onStartRun: (env?: string) => void
  runDisabled?: boolean
  runDisabledReason?: string
  /**
   * Optimistic-delete hook. When provided, the parent owns the runs list and
   * is told to remove a runId immediately on confirm; we'll fall back to a
   * full refetch if the API call fails. Lets the row vanish in the same
   * frame as the click instead of waiting for the next 5s poll.
   */
  onOptimisticDelete?: (runId: string) => void
  /** Refresh hook used to roll back an optimistic delete on API failure. */
  onRefreshRuns?: () => void
}

// Inline SVG icons (no new dependency). Sizes are tuned to align with the
// 10 px text on the action buttons.
const ICON_TRASH = (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
    <path d="M5.5 2h5l.5 1H14v1H2V3h3l.5-1zM3.5 5h9l-.7 8.2a1.5 1.5 0 0 1-1.5 1.3H5.7a1.5 1.5 0 0 1-1.5-1.3L3.5 5zm2.5 2v6h1V7H6zm3 0v6h1V7H9z" />
  </svg>
)
const ICON_STOP = (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true">
    <rect x="3" y="3" width="10" height="10" rx="1.5" />
  </svg>
)
const ICON_PAUSE = (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true">
    <rect x="3" y="3" width="3" height="10" rx="1" />
    <rect x="10" y="3" width="3" height="10" rx="1" />
  </svg>
)

// Below this width the per-run action chips (Stop / Pause & Heal / status)
// stop fitting on a single line, so we collapse them into a kebab menu that
// pops over with the same options.
const COMPACT_THRESHOLD_PX = 360

export function RunsColumn({ feature, envs = [], runs, selectedRunId, onSelectRun, onStartRun, runDisabled, runDisabledReason, onOptimisticDelete, onRefreshRuns }: Props) {
  const [envOverride, setEnvOverride] = useState<string | null>(null)
  const selectedEnv = envOverride && envs.includes(envOverride) ? envOverride : envs[0] ?? ''
  const [pendingPause, setPendingPause] = useState<RunIndexEntry | null>(null)
  const [pendingStop, setPendingStop] = useState<RunIndexEntry | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RunIndexEntry | null>(null)
  const [pendingCancelHeal, setPendingCancelHeal] = useState<RunIndexEntry | null>(null)
  const [pausingId, setPausingId] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [cancellingHealId, setCancellingHealId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ runId: string; message: string } | null>(null)
  const [openMenuRunId, setOpenMenuRunId] = useState<string | null>(null)
  const [runPopoverOpen, setRunPopoverOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (errorTimer.current) clearTimeout(errorTimer.current)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < COMPACT_THRESHOLD_PX)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Close the popover on any outside click.
  useEffect(() => {
    if (!openMenuRunId) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-run-menu]')) return
      setOpenMenuRunId(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openMenuRunId])

  // Same outside-click handler for the run-action popover (compact header).
  useEffect(() => {
    if (!runPopoverOpen) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-run-popover]')) return
      setRunPopoverOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [runPopoverOpen])

  // Close the popover automatically when leaving compact mode.
  useEffect(() => {
    if (!compact) setRunPopoverOpen(false)
  }, [compact])

  const showError = (runId: string, err: unknown): void => {
    let message: string
    if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'reason' in err.body) {
      message = String((err.body as { reason: unknown }).reason)
    } else {
      message = err instanceof Error ? err.message : String(err)
    }
    setActionError({ runId, message })
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => {
      setActionError((cur) => (cur && cur.runId === runId ? null : cur))
    }, 3000)
  }

  const confirmPause = async (): Promise<void> => {
    if (!pendingPause) return
    const target = pendingPause
    setPendingPause(null)
    setPausingId(target.runId)
    try {
      await pauseHealRun(target.runId)
      setActionError(null)
    } catch (err) {
      showError(target.runId, err)
    } finally {
      setPausingId(null)
    }
  }

  const confirmStop = async (): Promise<void> => {
    if (!pendingStop) return
    const target = pendingStop
    setPendingStop(null)
    setStoppingId(target.runId)
    try {
      await stopRun(target.runId)
      setActionError(null)
    } catch (err) {
      showError(target.runId, err)
    } finally {
      setStoppingId(null)
    }
  }

  const confirmCancelHeal = async (): Promise<void> => {
    if (!pendingCancelHeal) return
    const target = pendingCancelHeal
    setPendingCancelHeal(null)
    setCancellingHealId(target.runId)
    try {
      await cancelHealRun(target.runId)
      setActionError(null)
    } catch (err) {
      showError(target.runId, err)
    } finally {
      setCancellingHealId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    setDeletingId(target.runId)
    // Optimistic: tell the parent to drop the row immediately so it vanishes
    // in the same frame as the click. We still keep `deletingId` set in case
    // the parent doesn't own the list (no `onOptimisticDelete` prop) — then
    // the in-flight overlay below kicks in until the next poll.
    if (onOptimisticDelete) onOptimisticDelete(target.runId)
    // Clear selection eagerly so the right pane doesn't briefly 404 against
    // a runId we're already removing.
    if (selectedRunId === target.runId) onSelectRun(null)
    try {
      await deleteRun(target.runId)
      setActionError(null)
    } catch (err) {
      showError(target.runId, err)
      // Roll back the optimistic removal by refetching the canonical list.
      if (onRefreshRuns) onRefreshRuns()
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--text-muted)' }}>Runs</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {compact ? (
            <RunPopoverButton
              feature={feature}
              envs={envs}
              selectedEnv={selectedEnv}
              onSelectEnv={(v) => setEnvOverride(v)}
              disabled={!feature || Boolean(runDisabled)}
              disabledReason={runDisabledReason}
              open={runPopoverOpen}
              onToggle={() => setRunPopoverOpen((v) => !v)}
              onClose={() => setRunPopoverOpen(false)}
              onStartRun={() => { onStartRun(selectedEnv || undefined); setRunPopoverOpen(false) }}
            />
          ) : (
            <>
              {envs.length > 1 && (
                <select
                  value={selectedEnv}
                  onChange={(e) => setEnvOverride(e.target.value)}
                  disabled={!feature}
                  className="appearance-none rounded-md pl-2 pr-6 py-1 text-xs focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    background: `var(--bg-elevated) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 6px center`,
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                  aria-label="Environment"
                >
                  {envs.map((e) => (
                    <option key={e} value={e}>{e}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                disabled={!feature || runDisabled}
                title={runDisabled ? runDisabledReason : undefined}
                onClick={() => onStartRun(selectedEnv || undefined)}
                className="rounded-md bg-emerald-600/80 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Run Now
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!feature ? (
          <div className="px-4 py-6 text-xs" style={{ color: 'var(--text-muted)' }}>Select a feature.</div>
        ) : runs.length === 0 ? (
          <div className="px-4 py-6 text-xs" style={{ color: 'var(--text-muted)' }}>No runs yet for this feature.</div>
        ) : (
          <ul>
            {runs.map((r) => {
              const dur = durationBetween(r.startedAt, r.endedAt)
              const isSelected = r.runId === selectedRunId
              const isDeleting = deletingId === r.runId
              // Derive the row's transient action — first non-null wins.
              // Used to overlay 'ABORTING'/'PAUSING'/'CANCELLING' on the
              // status badge while the corresponding async action is in
              // flight, so the user sees their click acknowledged
              // immediately instead of a stale 'RUNNING'/'HEALING' label.
              const transient: TransientAction | null =
                stoppingId === r.runId ? 'aborting'
                : pausingId === r.runId ? 'pausing'
                : cancellingHealId === r.runId ? 'cancelling-heal'
                : isDeleting ? 'deleting'
                : null
              const displayStatus = deriveDisplayStatus(r.status, transient)
              if (isDeleting) {
                // In-flight overlay: row is greyed out, inert, and shows a
                // pulsing "… deleting …" indicator. Only visible if the
                // optimistic remove didn't already strip the row from the
                // list (i.e., the parent is on an older client that doesn't
                // pass `onOptimisticDelete`, OR the API takes long enough to
                // matter).
                return (
                  <li key={r.runId}>
                    <div
                      aria-busy="true"
                      aria-live="polite"
                      className="pointer-events-none flex w-full flex-col items-start gap-1.5 px-4 py-3 text-left"
                      style={{
                        borderBottom: '1px solid var(--border-default)',
                        background: 'transparent',
                        borderLeft: '2px solid transparent',
                        opacity: 0.55,
                      }}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="shrink-0 text-xs" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{shortTime(r.startedAt)}</span>
                        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-rose-500/80 dark:text-rose-400/80 animate-pulse">
                          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-rose-500/80" />
                          … deleting …
                        </span>
                      </div>
                      <div className="flex w-full items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <span className="h-2 w-32 rounded bg-rose-500/10 animate-pulse" />
                        {dur != null && <span className="opacity-50">{formatDuration(dur)}</span>}
                      </div>
                    </div>
                  </li>
                )
              }
              return (
                <li key={r.runId}>
                  <button
                    type="button"
                    onClick={() => onSelectRun(r.runId)}
                    className="flex w-full flex-col items-start gap-1.5 px-4 py-3 text-left transition-colors duration-150"
                    style={{
                      borderBottom: '1px solid var(--border-default)',
                      background: isSelected ? 'var(--bg-elevated)' : 'transparent',
                      borderLeft: isSelected ? '2px solid var(--border-focus)' : '2px solid transparent',
                    }}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="shrink-0 text-xs" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{shortTime(r.startedAt)}</span>
                      <div className="flex items-center gap-1">
                        {compact ? (
                          <RunActionsKebab
                            run={r}
                            displayStatus={displayStatus}
                            open={openMenuRunId === r.runId}
                            onOpenToggle={(e) => {
                              e.stopPropagation()
                              setOpenMenuRunId((cur) => (cur === r.runId ? null : r.runId))
                            }}
                            onClose={() => setOpenMenuRunId(null)}
                            stoppingId={stoppingId}
                            pausingId={pausingId}
                            onStop={() => { setOpenMenuRunId(null); setPendingStop(r) }}
                            onPause={() => { setOpenMenuRunId(null); setPendingPause(r) }}
                          />
                        ) : (
                          <>
                            {canStop(r.status) && (
                              <ActionButton
                                label={stoppingId === r.runId ? 'Stopping' : 'Stop'}
                                icon={ICON_STOP}
                                disabled={stoppingId === r.runId}
                                variant="danger"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (stoppingId !== r.runId) setPendingStop(r)
                                }}
                              />
                            )}
                            {canPauseHeal(r.status) && (
                              <ActionButton
                                label={pausingId === r.runId ? 'Pausing' : 'Pause'}
                                icon={ICON_PAUSE}
                                disabled={pausingId === r.runId}
                                variant="warning"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (pausingId !== r.runId) setPendingPause(r)
                                }}
                              />
                            )}
                            {canCancelHeal(r.status) && (
                              <ActionButton
                                label={cancellingHealId === r.runId ? 'Cancelling' : 'Stop Heal'}
                                icon={ICON_STOP}
                                disabled={cancellingHealId === r.runId}
                                variant="danger"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (cancellingHealId !== r.runId) setPendingCancelHeal(r)
                                }}
                              />
                            )}
                            <span className="ml-1 inline-flex items-center">
                              <RunStatusIndicator status={displayStatus} />
                            </span>
                          </>
                        )}
                        {/* Delete is always rendered as an icon-only button
                            to the right of the status indicator, regardless
                            of compact mode. It's blocked (visible but
                            disabled) while the run is still running/healing
                            so the user understands the constraint instead
                            of wondering where the delete went. */}
                        <DeleteIconButton
                          disabled={!canDelete(r.status) || deletingId === r.runId}
                          disabledReason={
                            !canDelete(r.status)
                              ? 'Stop the run before deleting'
                              : 'Deleting…'
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            if (canDelete(r.status) && deletingId !== r.runId) setPendingDelete(r)
                          }}
                        />
                      </div>
                    </div>
                    <div className="flex w-full items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <span className="truncate" style={{ fontFamily: 'var(--font-mono)' }}>{r.runId}</span>
                      {dur != null && <span>{formatDuration(dur)}</span>}
                    </div>
                    {actionError && actionError.runId === r.runId && (
                      <div className="mt-1 w-full rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-700 dark:text-rose-300">
                        {actionError.message}
                      </div>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {pendingPause && (
        <ConfirmDialog
          title="Pause and start heal?"
          description={`Playwright will be terminated for run ${pendingPause.runId}. Pending tests are skipped, and the heal agent starts immediately on whatever has failed so far.`}
          confirmLabel="Pause & Heal"
          variant="warning"
          onCancel={() => setPendingPause(null)}
          onConfirm={confirmPause}
        />
      )}
      {pendingStop && (
        <ConfirmDialog
          title="Stop this run?"
          description={`This will abort all running processes for run ${pendingStop.runId}. Results collected so far are preserved.`}
          confirmLabel="Stop Run"
          variant="danger"
          onCancel={() => setPendingStop(null)}
          onConfirm={confirmStop}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete this run?"
          description={`Run ${pendingDelete.runId} and all its logs will be permanently removed from disk. This cannot be undone.`}
          confirmLabel="Delete Run"
          variant="danger"
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
      {pendingCancelHeal && (
        <ConfirmDialog
          title="Stop the heal cycle?"
          description={`The heal agent for ${pendingCancelHeal.runId} will be terminated. The run will be marked failed and a journal entry will record the cancellation.`}
          confirmLabel="Stop Heal"
          variant="danger"
          onCancel={() => setPendingCancelHeal(null)}
          onConfirm={confirmCancelHeal}
        />
      )}
    </div>
  )
}

// Returns viewport-relative coords for a popover anchored to the right edge
// of the given element. Recomputes on scroll/resize while the popover is
// open, so the menu stays attached as the user scrolls within column 3.
function useAnchoredPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const compute = (): void => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      // Right-align: align the popover's right edge with the anchor's right edge.
      let left = r.right - width
      if (left < 8) left = 8
      const maxLeft = window.innerWidth - width - 8
      if (left > maxLeft) left = maxLeft
      setPos({ top: r.bottom + 6, left })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open, anchorRef, width])
  return pos
}

function RunPopoverButton({
  feature,
  envs,
  selectedEnv,
  onSelectEnv,
  disabled,
  disabledReason,
  open,
  onToggle,
  onClose,
  onStartRun,
}: {
  feature: string | null
  envs: string[]
  selectedEnv: string
  onSelectEnv: (env: string) => void
  disabled: boolean
  disabledReason?: string
  open: boolean
  onToggle: () => void
  onClose: () => void
  onStartRun: () => void
}) {
  const POPOVER_WIDTH = 220
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pos = useAnchoredPosition(buttonRef, open, POPOVER_WIDTH)
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        disabled={!feature}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Run a test"
        title={disabled && disabledReason ? disabledReason : 'Run'}
        data-run-popover
        className="flex h-7 w-7 items-center justify-center rounded-md text-white transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: disabled ? 'var(--bg-elevated)' : 'rgb(5 150 105 / 0.85)' }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M5 3.2v9.6a.6.6 0 0 0 .92.508l7.2-4.8a.6.6 0 0 0 0-1.016l-7.2-4.8A.6.6 0 0 0 5 3.2z" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          role="menu"
          data-run-popover
          onClick={(e) => e.stopPropagation()}
          className="overflow-hidden rounded-lg p-3 text-xs shadow-xl"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: POPOVER_WIDTH,
            zIndex: 1000,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18), 0 2px 4px rgba(0, 0, 0, 0.08)',
          }}
        >
          {envs.length > 1 && (
            <div className="mb-2">
              <label className="mb-1 block text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Environment</label>
              <select
                value={selectedEnv}
                onChange={(e) => onSelectEnv(e.target.value)}
                className="w-full appearance-none rounded-md pl-2 pr-6 py-1.5 text-xs focus:outline-none"
                style={{
                  background: `var(--bg-elevated) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 6px center`,
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {envs.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={onStartRun}
            title={disabled ? disabledReason : undefined}
            className="w-full rounded-md bg-emerald-600/85 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Run Now
          </button>
          {disabled && disabledReason && (
            <p className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>{disabledReason}</p>
          )}
          <button type="button" onClick={onClose} className="sr-only">Close</button>
        </div>,
        document.body,
      )}
    </>
  )
}

function RunActionsKebab({
  run,
  displayStatus,
  open,
  onOpenToggle,
  onClose,
  stoppingId,
  pausingId,
  onStop,
  onPause,
}: {
  run: RunIndexEntry
  displayStatus: import('../api/types').DisplayStatus
  open: boolean
  onOpenToggle: (e: React.MouseEvent) => void
  onClose: () => void
  stoppingId: string | null
  pausingId: string | null
  onStop: () => void
  onPause: () => void
}) {
  const stopAvailable = canStop(run.status)
  const pauseAvailable = canPauseHeal(run.status)
  // NOTE: Delete is intentionally NOT in this menu; it's rendered as a
  // dedicated icon button next to the status indicator at all viewport
  // widths. Keeping it out of the kebab is what guarantees the user sees
  // Delete on the right of the status, regardless of compact mode.
  const hasActions = stopAvailable || pauseAvailable
  const POPOVER_WIDTH = 180
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pos = useAnchoredPosition(buttonRef, open && hasActions, POPOVER_WIDTH)
  return (
    <div className="shrink-0" data-run-menu>
      <div className="flex items-center gap-1.5">
        <RunStatusIndicator status={displayStatus} />
        {hasActions && (
          <button
            ref={buttonRef}
            type="button"
            onClick={onOpenToggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Run actions"
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150"
            style={{
              border: '1px solid var(--border-default)',
              background: open ? 'var(--bg-elevated)' : 'transparent',
              color: 'var(--text-secondary)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="8" r="1.4" />
              <circle cx="8" cy="8" r="1.4" />
              <circle cx="13" cy="8" r="1.4" />
            </svg>
          </button>
        )}
      </div>
      {open && hasActions && pos && createPortal(
        <div
          role="menu"
          data-run-menu
          onClick={(e) => e.stopPropagation()}
          className="overflow-hidden rounded-lg py-1 text-xs shadow-xl"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: POPOVER_WIDTH,
            zIndex: 1000,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18), 0 2px 4px rgba(0, 0, 0, 0.08)',
          }}
        >
          {stopAvailable && (
            <MenuItem
              label={stoppingId === run.runId ? 'Stopping...' : 'Stop'}
              variant="danger"
              disabled={stoppingId === run.runId}
              icon={(
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
              )}
              onClick={() => { onStop(); onClose() }}
            />
          )}
          {pauseAvailable && (
            <MenuItem
              label={pausingId === run.runId ? 'Pausing...' : 'Pause & Heal'}
              variant="warning"
              disabled={pausingId === run.runId}
              icon={(
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="3" height="10" rx="1" />
                  <rect x="10" y="3" width="3" height="10" rx="1" />
                </svg>
              )}
              onClick={() => { onPause(); onClose() }}
            />
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

function MenuItem({
  label,
  variant,
  disabled,
  icon,
  onClick,
}: {
  label: string
  variant: 'warning' | 'danger'
  disabled: boolean
  icon?: React.ReactNode
  onClick: () => void
}) {
  const color = variant === 'danger'
    ? 'text-rose-500 hover:bg-rose-500/8 dark:text-rose-400 dark:hover:bg-rose-500/10'
    : 'text-amber-600 hover:bg-amber-500/8 dark:text-amber-400 dark:hover:bg-amber-500/10'
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick() }}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left font-medium transition-colors duration-100 ${color} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span>{label}</span>
    </button>
  )
}

// Ghost icon-button. Stays calm at rest (no border, no fill); hover reveals
// a tinted fill so the affordance is clear. The leading icon disambiguates
// from the bare-text status indicator next to it.
//
// Rendered as `<span role="button">` because the parent row is itself a
// `<button>` and HTML disallows nesting.
function ActionButton({
  label,
  icon,
  disabled,
  variant,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  disabled: boolean
  variant: 'warning' | 'danger'
  onClick: (e: React.MouseEvent) => void
}) {
  const tone = variant === 'danger'
    ? 'text-rose-600/80 hover:bg-rose-500/12 hover:text-rose-600 dark:text-rose-400/80 dark:hover:text-rose-300'
    : 'text-amber-600/80 hover:bg-amber-500/15 hover:text-amber-700 dark:text-amber-400/80 dark:hover:text-amber-300'
  return (
    <span
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClick(e as unknown as React.MouseEvent) }
      }}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors duration-150 ${tone} ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
    >
      <span aria-hidden="true" className="inline-flex h-3 w-3 items-center justify-center">{icon}</span>
      {label}
    </span>
  )
}

// Icon-only ghost trash button. Square hover surface (16×16 visual / 20×20
// hit area) keeps the row dense; hover reveals a soft rose fill so the
// affordance is unmistakable. When `disabled`, it shows at low opacity with
// a tooltip explaining why — the user always sees that delete *exists*,
// just not whether it's currently available. Rendered as `<span role="button">`
// because the surrounding row is itself a `<button>`.
function DeleteIconButton({
  disabled,
  disabledReason,
  onClick,
}: {
  disabled: boolean
  disabledReason?: string
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={disabled ? (disabledReason ?? 'Delete unavailable') : 'Delete run'}
      title={disabled ? (disabledReason ?? 'Delete unavailable') : 'Delete run'}
      onClick={(e) => {
        if (disabled) { e.stopPropagation(); return }
        onClick(e)
      }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); e.stopPropagation()
          onClick(e as unknown as React.MouseEvent)
        }
      }}
      className={`ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors duration-150 ${
        disabled
          ? 'cursor-not-allowed text-zinc-400/50 dark:text-zinc-500/50'
          : 'cursor-pointer text-rose-600/70 hover:bg-rose-500/12 hover:text-rose-600 dark:text-rose-400/70 dark:hover:text-rose-300'
      }`}
    >
      <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
        <path d="M5.5 2h5l.5 1H14v1H2V3h3l.5-1zM3.5 5h9l-.7 8.2a1.5 1.5 0 0 1-1.5 1.3H5.7a1.5 1.5 0 0 1-1.5-1.3L3.5 5zm2.5 2v6h1V7H6zm3 0v6h1V7H9z" />
      </svg>
    </span>
  )
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  variant,
  onCancel,
  onConfirm,
}: {
  title: string
  description: string
  confirmLabel: string
  variant: 'warning' | 'danger'
  onCancel: () => void
  onConfirm: () => void
}) {
  const confirmColors = variant === 'danger'
    ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300'
    : 'border-amber-500/50 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300'
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-[420px] rounded-lg p-4 shadow-2xl" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}>
        <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{description}</p>
        <div className="mt-4 flex justify-end gap-2 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 transition-colors duration-150"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-md border px-3 py-1.5 transition-colors duration-150 ${confirmColors}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
