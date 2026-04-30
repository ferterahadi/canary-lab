import { useEffect, useRef, useState } from 'react'
import type { RunIndexEntry } from '../api/types'
import { statusBadgeClass, formatDuration, durationBetween, shortTime } from '../lib/format'
import { canPauseHeal } from '../lib/run-actions'
import { ApiError, pauseHealRun } from '../api/client'

interface Props {
  feature: string | null
  runs: RunIndexEntry[]
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
  onStartRun: () => void
}

// Column 2 — runs for the selected feature, newest first. The list refreshes
// upstream on a 5s timer so this component stays purely presentational.
export function RunsColumn({ feature, runs, selectedRunId, onSelectRun, onStartRun }: Props): JSX.Element {
  const [pendingPause, setPendingPause] = useState<RunIndexEntry | null>(null)
  const [pausingId, setPausingId] = useState<string | null>(null)
  const [pauseError, setPauseError] = useState<{ runId: string; message: string } | null>(null)
  const pauseErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (pauseErrorTimer.current) clearTimeout(pauseErrorTimer.current)
  }, [])

  const confirmPause = async (): Promise<void> => {
    if (!pendingPause) return
    const target = pendingPause
    setPendingPause(null)
    setPausingId(target.runId)
    try {
      await pauseHealRun(target.runId)
      setPauseError(null)
    } catch (err) {
      let message: string
      if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'reason' in err.body) {
        message = String((err.body as { reason: unknown }).reason)
      } else {
        message = err instanceof Error ? err.message : String(err)
      }
      setPauseError({ runId: target.runId, message })
      if (pauseErrorTimer.current) clearTimeout(pauseErrorTimer.current)
      pauseErrorTimer.current = setTimeout(() => {
        setPauseError((cur) => (cur && cur.runId === target.runId ? null : cur))
      }, 3000)
    } finally {
      setPausingId(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">
          {feature ? `Runs · ${feature}` : 'Runs'}
        </div>
        <button
          type="button"
          disabled={!feature}
          onClick={onStartRun}
          className="rounded bg-emerald-600/80 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          Run Now
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!feature ? (
          <div className="px-3 py-4 text-xs text-zinc-500">Select a feature.</div>
        ) : runs.length === 0 ? (
          <div className="px-3 py-4 text-xs text-zinc-500">No runs yet.</div>
        ) : (
          <ul>
            {runs.map((r) => {
              const dur = durationBetween(r.startedAt, r.endedAt)
              const isSelected = r.runId === selectedRunId
              return (
                <li key={r.runId}>
                  <button
                    type="button"
                    onClick={() => onSelectRun(r.runId)}
                    className={`flex w-full flex-col items-start gap-1 border-b border-zinc-900 px-3 py-2 text-left ${
                      isSelected ? 'bg-zinc-900' : 'hover:bg-zinc-900/50'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="font-mono text-xs text-zinc-400">{shortTime(r.startedAt)}</span>
                      <div className="flex items-center gap-1.5">
                        {canPauseHeal(r.status) && (
                          <span
                            role="button"
                            aria-disabled={pausingId === r.runId}
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (pausingId === r.runId) return
                              setPendingPause(r)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                e.stopPropagation()
                                if (pausingId !== r.runId) setPendingPause(r)
                              }
                            }}
                            className={`cursor-pointer rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200 hover:bg-amber-500/20 ${
                              pausingId === r.runId ? 'cursor-not-allowed opacity-50' : ''
                            }`}
                          >
                            {pausingId === r.runId ? 'Pausing…' : 'Pause & Heal'}
                          </span>
                        )}
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusBadgeClass(r.status)}`}
                        >
                          {r.status}
                        </span>
                      </div>
                    </div>
                    <div className="flex w-full items-center justify-between text-[11px] text-zinc-500">
                      <span className="truncate font-mono">{r.runId}</span>
                      {dur != null && <span>{formatDuration(dur)}</span>}
                    </div>
                    {pauseError && pauseError.runId === r.runId && (
                      <div className="mt-1 w-full rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-300">
                        {pauseError.message}
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
        <ConfirmPauseDialog
          run={pendingPause}
          onCancel={() => setPendingPause(null)}
          onConfirm={confirmPause}
        />
      )}
    </div>
  )
}

function ConfirmPauseDialog({
  run,
  onCancel,
  onConfirm,
}: {
  run: RunIndexEntry
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[420px] rounded border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
        <h2 className="text-sm font-medium text-zinc-100">Pause and start heal?</h2>
        <p className="mt-2 text-xs text-zinc-400">
          Playwright will be terminated for run <span className="font-mono">{run.runId}</span>. Pending tests are skipped, and the heal agent starts immediately on whatever has failed so far.
        </p>
        <div className="mt-4 flex justify-end gap-2 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-amber-200 hover:bg-amber-500/20"
          >
            Pause & Heal
          </button>
        </div>
      </div>
    </div>
  )
}
