import { useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightManifest, FlightStageKey, FlightStageStatus } from '@/shared/api/client'
import { Modal, useEscapeToClose } from '@/shared/ui/atoms'
import { OPTION_ROW_CLASS, optionRowStyle } from '@/shared/ui/OptionRow'
import { DeleteSuiteConfirm } from '@/features/config'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import { START_FRESH_BLURB, START_FRESH_LABEL } from './FlightStartDialog'
import { STAGE_BLURB, STAGE_ICON, stageRowKey, stageStatusTone } from './stage-meta'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import { EXTERNAL_DRIVE_COPY } from '../lib/external-work'

/** The stages Continue → "from a step…" offers — the user-facing rail rows
 *  (merged-pair primaries), labeled the way the rail labels them. The server
 *  validates prerequisites (checkStageEntry) and 400s an invalid target. */
export const REDO_STAGES: Array<{ key: FlightStageKey; label: string }> = [
  { key: 'scout', label: 'Repo scan' },
  { key: 'scaffold', label: 'Suite setup' },
  { key: 'docs', label: 'Requirements' },
  { key: 'specs-coverage', label: 'Test authoring & coverage' },
  { key: 'portify', label: 'Parallel readiness' },
  { key: 'run', label: 'Test Run' },
  { key: 'evaluation-export', label: 'Evaluation Report' },
]

/** R77/R78: the resume target — the rail ROW owning the first unsettled stage,
 *  which is where `resumeFlight` picks up (it flips a failed stage back to
 *  pending and drives from there). Scanning REDO_STAGES directly got this wrong
 *  for pair-merged rows: a failed companion (prd-summary) is not in that list,
 *  so a `done` primary (docs) made the row look finished and the label named the
 *  NEXT row while resume in fact re-entered this one. Scan every stage in
 *  execution order instead, then fold the companion back onto its row. */
export function resumeTargetLabel(flight: FlightManifest): string | null {
  const settled = new Set<FlightStageStatus>(['done', 'skipped'])
  const open = FLIGHT_STAGE_KEYS.map((key) => flight.stages.find((s) => s.key === key)).find(
    (stage) => stage != null && !settled.has(stage.status),
  )
  if (!open) return null
  const rowKey = stageRowKey(open.key)
  return REDO_STAGES.find(({ key }) => key === rowKey)?.label ?? null
}

/** R74: ONE Continue control for every settled flight state. Paused → a small
 *  menu (Resume at <stage> / From a step…); everything else goes straight to
 *  the centered re-run dialog. */
