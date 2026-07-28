import { useState, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type { PlanFeaturesTask, PlannedFeature } from '@/shared/api/client'
import { AgentSessionView } from '@/shared/ui/AgentSessionView'
import { Textarea } from '@/shared/ui/atoms'
import { OPTION_ROW_CLASS, optionRowStyle } from '@/shared/ui/OptionRow'

/** R54: the breakdown agent owns the dialog while it thinks — its timeline is
 *  the content. Closing (the modal's ✕) doesn't stop the agent: the plan runs
 *  on server-side and stays in the Flights pill as a pre-flight row, so there's
 *  no footer "close" button duplicating the ✕. The single-flight escape hatch
 *  appears ONLY when planning fails — there it's the way forward, not an
 *  invitation to bail on a good default that's seconds from settling. */
export function PlanningView({
  task,
  busy,
  error,
  onSkip,
}: {
  task: PlanFeaturesTask | null
  busy: boolean
  error: ReactNode
  onSkip: () => void
}) {
  const failed = task?.status === 'failed'
  return (
    <div className="flex flex-col gap-2.5" data-testid="flight-plan-view">
      <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {failed
          ? 'Planning failed — you can still start one flight for the whole intent.'
          : 'Judging whether this intent is one feature or several…'}
      </div>
      {failed && task?.error && (
        <div data-testid="flight-plan-error" className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}>
          {task.error}
        </div>
      )}
      {task && !failed && (
        <div className="flex min-h-[260px] flex-col rounded border" style={{ borderColor: 'var(--border-default)' }}>
          <AgentSessionView source={{ kind: 'flight-plan', taskId: task.taskId, live: task.status === 'running' }} />
        </div>
      )}
      {error}
      {failed ? (
        <div className="flex items-center justify-end">
          <button
            type="button"
            data-testid="flight-plan-skip"
            disabled={busy}
            onClick={onSkip}
            className="cl-button px-2.5 py-1 text-xs"
            style={{ color: 'var(--accent)' }}
          >
            {busy ? 'Starting…' : 'Start a single flight'}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[11px]" data-testid="flight-plan-background-hint" style={{ color: 'var(--text-muted)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4Z" />
          </svg>
          Close anytime — planning keeps running and waits for you in the Flights pill.
        </div>
      )}
    </div>
  )
}

/** R54: the proposal step — the agent's split as editable cards, the token
 *  cost stated plainly, nothing launches until the user confirms. */
