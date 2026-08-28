import * as api from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import { formatDuration, durationBetween, shortTime } from '@/shared/lib/format'
import { deriveRunViewModel } from '../utils/run-view-model'
import { useRunsColumn } from './use-runs-column'
import { RunStatusIndicator } from './RunStatusIndicator'
import { VerificationDialog } from '@/features/coverage'
import { ActionButton, ConfirmDialog, DeleteIconButton, ExecutionTypeBadge, RetestIconButton, RunActionsKebab } from './RunActionsKebab'
import { ICON_PAUSE, ICON_STOP, RunLaunchControl } from './RunLaunchControl'

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
  // The shipped demo suite, when this workspace still has it. Pressing Run on it
  // skips the MCP promo: that click IS the product's demonstration — fail →
  // repair → green — and a video about driving Canary from an agent interrupts
  // exactly the moment it is meant to sell. Every other suite still sees the
  // promo once, and the demo suite's other promos (export, new flight) are
  // untouched.
  sampleSuite?: string | null
}

// stop fitting on a single line, so we collapse them into a kebab menu that
// pops over with the same options.
export function RunsColumn({ feature, envs = [], runs, selectedRunId, onSelectRun, onStartRun, onStartVerification, runDisabled, runDisabledReason, verifyOpen, onVerifyOpenChange, sampleSuite }: Props) {  const {
    verificationRefreshKey,
    pendingPause,
    setPendingPause,
    pendingStop,
    setPendingStop,
    pendingDelete,
    setPendingDelete,
    pendingCancelHeal,
    setPendingCancelHeal,
    openMenuRunId,
    setOpenMenuRunId,
    runPopoverOpen,
    setRunPopoverOpen,
    verifyDialogOpen,
    setVerifyDialogOpen,
    compact,
    containerRef,
    gatePromo,
    transients,
    errors,
    abort,
    pauseHeal,
    cancelHeal,
    clearError,
    restartingIds,
    restartErrors,
    onRestartRequest,
    clearRestartError,
    confirmPause,
    confirmStop,
    confirmCancelHeal,
    confirmDelete,
  } = useRunsColumn({ runs, selectedRunId, onSelectRun, verifyOpen, onVerifyOpenChange })

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
              const start = () => {
                onStartRun(env || undefined, mode)
                setRunPopoverOpen(false)
              }
              if (sampleSuite && feature === sampleSuite) start()
              else gatePromo('run-test', start)
            }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!feature ? (
          <div className="px-4 py-6 text-xs" style={{ color: 'var(--text-muted)' }}>Select a suite.</div>
        ) : runs.length === 0 ? (
          <div className="px-4 py-6 text-xs" style={{ color: 'var(--text-muted)' }}>No runs yet for this suite.</div>
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
                        className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger"
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
          refreshKey={verificationRefreshKey}
        />
      )}
    </div>
  )
}
