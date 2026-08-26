import type { ReactNode } from 'react'
import type { FlightStage, FlightStageKey, FlightStageStatus, SpecsCoverageProgress } from '@/shared/api/client'
import { capitalizeFirst } from '@/shared/lib/format'
import { StatusDot } from '@/shared/ui/atoms'
import { Chip } from '@/shared/ui/StatusChip'

export { evaluationTaskId, FactTile, FactsGrid, plural, stageFacts } from './StageFacts'
export type { StageBandData, StageFact } from './StageFacts'
export { STAGE_COMPANION, stageRailRows, stageRowKey } from './StageRail'
export type { StageRailRow } from './StageRail'
export { formatDuration, formatStageDuration, healEndLine, healEndShort, stageStateLine, stageWorkMs } from './StageStatusLines'

// One home for the flight-stage presentation vocabulary (R14/R16/R18): the
// user-facing stage labels, the status tone/icon treatment, the shared status
// chip every surface renders, and the per-stage state line ("where are we") the
// trailer column leads with. Stage KEYS stay canonical in the store/MCP/CLI —
// only the display layer speaks outcome language.

/** Stage key → user-facing label. Moved to shared/flights/stage-labels.ts so
 *  the server's own user-facing messages (stage-entry rejections) speak the
 *  same names the rail shows instead of raw stage keys; re-exported here so the
 *  flight components keep their one import home. */
export { FLIGHT_STAGE_LABEL as STAGE_LABEL, flightStageLabel as stageLabel } from '@shared/flights/stage-labels'

/** The stage pane's card column. Every panel, facts grid, error/paused card and
 *  the Test Run hero share it, so a stage reads as ONE column of like blocks
 *  instead of a ragged pile of shrink-wrapped boxes.
 *  Widened from 76ch: the Test Run stage now shows each failure's wrapped title
 *  and its assertion error, and at 76ch that content was squeezed into the left
 *  third of a pane with nothing in the rest of it. Prose (the state line, panel
 *  blurbs) deliberately stays at the narrower 76ch reading measure. */
export const STAGE_COLUMN = 'w-full max-w-[92ch]'

/** Shared promise shown anywhere a person can start or open a Flight. */
export const FLIGHT_OVERVIEW = 'From a bare repo to tests, coverage evidence, and a downloadable report.'

/** The Test Run hero's row geometry, in ONE place. Four blocks stack inside that
 *  card — the run identity row, the stats line, the failing-test rows, and the
 *  skeleton that stands in for all three — and each used to state its own gutter
 *  and dot size. RunRow sat at `px-3` with a 0.55rem dot while a failure row sat
 *  at `px-1.5` with a 6px one, so the card had two left edges 6px apart and the
 *  eye read the failures as belonging to a different list.
 *
 *  A failure's dot stays visually smaller (it IS a subordinate row) but is
 *  centred in a `DOT` -wide lane, so the smaller dot shares the run row's dot
 *  centre and every title in the card starts on `TEXT_INDENT`. */
export const HERO_ROW = {
  /** RunRow's `px-3`. */
  GUTTER: '0.75rem',
  /** RunRow's StatusDot — also the lane a smaller row dot is centred in. */
  DOT: '0.55rem',
  /** RunRow's `gap-2`. */
  GAP: '0.5rem',
  /** Where every title/meta/stats line in the hero begins. */
  TEXT_INDENT: 'calc(0.75rem + 0.55rem + 0.5rem)',
} as const

/** The column as a wrapper, so a panel with two render branches cannot cap one
 *  and forget the other. Six evidence panels wrapped their SETTLED output in a
 *  bare `<div className={STAGE_COLUMN}>` and returned their skeleton unwrapped,
 *  so a working stage showed pane-wide placeholders that visibly narrowed the
 *  moment real figures arrived — the exact opposite of the R83 promise that a
 *  value lands in the slot its placeholder held. */
export function StageColumn({ children }: { children: ReactNode }) {
  return <div className={STAGE_COLUMN}>{children}</div>
}

/** One-line "what this stage does", in plain language — shown in the flight
 *  launcher's full-flight preview so the pipeline explains itself, instead of
 *  every locked row repeating the same "unlocks after the first flight" note
 *  (that lock is stated once, on the section header). */
