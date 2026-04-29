import type { RunIndexEntry } from '../api/types'
import { statusBadgeClass, formatDuration, durationBetween, shortTime } from '../lib/format'

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
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusBadgeClass(r.status)}`}
                      >
                        {r.status}
                      </span>
                    </div>
                    <div className="flex w-full items-center justify-between text-[11px] text-zinc-500">
                      <span className="truncate font-mono">{r.runId}</span>
                      {dur != null && <span>{formatDuration(dur)}</span>}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
