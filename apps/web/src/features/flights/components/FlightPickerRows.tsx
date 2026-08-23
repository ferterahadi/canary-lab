import { useState } from 'react'
import type { FlightIndexEntry, FlightStageKey, FlightStageStatus, PlanFeaturesTask } from '@/shared/api/client'
import { ChevronRightIcon, SlideOverPanel } from '@/shared/ui/atoms'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import type { FeatureActivity } from '../state/feature-activity'
import { Chip } from '@/shared/ui/StatusChip'
import { Tooltip } from '@/shared/ui/Tooltip'
import { STAGE_STATUS_LABEL, stageRailRows, stageStatusTone } from './stage-meta'
import { readGroupOpen, writeGroupOpen } from '../lib/group-open-state'
import { derivedFlightToken } from '../lib/derived-stages'
import { ACTIVITY_CHIP, FeatureActivityRow, FlightStatusChip, PickerGroup, activityStages, featureActivityRows, featureChipState, groupPickerRows, preFlightChipState } from './FlightChipState'
import { presentedIndexStages } from '../lib/external-work'

/** One tiny cell per USER-VISIBLE stage (same rows as the flight detail rail —
 *  similarity hidden unless it needs a human, run+heal merged), colored by
 *  status — the at-a-glance progress rail in the picker rows and landing list. */
export function StageMiniRail({ stages }: { stages: Array<{ key: string; status: FlightStageStatus }> }) {
  const source = stages.length > 0
    ? stages
    : FLIGHT_STAGE_KEYS.map((key) => ({ key: key as string, status: 'pending' as FlightStageStatus }))
  const toneFor = (status: FlightStageStatus): string => {
    if (status === 'pending') return 'var(--border-default)'
    if (status === 'skipped') return 'color-mix(in srgb, var(--success) 40%, transparent)'
    return stageStatusTone(status)
  }
  return (
    <span className="inline-flex items-center gap-[3px]" data-testid="stage-mini-rail">
      {stageRailRows(source).map((row) => (
        // Humanized status (the same words the stage chip uses), never the raw
        // wire value — "needs approval", not "waiting-for-approval".
        <Tooltip key={row.key} label={`${row.label} — ${STAGE_STATUS_LABEL[row.status]}`}>
          <span
            data-testid={`stage-mini-cell-${row.key}`}
            className="inline-block h-[8px] w-[8px] rounded-[2px]"
            // The cells are colour-coded for sighted users; the label carries
            // the same fact for everyone else — without it this was the one
            // colour-only status surface in the flight UI.
            role="img"
            aria-label={`${row.label} — ${STAGE_STATUS_LABEL[row.status]}`}
            style={{ background: toneFor(row.status) }}
          />
        </Tooltip>
      ))}
    </span>
  )
}

export function FlightsPickerDialog({
  flights,
  preFlights,
  activity,
  features,
  onPick,
  onPickActivity,
  onStartFlight,
  onPickPreFlight,
  onClose,
}: {
  flights: FlightIndexEntry[]
  preFlights: PlanFeaturesTask[]
  activity: Map<string, FeatureActivity>
  features: Array<{ name: string; group?: string; stages?: Array<{ key: FlightStageKey; status: FlightStageStatus }> }>
  onPick: (flightId: string | null) => void
  onPickActivity: (feature: string, activity: FeatureActivity) => void
  onStartFlight: (feature: string) => void
  onPickPreFlight: (taskId: string) => void
  onClose: () => void
}) {
  const rows = featureActivityRows(flights, activity, features)
  // R55: split into the flat top-level bucket + collapsible group sections.
  const { ungrouped, groups } = groupPickerRows(rows, features)
  // Pre-flights precede any feature, so they sit above the feature rows —
  // sorted worst-first (a settled "to review" above a still-planning one).
  const preFlightRows = [...preFlights].sort((a, b) => preFlightChipState(a).rank - preFlightChipState(b).rank)

  // Portalled to <body>: the status-bar action cluster is overflow-hidden and
  // carries a transform during its collapse animation.
  return (
    <SlideOverPanel
      onClose={onClose}
      ariaLabel="Open flights"
      testId="flights-task-menu"
      portal
      header={
        <>
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-1.5 text-[13.5px] font-semibold">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4Z" />
              </svg>
              Flights
            </h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              One command from a bare repo to a green, covered, evaluated run. Pick a flight to follow its stages and answer checkpoints.
            </p>
          </div>
          <button type="button" aria-label="Close flights picker" onClick={onClose} className="cl-button px-2 py-1 text-xs">
            Close
          </button>
        </>
      }
      footer="Canary checks every step itself — the app booted, coverage was met, the run went green. The agent only suggests; Canary decides."
    >
      {rows.length === 0 && preFlightRows.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
          No flights yet. Fly a suite from its row in the features list — or start one from a terminal:
          <div className="cl-code-shell mt-2 px-2 py-1.5 text-[11px]">
            npx canary-lab flight ../your-repo "what to test"
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
          {preFlightRows.length > 0 && (
            <ul className="flex flex-col gap-1">
              {preFlightRows.map((task) => (
                <PreFlightRow key={task.taskId} task={task} onOpen={onPickPreFlight} />
              ))}
            </ul>
          )}
          {ungrouped.length > 0 && (
            <ul className="flex flex-col gap-1">
              {ungrouped.map((row) => (
                <PickerRow
                  key={row.flight?.flightId ?? `activity-${row.feature}`}
                  row={row}
                  onPick={onPick}
                  onPickActivity={onPickActivity}
                  onStartFlight={onStartFlight}
                />
              ))}
            </ul>
          )}
          {groups.map((section) => (
            <PickerGroupSection
              key={section.group!}
              section={section}
              onPick={onPick}
              onPickActivity={onPickActivity}
              onStartFlight={onStartFlight}
            />
          ))}
        </div>
      )}
    </SlideOverPanel>
  )
}

