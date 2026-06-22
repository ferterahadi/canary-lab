import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as api from '../../../shared/api/client'
import { ApiError } from '../../../shared/api/client'
import type { ExecutionType, RunIndexEntry } from '../../../shared/api/types'
import { formatDuration, durationBetween, shortTime } from '../../../shared/lib/format'
import { deriveRunViewModel, type RunViewModel } from '../utils/run-view-model'
import { useMcpPromo } from '../../../shared/shell/McpPromoContext'
import { useRuns } from '../state/RunsContext'
import { RunStatusIndicator } from './RunStatusIndicator'
import { VerificationDialog } from '../../coverage/components/VerificationDialog'

interface Props {
  feature: string | null
  envs?: string[]
  runs: RunIndexEntry[]
  selectedRunId: string | null
  onSelectRun: (runId: string | null) => void
  onStartRun: (env?: string, mode?: 'test' | 'boot') => void
  onStartVerification: (input: {
    configId?: string
    targetUrls?: Record<string, string>
    playwrightEnvsetId?: string
  }) => Promise<void>
  runDisabled?: boolean
  runDisabledReason?: string
  // R24: the Verify-config dialog is route-driven (`?dialog=verification`) when
  // these are supplied — controlled by App. Omitted (e.g. in unit tests) → the
  // column falls back to its own internal open-state.
  verifyOpen?: boolean
  onVerifyOpenChange?: (open: boolean) => void
}

// Inline SVG icons (no new dependency). Sizes are tuned to align with the
// 10 px text on the action buttons.
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