export function ProposalView({
  proposal,
  conflicts,
  sharedGroup,
  busy,
  error,
  onChange,
  onGroupChange,
  onConfirm,
  onCancel,
}: {
  proposal: PlannedFeature[]
  conflicts: string[]
  sharedGroup: string
  busy: boolean
  error: ReactNode
  onChange: (features: PlannedFeature[]) => void
  onGroupChange: (group: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const patch = (i: number, part: Partial<PlannedFeature>): void => {
    onChange(proposal.map((f, idx) => (idx === i ? { ...f, ...part } : f)))
  }
  const n = proposal.length
  // R69 follow-up: cards are read-first so all N features scan at a glance;
  // the pencil flips one card into its editable fields. A conflicted card is
  // forced open — you must rename it before anything launches. Opening an edit
  // snapshots the card so Cancel can revert the live edits (patch writes
  // straight into `proposal` as the user types).
  const [editing, setEditing] = useState<Set<number>>(() => new Set())
  const [snapshots, setSnapshots] = useState<Map<number, PlannedFeature>>(() => new Map())
  const openEdit = (i: number): void => {
    setSnapshots((prev) => new Map(prev).set(i, proposal[i]))
    setEditing((prev) => new Set(prev).add(i))
  }
  const closeEdit = (i: number, revert: boolean): void => {
    if (revert) {
      const snap = snapshots.get(i)
      if (snap) onChange(proposal.map((f, idx) => (idx === i ? snap : f)))
    }
    setSnapshots((prev) => { const next = new Map(prev); next.delete(i); return next })
    setEditing((prev) => { const next = new Set(prev); next.delete(i); return next })
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="flight-proposal-view">
      <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        The intent breaks down into {n} feature{n === 1 ? '' : 's'} — each gets its own flight and test suite.
      </div>

      {/* R69 follow-up: the shared group applies to EVERY card, so it heads the
          view instead of trailing under the scrolling list. */}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 rounded border px-3 py-2" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-selected)' }}>
          <span className="cl-rubric shrink-0">
            Group
          </span>
          <input
            value={sharedGroup}
            onChange={(e) => onGroupChange(e.target.value)}
            data-testid="flight-proposal-group"
            placeholder="optional"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
          />
        </label>
        <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
          {sharedGroup.trim()
            ? `Houses these ${n} features under one accordion.`
            : 'Optionally house these features under one accordion.'}
        </div>
      </div>

      <ul className="m-0 flex max-h-[360px] list-none flex-col gap-1.5 overflow-auto p-0 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
        {proposal.map((f, i) => {
          const slug = api.deriveFeatureSlug(f.name)
          const conflicted = conflicts.includes(slug)
          const isEditing = editing.has(i) || conflicted
          return (
            <li
              key={i}
              data-testid={`flight-proposal-card-${i}`}
              className="flex gap-3 rounded-lg p-3"
              style={
                conflicted
                  ? { border: '1px solid color-mix(in srgb, var(--danger) 50%, var(--border-default))' }
                  : isEditing
                    ? { border: '1px solid color-mix(in srgb, var(--accent) 55%, transparent)', background: 'var(--accent-soft)' }
                    : { border: '1px solid var(--border-default)' }
              }
            >
              <span
                aria-hidden="true"
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-medium"
                style={
                  isEditing
                    ? { background: 'var(--accent)', color: '#ffffff' }
                    : { border: '1px solid color-mix(in srgb, var(--accent) 55%, transparent)', color: 'var(--accent)' }
                }
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <div className="flex flex-col gap-1">
                    <div className="cl-rubric">
                      Name
                    </div>
                    <input
                      value={f.name}
                      onChange={(e) => patch(i, { name: e.target.value })}
                      aria-label="Suite name"
                      spellCheck={false}
                      className="mb-1.5 w-full rounded border px-2 py-1 text-[12px] outline-none"
                      style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                    />
                    {conflicted && (
                      <div data-testid={`flight-proposal-conflict-${i}`} className="mb-1.5 text-[10.5px]" style={{ color: 'var(--danger)' }}>
                        A suite named "{slug}" already exists — rename this one.
                      </div>
                    )}
                    <div className="cl-rubric">
                      Intent
                    </div>
                    <Textarea value={f.description} onChange={(v) => patch(i, { description: v })} minRows={4} maxRows={10} />
                    {!conflicted && (
                      <div className="mt-1 flex justify-end gap-1.5">
                        <button
                          type="button"
                          data-testid={`flight-proposal-cancel-${i}`}
                          onClick={() => closeEdit(i, true)}
                          className="cl-button px-2.5 py-1 text-[11px]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          data-testid={`flight-proposal-done-${i}`}
                          disabled={!f.name.trim() || !f.description.trim()}
                          onClick={() => closeEdit(i, false)}
                          className="cl-button-primary px-3 py-1 text-[11px]"
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                        {f.name}
                      </span>
                      <button
                        type="button"
                        aria-label={`Edit ${f.name}`}
                        data-testid={`flight-proposal-edit-${i}`}
                        onClick={() => openEdit(i)}
                        className="cl-hover-row flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                        Edit
                      </button>
                    </div>
                    <div className="whitespace-pre-wrap text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                      {f.description}
                    </div>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {error}

      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="cl-button px-3 py-1 text-xs">Cancel</button>
        <button
          type="button"
          data-testid="flight-proposal-confirm"
          disabled={busy || proposal.some((f) => !f.name.trim() || !f.description.trim())}
          onClick={onConfirm}
          className="cl-button-primary px-3.5 py-1 text-xs"
        >
          {busy ? 'Launching…' : n === 1 ? 'Start the flight' : `Start ${n} flights`}
        </button>
      </div>
    </div>
  )
}

/** One pickable step. Disabled rows stay visible and say WHY they're blocked
 *  (the server's missing-prerequisite message) — never silently unclickable. */
export function StageRow({
  testId,
  selected,
  disabled,
  readOnly,
  onPick,
  icon,
  iconTone,
  label,
  sub,
  step,
  divider,
}: {
  testId: string
  selected: boolean
  disabled?: boolean
  /** Display-only row (fresh mode's journey preview): same anatomy, but not a
   *  control — no radio semantics, no hover, no blocked cursor. */
  readOnly?: boolean
  onPick: () => void
  icon: string
  iconTone: string
  label: string
  sub?: string
  /** Position in the pipeline — the badge's number; a status glyph (prior
   *  record) still wins the badge over the number. */
  step?: number
  /** Hairline above — the connected-list divider (all rows but a standalone). */
  divider?: boolean
}) {
  // The badge carries the most specific mark available: a prior record's
  // status glyph, else the pipeline number, else the caller's icon (▸).
  const badge = icon !== '·' ? icon : step != null ? String(step) : icon
  // Status glyphs (and caller icons like ▸) keep their meaningful hue; a bare
  // pipeline number reads in secondary so the sequence stays legible. Selection
  // is carried by the row's selected-grey alone — the badge is never recoloured
  // for it, so nothing in the row competes with the status hues.
  const badgeTone = icon !== '·' ? iconTone : 'var(--text-secondary)'
  const body = (
    <>
      <span
        aria-hidden="true"
        className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[9.5px] font-semibold"
        style={{
          borderColor: `color-mix(in srgb, ${badgeTone} 70%, var(--border-default))`,
          color: badgeTone,
          background: 'transparent',
        }}
      >
        {badge}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px] font-medium" style={{ color: disabled && !readOnly ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
          {label}
        </span>
        {sub && (
          <span className="text-[10.5px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {sub}
          </span>
        )}
      </span>
    </>
  )
  // Look and selection language come from the shared option row (neutral
  // surface, selected-grey, no accent) — the same one the heal-behavior modes
  // use, so the two pickers can't drift apart.
  if (readOnly) {
    return (
      <div
        data-testid={testId}
        className={`${OPTION_ROW_CLASS} ${divider ? 'border-t' : ''}`}
        style={optionRowStyle({ selected })}
      >
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={testId}
      disabled={disabled}
      onClick={onPick}
      className={`${OPTION_ROW_CLASS} ${disabled ? '' : 'cl-hover-row'} ${divider ? 'border-t' : ''}`}
      style={optionRowStyle({ selected, disabled, interactive: true })}
    >
      {body}
    </button>
  )
}