export function ContinueMenu({
  flight,
  onAction,
  onStartFlight,
  externallyDriven = false,
}: {
  flight: FlightManifest
  onAction: (call: () => Promise<unknown>, onSuccess?: () => void) => void
  /** The "Start fresh" handoff — opens the launcher with editable inputs. */
  onStartFlight?: (feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
  /** The flight is being driven by the MCP client that started it, so resuming
   *  and re-entering a step are that client's calls (start_flight resumes; its
   *  from_stage/redo + feedback re-enter a stage). Both items live behind this
   *  one trigger, so disabling the trigger disables both — and the menu never
   *  opens onto choices the user cannot take. */
  externallyDriven?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const paused = flight.status === 'paused'
  const resumeTarget = resumeTargetLabel(flight)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  // Escape closes the open dropdown first, above the flight page's own
  // Escape-to-exit — one press dismisses the menu, not the whole page.
  useEscapeToClose(() => setOpen(false), open)

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        data-testid="flight-continue"
        aria-haspopup={paused ? 'menu' : 'dialog'}
        aria-expanded={paused ? open : dialogOpen}
        onClick={() => (paused ? setOpen((v) => !v) : setDialogOpen(true))}
        disabled={externallyDriven}
        title={externallyDriven ? EXTERNAL_DRIVE_COPY.continueFlight : undefined}
        className="cl-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-45"
      >
        Continue ▾
      </button>
      {open && (
        <div
          role="menu"
          className="cl-popover absolute right-0 top-full z-20 mt-1 flex w-[260px] flex-col gap-1 p-1.5"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="flight-resume"
            onClick={() => { setOpen(false); onAction(() => api.resumeFlight(flight.flightId)) }}
            className="cl-hover-row rounded px-2 py-1.5 text-left transition-colors"
          >
            <span className="block text-xs font-medium">
              {resumeTarget ? `▶ Resume at ${resumeTarget}` : '▶ Resume'}
            </span>
            <span className="block text-[10.5px] text-muted">
              Keeps every finished step and retries the first unfinished one
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="flight-redo-open"
            onClick={() => { setOpen(false); setDialogOpen(true) }}
            className="cl-hover-row rounded px-2 py-1.5 text-left transition-colors"
          >
            <span className="block text-xs font-medium">↻ From a step…</span>
            <span className="block text-[10.5px] text-muted">
              Re-run a step — you can tell the agent what went wrong
            </span>
          </button>
        </div>
      )}
      {dialogOpen && (
        <RedoFlightDialog
          flight={flight}
          onAction={onAction}
          onClose={() => setDialogOpen(false)}
          onStartFresh={onStartFlight ? () => { setDialogOpen(false); onStartFlight(flight.feature, 'fresh') } : undefined}
        />
      )}
    </div>
  )
}

/** The centered re-run dialog (R74): pick the step to re-enter, see WHY a step
 *  is unavailable (the server's stage-entry validator supplies per-stage
 *  reasons via /api/flights/entry — never a dead 400 on submit), and attach
 *  the optional "what went wrong" note that rides into the agent's prompt. */
export function RedoFlightDialog({
  flight,
  onAction,
  onClose,
  onStartFresh,
}: {
  flight: FlightManifest
  onAction: (call: () => Promise<unknown>, onSuccess?: () => void) => void
  onClose: () => void
  /** R75: hands off to the launcher (prefilled, editable inputs) — the one
   *  home for "change what this flight tests"; this dialog never edits them. */
  onStartFresh?: () => void
}) {
  const [entry, setEntry] = useState<Awaited<ReturnType<typeof api.getFlightEntryOptions>> | null>(null)
  const [entryFailed, setEntryFailed] = useState(false)
  const [fromStage, setFromStage] = useState<FlightStageKey | null>(null)
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    let alive = true
    api.getFlightEntryOptions(flight.feature, flight.opts.env)
      .then((options) => { if (alive) setEntry(options) })
      // Validation still happens on submit — a failed pre-check must not
      // brick the dialog, it just can't grey the impossible rows.
      .catch(() => { if (alive) setEntryFailed(true) })
    return () => { alive = false }
  }, [flight.feature, flight.opts.env])

  const entryFor = (key: FlightStageKey): { allowed: boolean; reason?: string } => {
    if (entryFailed) return { allowed: true }
    if (!entry) return { allowed: false, reason: 'checking…' }
    const option = entry.stages.find((s) => s.key === key)
    return option ?? { allowed: true }
  }
  const selectedLabel = REDO_STAGES.find((s) => s.key === fromStage)?.label

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Re-run from a step"
      description="Pick where the flight restarts. Results from that step on are thrown away; files already written stay."
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="cl-button px-3 py-1.5 text-xs">
            Cancel
          </button>
          <button
            type="button"
            data-testid="flight-redo-submit"
            disabled={fromStage === null}
            onClick={() => {
              const stage = fromStage
              if (!stage) return
              onClose()
              onAction(() => api.redoFlight(flight.flightId, {
                fromStage: stage,
                feedback: feedback.trim() || undefined,
              }))
            }}
            className="cl-button-primary px-3 py-1.5 text-xs"
          >
            {selectedLabel ? `Re-run from ${selectedLabel}` : 'Re-run'}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        {/* R76: the full restart LEADS the list — it re-enters before step 1, so
            burying it under seven later steps read as out of order. It stays
            outside the radiogroup and visually secondary (muted, → nav, no
            badge number): correct sequentially, but never the recommended pick —
            it's the rarest and the only one that throws work away. */}
        {onStartFresh && (
          <button
            type="button"
            data-testid="flight-redo-start-fresh"
            onClick={onStartFresh}
            className="cl-hover-row -mb-2 flex items-start gap-3 rounded-md px-3.5 py-2 text-left transition-colors"
          >
            <span
              aria-hidden="true"
              className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] border-line text-muted"
            >
              ✎
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-secondary">
                {START_FRESH_LABEL}
              </span>
              <span className="text-[10.5px] leading-snug text-muted">
                {START_FRESH_BLURB}
              </span>
            </span>
            <span aria-hidden="true" className="shrink-0 self-center text-[12px] text-muted">→</span>
          </button>
        )}

        {/* One connected pipeline the eye reads top-to-bottom. Each row's
            badge carries the LAST record's verdict for that step (✓ done,
            number = never reached); its sub-line says what the step does — or
            the server's full reason when the step can't be an entry point
            (wrapped, never truncated mid-word). */}
        <div
          role="radiogroup"
          aria-label="Step to re-run from"
          className="flex flex-col overflow-hidden rounded-md border border-line"
        >
          {REDO_STAGES.map((s, index) => {
            const { allowed, reason } = entryFor(s.key)
            const selected = fromStage === s.key
            const lastStatus = flight.stages.find((st) => st.key === s.key)?.status
            const settled = lastStatus && lastStatus !== 'pending'
            // The badge is never recoloured for selection — the row's grey says
            // which one is picked, so the badge is free to keep saying what the
            // stage's last run did.
            const badgeTone = settled ? stageStatusTone(lastStatus) : 'var(--text-muted)'
            return (
              <button
                key={s.key}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`flight-redo-${s.key}`}
                disabled={!allowed}
                onClick={() => setFromStage(selected ? null : s.key)}
                /* Look, selection language and hairline all come from the shared
                   option row (neutral surface, selected-grey, no accent) — the
                   same one the start proposal's StageRow and the heal-behavior
                   modes use, so the three pickers can't drift apart. It owns the
                   cursor in both directions — a pickable row's pointer comes from
                   `interactive`, not a utility here — and deliberately does NOT
                   dim a locked row:
                   this row's sub-line becomes the server's missing-prerequisite
                   reason, which is the one thing a blocked row exists to say, and
                   a blanket opacity multiplies that already-muted 10.5px line
                   down past readable. Blocked-ness rides on the cursor, the
                   muted label and the reason text instead.
                   Hover is gated on `allowed` because `.cl-hover-row:hover` has
                   no :disabled guard — an unpickable row would otherwise light up
                   under the pointer while showing `not-allowed`. */
                className={[
                  OPTION_ROW_CLASS,
                  allowed ? 'cl-hover-row' : '',
                  index > 0 ? 'border-t' : '',
                ].filter(Boolean).join(' ')}
                style={optionRowStyle({ selected, disabled: !allowed, interactive: true })}
              >
                <span
                  aria-hidden="true"
                  className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[9.5px] font-semibold"
                  style={{
                    borderColor: `color-mix(in srgb, ${badgeTone} 55%, var(--border-default))`,
                    color: badgeTone,
                    background: 'transparent',
                  }}
                >
                  {settled ? STAGE_ICON[lastStatus] : index + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`text-[12.5px] font-medium ${allowed ? 'text-primary' : 'text-muted'}`}>
                    {s.label}
                  </span>
                  <span className="text-[10.5px] leading-snug text-muted">
                    {!allowed && reason ? reason : STAGE_BLURB[s.key]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-secondary">
            What went wrong last time? <span className="font-normal text-muted">(optional — added to the agent's prompt)</span>
          </span>
          <textarea
            data-testid="flight-redo-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. it collected docs for the wrong part of the app"
            rows={2}
            className="cl-input w-full px-2.5 py-2 text-[11.5px]"
          />
        </label>
      </div>
    </Modal>
  )
}

/** R71/W1: the header's ⋯ menu — R74 slimmed it to the destructive disposal
 *  (Delete flight, two-step confirm in place: first click arms, second fires;
 *  closing disarms). Errors route to the header's inline error line. */
export function FlightMenu({
  flight,
  derived = false,
  onAction,
  onDeleted,
  externallyDriven = false,
}: {
  flight: FlightManifest
  /** R81: a pseudo-manifest for a feature with no flight record. The menu's one
   *  action deletes the SUITE, which exists on disk either way — so this only
   *  rules out the record-removal variant below. */
  derived?: boolean
  onAction: (call: () => Promise<unknown>, onSuccess?: () => void) => void
  onDeleted: () => void
  /** The flight belongs to the MCP client driving it — see the Abort item. */
  externallyDriven?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) { setArmed(null); return }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  // Escape closes the open ⋯ menu first, above the flight page's own
  // Escape-to-exit — one press dismisses the menu, not the whole page.
  useEscapeToClose(() => setOpen(false), open)

  const active = flight.status === 'running' || flight.status === 'waiting-for-approval'

  interface MenuItem {
    key: string
    label: string
    /** Present → two-step: first click arms with this label, second fires. */
    confirmLabel?: string
    tone?: string
    title?: string
    testId: string
    fire: () => void
  }
  // R74/R76: Pause is a header button and resume/repeat/start-over collapsed
  // into the header's Continue menu. The ⋯ menu keeps only destructive disposal:
  // a suite after setup, or the lone flight record before setup creates one.
  const [deleteOpen, setDeleteOpen] = useState(false)
  // Before Suite setup the only durable thing is the flight record itself. A
  // suite delete would 404 because there is no feature directory yet. Never on a
  // derived flight: it has no record to remove, and it only exists BECAUSE the
  // feature directory does — so the suite is always the thing to delete, even
  // with Suite setup still open.
  const removeFlightOnly = !derived
    && flight.stages.find((stage) => stage.key === 'scaffold')?.status === 'pending'
  const items: MenuItem[] = [
    // The one control an externally driven flight keeps. Everything else on
    // this page defers to the agent, but deferring ABORT would mean a client
    // that crashed, was closed, or simply stopped answering leaves the flight
    // parked forever with no way out from here — and its repos locked against
    // the next flight. Aborting decides nothing on the agent's behalf; it ends
    // a flight nobody is driving any more. Two-step confirm, like every other
    // terminal action in this menu.
    // Not gated on `active`: a PAUSED external flight is precisely the case
    // that needs this — a stage failed, and the client that would have resumed
    // it is the one that has gone quiet. `externallyDriven` is already
    // live-only, so a settled flight never reaches here.
    ...(externallyDriven
      ? [{
          key: 'abort',
          label: 'Abort flight…',
          confirmLabel: 'Abort — end this flight',
          tone: 'var(--danger)',
          title: 'End this flight for good — use it when the agent driving it has stopped responding',
          testId: 'flight-abort',
          fire: () => onAction(() => api.abortFlight(flight.flightId)),
        }]
      : []),
    ...(!active
      ? [{
          key: 'delete',
          label: removeFlightOnly ? 'Remove flight…' : 'Delete suite…',
          tone: 'var(--danger)',
          title: removeFlightOnly
            ? 'Remove this flight record — it stopped before a suite was created'
            : 'Delete this suite — its folder (settings, tests, saved env values, docs) and its whole flight history',
          testId: 'flight-delete',
          fire: () => setDeleteOpen(true),
        }]
      : []),
  ]

  if (items.length === 0) return null
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        data-testid="flight-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Flight actions"
        onClick={() => setOpen((v) => !v)}
        className="cl-button px-2.5 py-1 text-xs"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="cl-popover absolute right-0 top-full z-20 mt-1 flex min-w-[172px] flex-col p-1.5"
        >
          {items.map((item) => {
            const isArmed = armed === item.key
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                data-testid={isArmed ? `${item.testId}-confirm` : item.testId}
                title={item.title}
                onClick={() => {
                  if (item.confirmLabel && !isArmed) { setArmed(item.key); return }
                  setOpen(false)
                  item.fire()
                }}
                className="cl-hover-row rounded px-2.5 py-1.5 text-left text-xs transition-colors"
                style={{ color: item.tone }}
              >
                {isArmed ? item.confirmLabel : item.label}
              </button>
            )
          })}
        </div>
      )}
      <DeleteSuiteConfirm
        feature={flight.feature}
        flightId={removeFlightOnly ? flight.flightId : undefined}
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onDeleted={() => { setDeleteOpen(false); onDeleted() }}
      />
    </div>
  )
}
