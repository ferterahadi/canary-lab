import { useState } from 'react'
import type { RunDetail, RunIndexEntry } from '@/shared/api/types'
import { useActiveBootSessions, useRun, useRuns } from '../state/RunsContext'
import { ConfirmModal, Modal, StatusDot } from '@/shared/ui/atoms'
import { RunDetailColumn } from './RunDetailColumn'

interface Props {
  onClose: () => void
}

// Global, self-contained home for boot-only sessions. Master-detail: the left
// rail lists held sessions; the right pane reuses RunDetailColumn to show the
// selected session's full detail (Overview / Run Logs / per-service Services
// logs). Boot never appears in the Runs list or column 3 — everything boot
// lives here, decoupled from runs.
export function ServicesDialog({ onClose }: Props) {
  const { sessions } = useActiveBootSessions()
  const { abort } = useRuns()
  const [picked, setPicked] = useState<string | null>(null)
  const [stopIds, setStopIds] = useState<string[] | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)

  // Default to the first session; fall back automatically when the picked one
  // is stopped (and leaves the active list).
  const selectedId = picked && sessions.some((s) => s.runId === picked)
    ? picked
    : sessions[0]?.runId ?? null

  const stop = async (): Promise<void> => {
    if (!stopIds) return
    setStopping(true)
    setStopError(null)
    try {
      await Promise.all(stopIds.map((id) => abort(id)))
      setStopIds(null)
    } catch (error) {
      setStopError(error instanceof Error ? error.message : 'Could not stop services')
    } finally { setStopping(false) }
  }
  const requestStop = (ids: string[]): void => { setStopError(null); setStopIds(ids) }

  return (
    <>
    <Modal
      open
      portal
      onClose={onClose}
      title="Services"
      description="Apps booted for manual testing · no Playwright"
      ariaLabel="Services"
      width={1000}
      height={600}
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      footer={<div className="flex w-full flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-secondary">Closing keeps services running. Stop tears down the session and reverts its environment.</p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {sessions.length > 1 && <button className="px-2 py-1.5 text-xs text-danger" onClick={() => requestStop(sessions.map((session) => session.runId))}>Stop all &amp; revert</button>}
          {selectedId && <button className="cl-button px-3 py-1.5 text-xs text-danger" onClick={() => requestStop([selectedId])}>Stop session &amp; revert</button>}
          <button className="cl-button px-3 py-1.5 text-xs" onClick={onClose}>Done</button>
        </div>
      </div>}
    >
      {sessions.length === 0 ? (
        <div className="px-3 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
          No services booted. Use a suite&apos;s <span style={{ color: 'var(--boot)' }}>Run ▸ Boot</span> to bring an app up.
        </div>
      ) : (
        <div className="cl-dialog-panes min-h-0 flex-1">
          {/* Left rail: session list */}
          <aside
            className="cl-dialog-rail overflow-auto p-2 scrollbar-thin"
            style={{ borderColor: 'var(--border-default)' }}
          >
            <ul className="flex flex-col gap-1">
              {sessions.map((s) => (
                <li key={s.runId}>
                  <SessionRailRow
                    session={s}
                    selected={s.runId === selectedId}
                    onSelect={() => setPicked(s.runId)}
                  />
                </li>
              ))}
            </ul>
          </aside>

          {/* Right pane: the full rich detail for the selected session. */}
          <div className="min-h-0 min-w-0 overflow-hidden">
            {selectedId ? <RunDetailColumn key={selectedId} runId={selectedId} /> : null}
          </div>
        </div>
      )}
    </Modal>
    <ConfirmModal
      open={stopIds !== null}
      portal
      title={stopIds?.length === 1 ? `Stop ${sessions.find((session) => session.runId === stopIds[0])?.feature ?? 'session'}?` : 'Stop all services?'}
      message={<><p>This stops the selected apps and reverts their session environments. You can boot them again later.</p>{stopError && <p role="alert" className="mt-2 text-danger">{stopError}</p>}</>}
      confirmLabel="Stop & revert"
      cancelLabel="Keep running"
      variant="danger"
      busy={stopping}
      onConfirm={() => { void stop() }}
      onCancel={() => { if (!stopping) setStopIds(null) }}
    />
    </>
  )
}

function sessionLabel(detail: RunDetail | undefined, status: string, stopping: boolean): string {
  if (stopping) return 'stopping…'
  if (status === 'queued') return 'queued'
  if (detail?.manifest.lifecycle?.phase === 'services-ready') return 'services up'
  return 'booting…'
}

function SessionRailRow({
  session,
  selected,
  onSelect,
}: {
  session: RunIndexEntry
  selected: boolean
  onSelect: () => void
}) {
  // useRun loads + reads this session's detail (lifecycle phase, transient).
  const { detail, status, transient } = useRun(session.runId)
  const stopping = transient === 'aborting'
  const label = sessionLabel(detail, status ?? session.status, stopping)
  const booting = label !== 'services up'

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="w-full cursor-pointer rounded-md px-2.5 py-2 text-left transition-colors"
      style={{ background: selected ? 'var(--bg-selected)' : 'transparent' }}
    >
      <div className="flex items-center gap-2">
        <StatusDot state="booted" pulse={booting} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{session.feature}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
          style={{ background: 'var(--boot-soft)', color: 'var(--boot)' }}
        >
          {label}
        </span>

      </div>
    </button>
  )
}
