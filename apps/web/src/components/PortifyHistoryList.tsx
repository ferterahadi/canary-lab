import { useState } from 'react'
import * as api from '../api/client'
import { usePortify } from '../state/PortifyContext'
import type { PortifyIndexEntry, PortifyStatus } from '../api/client'
import { CopyButton } from './CopyButton'

// Inline Portify history, embedded in the feature config Ports tab. Lists every
// port-ification workflow (all features), most-recent first, so a committed
// workflow's branch stays findable after its window is closed — right where you
// launch Portify. Clicking a row reopens it in the wizard (committed rows land
// on the screen with the branch + `git merge` command).

const STATUS_META: Record<PortifyStatus, { label: string; color: string; pulse?: boolean }> = {
  planning: { label: 'planning', color: 'var(--accent)', pulse: true },
  editing: { label: 'editing', color: 'var(--accent)', pulse: true },
  verifying: { label: 'verifying', color: 'var(--accent)', pulse: true },
  'ready-to-commit': { label: 'ready', color: 'rgb(52,211,153)' },
  committed: { label: 'committed', color: 'rgb(52,211,153)' },
  failed: { label: 'failed', color: 'rgb(251,113,133)' },
  aborted: { label: 'cancelled', color: 'var(--text-muted)' },
}

export function PortifyHistoryList({ onOpenPortify }: { onOpenPortify?: (workflowId: string) => void }) {
  const { workflows } = usePortify()
  const sorted = [...workflows].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))

  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        Portify history
      </div>
      {sorted.length === 0 ? (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          No Portify runs yet. Run Portify above; committed runs show here with the branch to merge.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {sorted.map((w) => (
            <PortifyRow key={w.workflowId} entry={w} onOpen={onOpenPortify} />
          ))}
        </ul>
      )}
    </div>
  )
}

const TERMINAL: PortifyStatus[] = ['committed', 'failed', 'aborted']

function PortifyRow({ entry, onOpen }: { entry: PortifyIndexEntry; onOpen?: (workflowId: string) => void }) {
  const meta = STATUS_META[entry.status]
  const showBranch = Boolean(entry.branch) && (entry.status === 'committed' || entry.status === 'ready-to-commit')
  const removable = TERMINAL.includes(entry.status)
  const open = (): void => onOpen?.(entry.workflowId)
  return (
    <li>
      {/* A clickable div (not a button) so the Copy button can nest validly. */}
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
        className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors hover:bg-white/[0.03]"
        style={{ border: '1px solid var(--border-default)' }}
        title={`Open Portify run for ${entry.feature}`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full${meta.pulse ? ' animate-pulse' : ''}`}
          style={{ background: meta.color, boxShadow: meta.pulse ? `0 0 10px color-mix(in srgb, ${meta.color} 60%, transparent)` : undefined }}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12px]" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
            {entry.feature}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: meta.color }}>{meta.label}</span>
            <span aria-hidden="true">·</span>
            <span>{shortTime(entry.endedAt ?? entry.startedAt)}</span>
            {showBranch && (
              <>
                <span aria-hidden="true">·</span>
                <code className="truncate" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{entry.branch}</code>
              </>
            )}
          </span>
        </span>
        {showBranch && entry.branch && (
          <span onClick={(e) => e.stopPropagation()} className="shrink-0">
            <CopyButton value={`git merge ${entry.branch}`} label="Copy merge" title={`Copy: git merge ${entry.branch}`} />
          </span>
        )}
        {removable && <RemoveButton entry={entry} />}
      </div>
    </li>
  )
}

// Hover-revealed × to drop a finished run from history. Stops propagation so it
// doesn't open the run; the WS `removed` push prunes the row on success.
function RemoveButton({ entry }: { entry: PortifyIndexEntry }) {
  const [busy, setBusy] = useState(false)
  const remove = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try { await api.removePortify(entry.workflowId) } catch { setBusy(false) }
    // On success the row unmounts via the WS removal; no need to reset state.
  }
  return (
    <button
      type="button"
      onClick={remove}
      disabled={busy}
      aria-label={`Remove ${entry.feature} from history`}
      title={entry.status === 'committed' ? 'Remove from history (keeps the committed branch)' : 'Remove from history'}
      className="shrink-0 rounded px-1.5 py-0.5 text-[12px] leading-none opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100 hover:bg-white/[0.06]"
      style={{ color: 'var(--text-muted)' }}
    >
      ✕
    </button>
  )
}

function shortTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