export function RunsColumn({ feature, envs = [], runs, selectedRunId, onSelectRun, onStartRun, onStartVerification, runDisabled, runDisabledReason, verifyOpen, onVerifyOpenChange }: Props) {
  const [pendingPause, setPendingPause] = useState<RunIndexEntry | null>(null)
  const [pendingStop, setPendingStop] = useState<RunIndexEntry | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RunIndexEntry | null>(null)
  const [pendingCancelHeal, setPendingCancelHeal] = useState<RunIndexEntry | null>(null)
  const [openMenuRunId, setOpenMenuRunId] = useState<string | null>(null)
  const [runPopoverOpen, setRunPopoverOpen] = useState(false)
  // Controlled when App drives it from the route; uncontrolled otherwise.
  const [verifyDialogOpenInternal, setVerifyDialogOpenInternal] = useState(false)
  const verifyDialogOpen = verifyOpen ?? verifyDialogOpenInternal
  const setVerifyDialogOpen = useCallback((open: boolean) => {
    if (onVerifyOpenChange) onVerifyOpenChange(open)
    else setVerifyDialogOpenInternal(open)
  }, [onVerifyOpenChange])
  const [compact, setCompact] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { gatePromo } = useMcpPromo()

  // Single source of truth for action state — transient flags + per-run
  // errors come from the WS-backed RunsContext, not local state. Action
  // dispatchers (abort/delete/etc.) handle the API call + error capture
  // internally, so the component just decides WHEN to call them.
  const { transients, errors, abort, delete: deleteAction, pauseHeal, cancelHeal, clearError } = useRuns()

  // Retest ("restart") doesn't live in RunsContext because it's fast and the
  // run flips to `running`/`healing` via the WS update almost immediately.
  // Tracked locally so the row icon can show a spinner + disable until the
  // POST returns.
  const [restartingIds, setRestartingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [restartErrors, setRestartErrors] = useState<Record<string, string>>({})
  const onRestartRequest = useCallback(async (runId: string): Promise<void> => {
    if (restartingIds.has(runId)) return
    setRestartingIds((prev) => {
      const next = new Set(prev)
      next.add(runId)
      return next
    })
    setRestartErrors((prev) => {
      if (!(runId in prev)) return prev
      const next = { ...prev }
      delete next[runId]
      return next
    })
    try {
      await api.restartRun(runId)
    } catch (e: unknown) {
      const reason = e instanceof ApiError
        ? (e.body as { reason?: unknown })?.reason
        : undefined
      const msg = typeof reason === 'string'
        ? `Retest failed: ${reason}`
        : e instanceof Error ? e.message : 'Retest failed'
      setRestartErrors((prev) => ({ ...prev, [runId]: msg }))
    } finally {
      setRestartingIds((prev) => {
        const next = new Set(prev)
        next.delete(runId)
        return next
      })
    }
  }, [restartingIds])
  const clearRestartError = useCallback((runId: string): void => {
    setRestartErrors((prev) => {
      if (!(runId in prev)) return prev
      const next = { ...prev }
      delete next[runId]
      return next
    })
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
      if (target && target.closest('[data-run-launch-menu]')) return
      setRunPopoverOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [runPopoverOpen])

  // Close the popover automatically when leaving compact mode.
  useEffect(() => {
    if (!compact) setRunPopoverOpen(false)
  }, [compact])

  // Confirm-dialog handlers. Action mechanics (transient flag, API call,
  // error capture) live in RunsContext — these just dispatch and clear
  // the dialog. The post-success "row vanishes" beat is handled by the WS
  // `removed` frame patching the store.
  const confirmPause = async (): Promise<void> => {
    if (!pendingPause) return
    const target = pendingPause
    setPendingPause(null)
    await pauseHeal(target.runId)
  }

  const confirmStop = async (): Promise<void> => {
    if (!pendingStop) return
    const target = pendingStop
    setPendingStop(null)
    await abort(target.runId)
  }

  const confirmCancelHeal = async (): Promise<void> => {
    if (!pendingCancelHeal) return
    const target = pendingCancelHeal
    setPendingCancelHeal(null)
    await cancelHeal(target.runId)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    // Clear selection eagerly so the right pane doesn't 404 against the
    // runId we're about to remove. Safe even on failure — the user can
    // re-select; the row stays in the list until the WS `removed` frame
    // arrives.
    if (selectedRunId === target.runId) {
      onSelectRun(runs.find((r) => r.runId !== target.runId)?.runId ?? null)
    }
    await deleteAction(target.runId)
  }

  return (
    <div ref={containerRef} className="cl-panel flex h-full flex-col">
      <div className="cl-panel-header flex items-center gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="cl-kicker shrink-0">Runs</span>
          {feature && runs.length > 0 && <span className="cl-count-chip">{runs.length}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* One launch control. Test / Boot / Verify all live in the Run menu;
              the standalone Verify button was folded in here. */}
          <RunLaunchControl
            feature={feature}
            envs={envs}
            compact={compact}
            open={runPopoverOpen}
            onToggle={() => setRunPopoverOpen((v) => !v)}
            onClose={() => setRunPopoverOpen(false)}
            runDisabled={Boolean(runDisabled)}
            disabledReason={runDisabledReason}
            onVerify={() => { setVerifyDialogOpen(true); setRunPopoverOpen(false) }}
            onStartEnv={(env, mode) => {
              gatePromo('run-test', () => {
                onStartRun(env || undefined, mode)
                setRunPopoverOpen(false)
              })
            }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!feature ? (
          <div className="px-4 py-6 text-xs" style={{ color: 'var(--text-muted)' }}>Select a feature.</div>
        ) : runs.length === 0 ? (
          <div className="px-4 py-6 text-xs" style={{ color: 'var(--text-muted)' }}>No runs yet for this feature.</div>
        ) : (
          <ul className="flex flex-col gap-1 px-2 py-2">
            {runs.map((r) => {
              const dur = durationBetween(r.startedAt, r.endedAt)
              const isSelected = r.runId === selectedRunId
              // Per-row transient + error sourced from the WS-backed
              // RunsContext — single source of truth across this column,
              // RunDetailColumn, and GlobalStatusBar. The badge overlay
              // ('ABORTING' / 'DELETING' / etc.) acknowledges the user's
              // click immediately, then resolves to the persisted status
              // when the server pushes the next `update` frame.
              const transient = transients[r.runId] ?? null
              const isDeleting = transient === 'deleting'
              const isStopping = transient === 'aborting'
              const isPausing = transient === 'pausing'
              const isCancellingHeal = transient === 'cancelling-heal'
              const isRestarting = restartingIds.has(r.runId)
              const rowError = errors[r.runId] ?? restartErrors[r.runId] ?? null
              const view = deriveRunViewModel(r, transient)
              const displayStatus = view.displayStatus
              const executionType = r.executionType ?? 'run'
              const typeLabel = executionType === 'verify' ? 'Verify' : 'Run'
              const verifySummary = executionType === 'verify'
                ? [
                    r.verificationConfigName,
                    r.verificationPlaywrightEnvsetId,
                  ].filter(Boolean).join(' · ')
                : null
              if (isDeleting) {
                return (
                  <li key={r.runId}>
                    <div
                      aria-busy="true"
                      aria-live="polite"
                      className="pointer-events-none flex w-full flex-col items-start gap-1.5 rounded-lg px-3 py-2.5 text-left"
                      style={{
                        background: 'var(--bg-hover)',
                        opacity: 0.6,
                      }}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="shrink-0"
                            style={{
                              color: 'var(--text-secondary)',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              letterSpacing: '0.02em',
                            }}
                          >
                            {shortTime(r.startedAt)}
                          </span>
                          <ExecutionTypeBadge type={executionType} />
                        </div>
                        <RunStatusIndicator status={displayStatus} executionType={executionType} />
                      </div>
                      <div
                        className="flex w-full min-w-0 items-center justify-between gap-2"
                        style={{
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10.5,
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{verifySummary || `${typeLabel} ${r.runId}`}</span>
                        {dur != null && <span className="shrink-0 opacity-60">{formatDuration(dur)}</span>}
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
                    className={`cl-list-row flex w-full flex-col items-start gap-1.5 px-3 py-2.5 text-left ${isSelected ? 'cl-list-row-selected' : ''}`}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="shrink-0"
                          style={{
                            color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12,
                            letterSpacing: '0.02em',
                          }}
                        >
                          {shortTime(r.startedAt)}
                        </span>
                        <ExecutionTypeBadge type={executionType} />
                      </div>
                      <div className="flex items-center gap-1">
                        {compact ? (
                          <RunActionsKebab
                            view={view}
                            displayStatus={displayStatus}
                            executionType={executionType}
                            open={openMenuRunId === r.runId}
                            onOpenToggle={(e) => {
                              e.stopPropagation()
                              setOpenMenuRunId((cur) => (cur === r.runId ? null : r.runId))
                            }}
                            onClose={() => setOpenMenuRunId(null)}
                            isStopping={isStopping}
                            isPausing={isPausing}
                            isCancellingHeal={isCancellingHeal}
                            onStop={() => { setOpenMenuRunId(null); setPendingStop(r) }}
                            onPause={() => { setOpenMenuRunId(null); setPendingPause(r) }}
                            onCancelHeal={() => { setOpenMenuRunId(null); setPendingCancelHeal(r) }}
                          />
                        ) : (
                          <>
                            {view.actions.stop.enabled && (
                              <ActionButton
                                label={isStopping ? 'Stopping' : 'Stop'}
                                icon={ICON_STOP}
                                disabled={isStopping}
                                variant="danger"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (!isStopping) setPendingStop(r)
                                }}
                              />
                            )}
                            {view.actions.pauseHeal.enabled && (
                              <ActionButton
                                label={isPausing ? 'Pausing' : 'Pause'}
                                icon={ICON_PAUSE}
                                disabled={isPausing}
                                variant="warning"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (!isPausing) setPendingPause(r)
                                }}
                              />
                            )}
                            {view.actions.cancelHeal.enabled && (
                              <ActionButton
                                label={isCancellingHeal ? 'Cancelling' : 'Stop Heal'}
                                icon={ICON_STOP}
                                disabled={isCancellingHeal}
                                variant="danger"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (!isCancellingHeal) setPendingCancelHeal(r)
                                }}
                              />
                            )}
                            <span className="ml-1 inline-flex items-center">
                              <RunStatusIndicator status={displayStatus} executionType={executionType} />
                            </span>
                          </>
                        )}
                        {/* Retest icon sits between the action cluster and
                            delete — only rendered when restart is available
                            (failed / aborted). Same visual weight as delete
                            but blue-tinted to read as "retry" vs "destroy".
                            Spins while the POST is in flight; the WS update
                            then flips the row to running/healing on its own. */}
                        {view.actions.restartHeal.enabled && (
                          <RetestIconButton
                            disabled={isRestarting}
                            spinning={isRestarting}
                            onClick={(e) => {
                              e.stopPropagation()
                              void onRestartRequest(r.runId)
                            }}
                          />
                        )}
                        {/* Delete is always rendered as an icon-only button
                            to the right of the status indicator, regardless
                            of compact mode. It's blocked (visible but
                            disabled) while the run is still running/healing
                            so the user understands the constraint instead
                            of wondering where the delete went. */}
                        <DeleteIconButton
                          disabled={!view.actions.delete.enabled || isDeleting}
                          disabledReason={
                            !view.actions.delete.enabled
                              ? view.actions.delete.reason ?? 'Stop the run before deleting'
                              : 'Deleting…'
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            if (view.actions.delete.enabled && !isDeleting) setPendingDelete(r)
                          }}
                        />
                      </div>
                    </div>
                    <div
                      className="flex w-full min-w-0 items-center justify-between gap-2"
                      style={{
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10.5,
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate" title={verifySummary || r.runId}>{verifySummary || r.runId}</span>
                      {dur != null && <span className="shrink-0">{formatDuration(dur)}</span>}
                    </div>
                    {rowError && (
                      <div
                        className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-700 dark:text-rose-300"
                        role="alert"
                      >
                        <span className="truncate">{rowError}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); clearError(r.runId); clearRestartError(r.runId) }}
                          aria-label="Dismiss error"
                          className="shrink-0 rounded px-1 text-[10px] uppercase tracking-wide opacity-70 hover:opacity-100"
                        >
                          dismiss
                        </button>
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
        pendingStop.executionType === 'boot' ? (
          <ConfirmDialog
            title="Stop these services?"
            description={`This stops all services for boot session ${pendingStop.runId} and reverts the envset. No test results are affected.`}
            confirmLabel="Stop Services"
            variant="danger"
            onCancel={() => setPendingStop(null)}
            onConfirm={confirmStop}
          />
        ) : (
          <ConfirmDialog
            title="Stop this run?"
            description={`This will abort all running processes for run ${pendingStop.runId}. Results collected so far are preserved.`}
            confirmLabel="Stop Run"
            variant="danger"
            onCancel={() => setPendingStop(null)}
            onConfirm={confirmStop}
          />
        )
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
      {verifyDialogOpen && feature && (
        <VerificationDialog
          feature={feature}
          envs={envs}
          disabled={runDisabled}
          disabledReason={runDisabledReason}
          onClose={() => setVerifyDialogOpen(false)}
          onStart={onStartVerification}
        />
      )}
    </div>
  )
}

function RunLaunchControl({
  feature,
  envs,
  compact = false,
  open,
  onToggle,
  onClose,
  runDisabled,
  disabledReason,
  onStartEnv,
  onVerify,
}: {
  feature: string | null
  envs: string[]
  compact?: boolean
  open: boolean
  onToggle: () => void
  onClose: () => void
  runDisabled: boolean
  disabledReason?: string
  onStartEnv: (env: string, mode: 'test' | 'boot') => void
  onVerify: () => void
}) {
  const POPOVER_WIDTH = 214
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pos = useAnchoredPosition(buttonRef, open, POPOVER_WIDTH)
  const title = runDisabled && disabledReason ? disabledReason : 'Run'
  // One launch control, three modes. Test/Boot pick an envset inline; Verify
  // opens its own config dialog. `mode` is sticky within the session. Test runs
  // the suite; Boot holds services (lands in the Services pill, not Runs).
  const [mode, setMode] = useState<'test' | 'boot' | 'verify'>('test')
  const launchMode: 'test' | 'boot' = mode === 'boot' ? 'boot' : 'test'
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={!feature}
        title={title}
        onClick={() => { if (feature) onToggle() }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? 'Run' : undefined}
        data-run-launch-menu
        className={`cl-run-menu-button ${compact ? 'cl-run-menu-button-compact' : ''} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M5 3.2v9.6a.6.6 0 0 0 .92.508l7.2-4.8a.6.6 0 0 0 0-1.016l-7.2-4.8A.6.6 0 0 0 5 3.2z" />
        </svg>
        {!compact && <span>Run</span>}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          role="menu"
          data-run-launch-menu
          data-mode={mode}
          onClick={(e) => e.stopPropagation()}
          className="cl-popover cl-run-launch-menu p-1.5 text-xs"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH, zIndex: 1000 }}
        >
          <div className="cl-mode-toggle" role="group" aria-label="Run mode">
            <button type="button" data-active={mode === 'boot'} data-mode="boot" onClick={() => setMode('boot')} className="cl-mode-toggle-btn">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="2.5" width="12" height="4" rx="1" />
                <rect x="2" y="9.5" width="12" height="4" rx="1" />
                <path d="M4.5 4.5h.01M4.5 11.5h.01" />
              </svg>
              Boot
            </button>
            <button type="button" data-active={mode === 'test'} onClick={() => setMode('test')} className="cl-mode-toggle-btn">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M5 3.2v9.6a.6.6 0 0 0 .92.508l7.2-4.8a.6.6 0 0 0 0-1.016l-7.2-4.8A.6.6 0 0 0 5 3.2z" />
              </svg>
              Test
            </button>
            <button type="button" data-active={mode === 'verify'} data-mode="verify" onClick={() => setMode('verify')} className="cl-mode-toggle-btn">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 8.5 6.2 12 13 4" />
              </svg>
              Verify
            </button>
          </div>

          {mode === 'verify' ? (
            <>
              <p className="px-2 pb-1.5 pt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                Check a deployment against target URLs — observational, no services booted.
              </p>
              <button
                type="button"
                role="menuitem"
                disabled={runDisabled}
                onClick={() => { if (!runDisabled) onVerify() }}
                className="cl-run-env-option disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="min-w-0 flex-1">Set up &amp; run verify →</span>
              </button>
            </>
          ) : (
            <>
              {mode === 'boot' && (
                <p className="px-2 pb-1.5 pt-0.5 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                  Boots services and holds them — no tests. Manage &amp; stop from the Services pill.
                </p>
              )}
              {mode === 'test' && (
                <p className="px-2 pb-1.5 pt-0.5 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                  Boots services and runs the feature&apos;s tests — tears them down when done.
                </p>
              )}
              {envs.length > 0 ? (
                <>
                  <div className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    {mode === 'boot' ? 'Boot which envset' : 'Choose envset'}
                  </div>
                  {envs.map((env) => (
                    <button
                      key={env}
                      type="button"
                      role="menuitem"
                      disabled={runDisabled}
                      onClick={() => { if (!runDisabled) onStartEnv(env, launchMode) }}
                      className="cl-run-env-option disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <span className="cl-run-env-option-dot" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate" style={{ fontFamily: 'var(--font-mono)' }}>{env}</span>
                    </button>
                  ))}
                </>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={runDisabled}
                  onClick={() => { if (!runDisabled) onStartEnv('', launchMode) }}
                  className="cl-run-env-option disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="cl-run-env-option-dot" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{mode === 'boot' ? 'Boot services' : 'Run tests'}</span>
                </button>
              )}
            </>
          )}

          {runDisabled && disabledReason && (
            <p className="mx-2 mt-1 border-t pt-2 text-[10px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
              {disabledReason}
            </p>
          )}
          <button type="button" onClick={onClose} className="sr-only">Close</button>
        </div>,
        document.body,
      )}
    </>
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

function RunActionsKebab({
  view,
  displayStatus,
  executionType,
  open,
  onOpenToggle,
  onClose,
  isStopping,
  isPausing,
  isCancellingHeal,
  onStop,
  onPause,
  onCancelHeal,
}: {
  view: RunViewModel
  displayStatus: import('../../../shared/api/types').DisplayStatus
  executionType?: import('../../../shared/api/types').ExecutionType
  open: boolean
  onOpenToggle: (e: React.MouseEvent) => void
  onClose: () => void
  isStopping: boolean
  isPausing: boolean
  isCancellingHeal: boolean
  onStop: () => void
  onPause: () => void
  onCancelHeal: () => void
}) {
  const stopAvailable = view.actions.stop.enabled
  const pauseAvailable = view.actions.pauseHeal.enabled
  const cancelHealAvailable = view.actions.cancelHeal.enabled
  // NOTE: Delete is intentionally NOT in this menu; it's rendered as a
  // dedicated icon button next to the status indicator at all viewport
  // widths. Keeping it out of the kebab is what guarantees the user sees
  // Delete on the right of the status, regardless of compact mode.
  const hasActions = stopAvailable || pauseAvailable || cancelHealAvailable
  const POPOVER_WIDTH = 180
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pos = useAnchoredPosition(buttonRef, open && hasActions, POPOVER_WIDTH)
  return (
    <div className="shrink-0" data-run-menu>
      <div className="flex items-center gap-1.5">
        <RunStatusIndicator status={displayStatus} executionType={executionType} />
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
          className="cl-popover overflow-hidden rounded-lg py-1 text-xs"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: POPOVER_WIDTH,
            zIndex: 1000,
          }}
        >
          {stopAvailable && (
            <MenuItem
              label={isStopping ? 'Stopping...' : 'Stop'}
              variant="danger"
              disabled={isStopping}
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
              label={isPausing ? 'Pausing...' : 'Pause & Heal'}
              variant="warning"
              disabled={isPausing}
              icon={(
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="3" height="10" rx="1" />
                  <rect x="10" y="3" width="3" height="10" rx="1" />
                </svg>
              )}
              onClick={() => { onPause(); onClose() }}
            />
          )}
          {cancelHealAvailable && (
            <MenuItem
              label={isCancellingHeal ? 'Cancelling...' : 'Stop Heal'}
              variant="danger"
              disabled={isCancellingHeal}
              icon={(
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
              )}
              onClick={() => { onCancelHeal(); onClose() }}
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

function ExecutionTypeBadge({ type }: { type: ExecutionType }) {
  const style = type === 'verify'
    ? { background: 'rgba(14, 165, 233, 0.12)', color: 'var(--accent)' }
    : type === 'boot'
      ? { background: 'var(--boot-soft)', color: 'var(--boot)' }
      : type === 'benchmark'
        ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }
        : { background: 'var(--bg-selected)', color: 'var(--text-muted)' }
  const label = type === 'verify' ? 'Verify' : type === 'boot' ? 'Boot' : type === 'benchmark' ? 'Arm' : 'Run'
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
      style={{ ...style, letterSpacing: '0.04em' }}
    >
      {label}
    </span>
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
// Sibling of DeleteIconButton — same 20×20 ghost-button silhouette, same
// 11px SVG, but blue-tinted to read as "retry" instead of "destroy". Only
// rendered when restart is available (terminal failed/aborted), so its mere
// presence is the affordance — no "Retest" label needed in the row body.
// While spinning, the icon rotates and the button is disabled to swallow
// double-clicks; the WS update flips the row's status badge to running/
// healing within a beat or two, which removes the icon entirely.
function RetestIconButton({
  disabled,
  spinning,
  onClick,
}: {
  disabled: boolean
  spinning: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  const label = spinning
    ? 'Retesting remaining tests…'
    : 'Retest remaining: reruns failed, skipped, and pending tests'
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={label}
      title={label}
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
      className={`inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors duration-150 ${
        spinning
          ? 'cursor-wait text-blue-500/70 dark:text-blue-300/70'
          : 'cursor-pointer text-blue-600/70 hover:bg-blue-500/12 hover:text-blue-600 dark:text-blue-400/70 dark:hover:text-blue-300'
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={spinning ? 'animate-spin' : ''}
      >
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
        <path d="M13.5 2v3.5H10" />
      </svg>
    </span>
  )
}

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
  const isDanger = variant === 'danger'
  const confirmStyle: React.CSSProperties = isDanger
    ? { background: 'var(--danger)', borderColor: 'var(--danger)' }
    : { background: 'var(--warning)', borderColor: 'var(--warning)' }
  return (
    <div className="cl-modal-backdrop absolute inset-0 z-50 flex items-center justify-center p-6">
      <div className="cl-modal w-[440px] p-5">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        <p
          className="mt-1.5 text-[13px] leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}
        >
          {description}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="cl-button px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="cl-button-primary px-3 py-1.5"
            style={confirmStyle}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