/** One picker row — a flight, an activity-only feature, or a never-flown one.
 *  Shared by the flat top-level list and the group sections (R55). */
export function PickerRow({
  row,
  onPick,
  onPickActivity,
  onStartFlight,
}: {
  row: FeatureActivityRow
  onPick: (flightId: string | null) => void
  onPickActivity: (feature: string, activity: FeatureActivity) => void
  onStartFlight: (feature: string) => void
}) {
  if (row.flight) {
    return (
      <li>
        <button
          type="button"
          data-testid={`flight-open-${row.flight.flightId}`}
          onClick={() => onPick(row.flight!.flightId)}
          className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left cl-hover-row"
          style={{ border: '1px solid transparent' }}
          title={`Open flight ${row.flight.flightId} (${row.feature})`}
        >
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{row.feature}</span>
          <StageMiniRail stages={presentedIndexStages(row.flight)} />
          <FlightStatusChip flight={row.flight} activity={row.activity} />
          <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
        </button>
      </li>
    )
  }
  return (
    <li>
      {row.activity
        ? <ActivityOnlyRow feature={row.feature} activity={row.activity} derived={row.derived} onOpen={onPickActivity} />
        : <NotFlownRow
            feature={row.feature}
            derived={row.derived}
            onStart={onStartFlight}
            /* R81: derived progress opens the flight view under a token id —
               the same `onPick` channel a recorded flight uses. */
            onOpenDerived={(f) => onPick(derivedFlightToken(f))}
          />}
    </li>
  )
}

export const GROUPS_OPEN_STORAGE_KEY = 'cl-flight-groups-open'

/** A collapsible group section (R55): chevron + group name + count + a tiny
 *  worst-state chip; rows render under the disclosure. Open-state persists per
 *  group in localStorage; the picker's resting default is COLLAPSED (the list
 *  can be long — the worst-state summary chip carries what each group needs
 *  without expanding it), and an explicit user toggle is remembered. */
