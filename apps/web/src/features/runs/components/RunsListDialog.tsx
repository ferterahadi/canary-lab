import { useState } from 'react'
import type { RunIndexEntry, RunStatus } from '../../../shared/api/types'
import { ChevronRightIcon, SlideOverPanel } from '../../config/components/atoms'
import { useRunDetails, useRuns } from '../state/RunsContext'
import { RunRow } from './RunRow'

interface Props {
  onClose: () => void
  onNavigateToRun: (feature: string, runId: string) => void
}

// Grouped view of every run across all features. With concurrency several can
// be active at once, so this is the single place to see them and jump into any
// one. Chrome mirrors the EvaluationExportTaskToast / WizardTaskStatus dialogs
// (right-anchored panel, bordered + shadowed surface, "Close" text button,
// leading status dot + pill chip) so the three run/task dialogs read as one
// family. Active runs (running / healing / queued) stay expanded; the long
// tail of finished runs collapses behind a disclosure so the active work is
// always what you see first.
const ACTIVE_GROUPS: Array<{ key: string; label: string; statuses: RunStatus[] }> = [
  { key: 'running', label: 'Running', statuses: ['running'] },
  { key: 'healing', label: 'Healing', statuses: ['healing'] },
  { key: 'queued', label: 'Queued', statuses: ['queued'] },
]
const FINISHED_STATUSES: RunStatus[] = ['passed', 'failed', 'aborted']

export function RunsListDialog({ onClose, onNavigateToRun }: Props) {
  const { runs: allRuns } = useRuns()
  // Boot sessions live in the Services dialog; benchmark runs (arms + the
  // validity-gate trial) live in the benchmark window — neither belongs here.
  const runs = allRuns.filter((r) => r.executionType !== 'boot' && r.executionType !== 'benchmark')
  const details = useRunDetails()
  // Finished runs are the long tail — collapsed by default so active work leads.
  const [finishedOpen, setFinishedOpen] = useState(false)

  const navigate = (r: RunIndexEntry): void => { onNavigateToRun(r.feature, r.runId); onClose() }
  const finishedRuns = runs.filter((r) => FINISHED_STATUSES.includes(r.status))
  const hasActive = ACTIVE_GROUPS.some((g) => runs.some((r) => g.statuses.includes(r.status)))

  return (
    <SlideOverPanel
      onClose={onClose}
      ariaLabel="All runs"
      header={
        <>
          <h2 className="min-w-0 flex-1 text-sm font-semibold">Runs</h2>
          <button
            type="button"
            aria-label="Close runs"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs"
            style={{ color: 'var(--text-secondary)' }}
          >
            Close
          </button>
        </>
      }
    >
        <div className="min-h-0 flex-1 overflow-auto p-2 scrollbar-thin">
          {runs.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              No runs yet.
            </div>
          ) : (
            <>
              {ACTIVE_GROUPS.map((group) => {
                const groupRuns = runs.filter((r) => group.statuses.includes(r.status))
                if (groupRuns.length === 0) return null
                return (
                  <section key={group.key} className="mb-2">
                    <div
                      className="px-2 py-1 text-[10px] uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {group.label} · {groupRuns.length}
                    </div>
                    <ul className="flex flex-col gap-1">
                      {groupRuns.map((r) => (
                        <RunRow key={r.runId} run={r} detail={details[r.runId]} onSelect={navigate} />
                      ))}
                    </ul>
                  </section>
                )
              })}

              {finishedRuns.length > 0 && (
                <section className={hasActive ? 'mt-1' : ''}>
                  <button
                    type="button"
                    onClick={() => setFinishedOpen((v) => !v)}
                    aria-expanded={finishedOpen}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider transition-colors hover:bg-white/[0.03]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex transition-transform duration-150"
                      style={{ transform: finishedOpen ? 'rotate(90deg)' : 'none' }}
                    >
                      <ChevronRightIcon />
                    </span>
                    <span>Finished · {finishedRuns.length}</span>
                  </button>
                  {finishedOpen && (
                    <ul className="mt-1 flex flex-col gap-1">
                      {finishedRuns.map((r) => (
                        <RunRow key={r.runId} run={r} detail={details[r.runId]} onSelect={navigate} />
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>
    </SlideOverPanel>
  )
}