export const STAGE_BLURB: Record<FlightStageKey, string> = {
  'similarity': 'Runs every step below, start to finish.',
  'scout': 'Reads your repo to learn what it is built with and how it starts.',
  'scaffold': 'Creates the test suite in your workspace, with settings and a start command.',
  'env-capture': 'Copies the settings the app needs to start.',
  'docs': 'Collects the documents that describe what the feature should do.',
  'prd-summary': 'Turns those documents into a short list of things to test.',
  'specs-coverage': 'Writes tests and maps them to requirements against your coverage target.',
  'portify': 'Lets each service take its port from settings, so two runs can go at once.',
  'run': 'Starts the app and runs the tests, fixing failures as they come up.',
  'heal': 'Fixes failures by editing the app, then runs the tests again.',
  'evaluation-export': 'Packs the finished run into a report you can download.',
}

/** The single status hue map — rail, chip, mini rail, and any artifact surface
 *  all read this so a colour means the same thing everywhere. */
export function stageStatusTone(status: FlightStageStatus | undefined): string {
  if (status === 'done') return 'var(--success)'
  if (status === 'running') return 'var(--running)'
  if (status === 'waiting-for-approval') return 'var(--warning)'
  if (status === 'failed') return 'var(--danger)'
  if (status === 'skipped') return 'color-mix(in srgb, var(--success) 55%, var(--text-muted))'
  return 'var(--text-muted)'
}

export const STAGE_ICON: Record<FlightStageStatus, string> = {
  'pending': '·',
  'running': '▸',
  'waiting-for-approval': '?',
  'done': '✓',
  'failed': '✕',
  'skipped': '↷',
}

export const STAGE_STATUS_LABEL: Record<FlightStageStatus, string> = {
  'pending': 'pending',
  // "running", not "generating": this label sits on EVERY running stage, and a
  // repo scan, a boot check or a live Playwright run generates nothing.
  'running': 'running',
  'waiting-for-approval': 'needs approval',
  'done': 'done',
  'failed': 'failed',
  'skipped': 'skipped',
}

/** The one stage-status treatment (R14): icon + label chip in the stage's tone,
 *  with the live dot while generating. Every surface that shows a stage's state
 *  renders this — never a hand-rolled chip. */
export function StageStatusChip({ status }: { status: FlightStageStatus }) {
  const tone = stageStatusTone(status)
  return (
    <Chip
      testId="stage-status-chip"
      chrome="fill"
      tone={tone}
      fontSize={10}
      icon={status === 'running'
        ? <StatusDot state="running" className="shrink-0" />
        : <span aria-hidden="true">{STAGE_ICON[status]}</span>}
      label={capitalizeFirst(STAGE_STATUS_LABEL[status])}
    />
  )
}

// ─── Checkpoint display vocabulary (R71/W3) ─────────────────────────────────
// Server checkpoint kinds and option KEYS stay canonical (MCP/CLI/four-surface
// parity — respond_flight_checkpoint still takes the raw key). This map is the
// display layer only: outcome language for card titles and option buttons,
// mirroring the STAGE_LABEL pattern. An unmapped kind/option falls back to its
// raw key, so new server checkpoints degrade readable, never blank.

const CHECKPOINT_TITLE: Record<string, string> = {
  'similarity-choice': 'Existing suite found — what should this flight do?',
  'config-approval': 'Does this setup look right?',
  'missing-env': 'Some settings are missing',
  'prd-source': 'Where should requirements come from?',
  'coverage-stuck': 'Coverage stopped short of the target',
  'portify-gate': 'Make this suite safe to run twice at once?',
  'portify-apply': 'Save these port changes?',
  'run-failed': 'The test run did not pass',
  'export-mode': 'How should the report be built?',
  // StageDetail presents this protocol checkpoint as running Activity, not a
  // decision card. Keep the wire vocabulary labelled for any consumer that
  // still asks for a generic checkpoint title.
  'external-work': 'External agent work',
}