export function PickerGroupSection({
  section,
  onPick,
  onPickActivity,
  onStartFlight,
}: {
  section: PickerGroup
  onPick: (flightId: string | null) => void
  onPickActivity: (feature: string, activity: FeatureActivity) => void
  onStartFlight: (feature: string) => void
}) {
  const group = section.group!
  const [open, setOpen] = useState(() => readGroupOpen(GROUPS_OPEN_STORAGE_KEY, group, false))
  const toggle = (): void => setOpen((v) => { const next = !v; writeGroupOpen(GROUPS_OPEN_STORAGE_KEY, group, next); return next })
  // The worst row drives the section's summary chip (same comparator).
  const worst = section.rows.reduce((acc, r) =>
    featureChipState(r.flight, r.activity, r.derived).rank < featureChipState(acc.flight, acc.activity, acc.derived).rank ? r : acc, section.rows[0])
  return (
    <section data-testid={`flight-group-${group}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        data-testid={`flight-group-toggle-${group}`}
        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left cl-hover-row"
        style={{ border: '1px solid transparent' }}
      >
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none' }}
        >
          <ChevronRightIcon />
        </span>
        <span className="cl-rubric min-w-0 flex-1 truncate">
          {group}
        </span>
        <span className="cl-count-chip shrink-0">{section.rows.length}</span>
        <FlightStatusChip flight={worst.flight} activity={worst.activity} derived={worst.derived} />
        {/* Invisible arrow-width spacer: aligns the group's status chip with the
         *  trailing '→' column on every row below (rows reserve this width). */}
        <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'transparent' }}>→</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1 pl-4">
          {section.rows.map((row) => (
            <PickerRow
              key={row.flight?.flightId ?? `activity-${row.feature}`}
              row={row}
              onPick={onPick}
              onPickActivity={onPickActivity}
              onStartFlight={onStartFlight}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Row for a feature with no flight record (R49): same anatomy as a flight row
 *  — name, mini rail, chip — with the rail showing the evidence-DERIVED
 *  progress (which steps standalone work already completed).
 *  With zero evidence the rail renders fully greyed (all-pending squares at
 *  reduced opacity, per the mock review: squares, never a dash; chip "not
 *  flown").
 *
 *  R81 — the click target follows the evidence, not the record. Any derived
 *  progress → open the flight detail for it (a `feature:` token id), because
 *  those completed stages ARE flight progress and the user came to see them.
 *  Only a truly untouched feature opens the launcher: with nothing to show,
 *  starting IS the next action. Routing a part-flown row to a
 *  start-from-scratch dialog asks the user to redo finished work. */
export function NotFlownRow({
  feature,
  derived,
  onStart,
  onOpenDerived,
}: {
  feature: string
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
  onStart: (feature: string) => void
  onOpenDerived?: (feature: string) => void
}) {
  const chip = featureChipState(null, undefined, derived)
  const hasProgress = derived?.some((s) => s.status !== 'pending') ?? false
  const open = hasProgress && onOpenDerived ? () => onOpenDerived(feature) : () => onStart(feature)
  return (
    <button
      type="button"
      data-testid={hasProgress && onOpenDerived ? `derived-open-${feature}` : `not-flown-${feature}`}
      onClick={open}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left cl-hover-row"
      style={{ border: '1px solid transparent' }}
      title={`${feature}: ${chip.title}`}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>{feature}</span>
      <span style={{ opacity: chip.label === 'not flown' ? 0.55 : 1 }}>
        <StageMiniRail stages={derived ?? []} />
      </span>
      <FlightStatusChip flight={null} derived={derived} />
      <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
    </button>
  )
}

/** Row for a feature with live activity but no flight record (a standalone
 *  run / portify / authoring job): same shape as a flight row, the live
 *  progress chip always carrying the state (R39 — no "no flight" label), and
 *  clicking opens the flights view. */
export function ActivityOnlyRow({
  feature,
  activity,
  derived,
  onOpen,
}: {
  feature: string
  activity: FeatureActivity
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
  onOpen: (feature: string, activity: FeatureActivity) => void
}) {
  return (
    <button
      type="button"
      data-testid={`activity-open-${feature}`}
      onClick={() => onOpen(feature, activity)}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left cl-hover-row"
      style={{ border: '1px solid transparent' }}
      title={`${feature}: ${ACTIVITY_CHIP[activity.kind].title}`}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{feature}</span>
      <StageMiniRail stages={activityStages(activity.kind, derived)} />
      <FlightStatusChip flight={null} activity={activity} />
      <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
    </button>
  )
}

/** Row for a pre-flight (plan-features) task — the intent breakdown running
 *  BEFORE any feature exists. No stage rail (nothing has entered the pipeline);
 *  the intent text is the label, the chip carries the state ("planning" while
 *  the agent judges, "to review" once it settles), and clicking reopens the
 *  new-flight dialog attached to the task. */
export function PreFlightRow({
  task,
  onOpen,
}: {
  task: PlanFeaturesTask
  onOpen: (taskId: string) => void
}) {
  const chip = preFlightChipState(task)
  return (
    <li>
      <button
        type="button"
        data-testid={`pre-flight-open-${task.taskId}`}
        onClick={() => onOpen(task.taskId)}
        className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left cl-hover-row"
        style={{ border: '1px solid transparent' }}
        title={`${chip.title} — ${task.description}`}
      >
        <span aria-hidden="true" className="shrink-0" style={{ color: 'var(--text-muted)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4Z" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          {task.description}
        </span>
        <Chip testId="pre-flight-status-chip" chrome="border" tone={chip.tone} label={chip.label} width={72} title={chip.title} />
        <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
      </button>
    </li>
  )
}