const CHECKPOINT_OPTION_LABEL: Record<string, Record<string, string>> = {
  'similarity-choice': {
    'rerun': 'Run existing tests',
    'enhance': 'Update it, then run',
    'new': 'Start a fresh suite',
  },
  'config-approval': {
    'approve': 'Looks right',
    'redraft': 'Scan again and redo it',
  },
  'missing-env': {
    'retry': 'Re-check the files',
    'waive': 'Capture only what exists',
  },
  'prd-source': {
    'continue': 'Use the docs I\'ve added',
    'collect-repo-docs': 'Collect docs from the repos',
    'infer-from-diff': 'Infer from the git diff',
  },
  'coverage-stuck': {
    'accept-partial': 'Accept this coverage',
    'retry': 'Try another pass',
  },
  // These protocol answers are sent by the agent that owns the hand-off. They
  // stay labelled for display-vocabulary completeness, but Flight Page does
  // not render them as buttons for the person monitoring the run.
  'external-work': {
    'submit': 'Submit the agent result',
    'run-internally': 'Run this step in Canary Lab',
  },
  // The wire key stays 'apply' (MCP/autopilot parity) but the ACTION is a save:
  // the verified diff is persisted as the feature's overlay — nothing lands in
  // the product repos; runs apply it into per-run worktrees at boot and reverse
  // it at teardown. Mirrors the wizard's "Save overlay" button so the same
  // The upfront ask, before any agent/double-boot cost is spent. Autopilot
  // answers 'run'; a human can bail here instead of 45 minutes later.
  'portify-gate': {
    'run': 'Yes — make it parallel-ready',
    'skip': 'Skip it (runs go one at a time)',
  },
  // decision reads the same everywhere. 'revise' sends feedback back to the
  // agent for another edit + re-verify pass (the checkpoint re-parks with the
  // new diff); 'cancel' discards the worktree edits and SKIPS the stage — the
  // flight proceeds without parallel readiness (declining is a decision, not
  // a failure; a later flight retries).
  'portify-apply': {
    'apply': 'Save the port changes',
    'revise': 'Request changes',
    'cancel': 'Skip it (throw the changes away)',
  },
  'run-failed': {
    'rerun': 'Start a new run',
    'export-as-is': 'Build the report anyway',
  },
  'export-mode': {
    'raw': 'Straight from the numbers (fast)',
    'localized': 'Written up by an agent (slower)',
  },
}

export function checkpointTitle(kind: string): string {
  return CHECKPOINT_TITLE[kind] ?? kind
}

export function checkpointOptionLabel(kind: string, option: string): string {
  return CHECKPOINT_OPTION_LABEL[kind]?.[option] ?? option
}

export function num(ev: Record<string, unknown>, key: string): number | null {
  return typeof ev[key] === 'number' ? (ev[key] as number) : null
}

export function str(ev: Record<string, unknown>, key: string): string | null {
  return typeof ev[key] === 'string' ? (ev[key] as string) : null
}

export function evidenceOf(stage: { evidence?: unknown } | undefined): Record<string, unknown> {
  return (stage?.evidence ?? {}) as Record<string, unknown>
}

/** Typed view of the specs-coverage loop's structured progress (R27) — the
 *  authoring↔mapping pass state the adapter publishes via FlightStage.progress.
 *  Null for other stages, older flights, or malformed payloads. */
export function specsCoverageProgress(
  stage: { key: string; progress?: unknown } | null | undefined,
): SpecsCoverageProgress | null {
  if (!stage || stage.key !== 'specs-coverage') return null
  const p = stage.progress as SpecsCoverageProgress | undefined
  return p && typeof p.pass === 'number' && typeof p.phase === 'string' && Array.isArray(p.passes) ? p : null
}

/** The portify workflow id, live or settled: evidence carries it once the
 *  stage settles; progress pins it the moment the workflow starts. The agent
 *  editing phase is the stage's longest — the embedded agent timeline needs
 *  the id DURING it; the drill-through uses the same pin once the stage
 *  settles or parks (drills are hidden while a stage runs). */
export function portifyWorkflowId(stage: { key: string; evidence?: unknown; progress?: unknown } | null | undefined): string | null {
  if (!stage || stage.key !== 'portify') return null
  const ev = evidenceOf(stage)
  if (typeof ev.workflowId === 'string') return ev.workflowId
  const prog = (stage.progress ?? {}) as Record<string, unknown>
  return typeof prog.workflowId === 'string' ? prog.workflowId : null
}

/** The live phase mirror the portify adapter republishes on change (see
 *  PortifyStageProgress). Empty object for settled/older flights. */
export function portifyProgress(stage: { progress?: unknown }): Record<string, unknown> {
  return (stage.progress ?? {}) as Record<string, unknown>
}

/** Fact-tile label per live portify phase (PortifyStatus, matched by string —
 *  an unknown/new phase renders as itself rather than hiding). */
export const PORTIFY_PHASE_LABEL: Record<string, string> = {
  'planning': 'Planning the edits',
  'editing': 'Agent editing services',
  'verifying': 'Double-boot verifying',
  'ready-to-save': 'Verified — review pending',
}

/** State-line sentence per live portify phase — same keys as the labels. */
export const PORTIFY_PHASE_LINE: Record<string, string> = {
  'planning': 'Working out which services need port changes…',
  'editing': 'Editing the services to take their port from settings…',
  'verifying': 'Starting two copies side by side to check…',
  'ready-to-save': 'Checks passed — getting the review ready…',
}
