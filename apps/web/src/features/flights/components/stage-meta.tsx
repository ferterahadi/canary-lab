import type { FlightManifest, FlightStage, FlightStageKey, FlightStageStatus } from '../../../shared/api/client'
import { StatusDot } from '../../config/components/atoms'

// One home for the flight-stage presentation vocabulary (R14/R16/R18): the
// user-facing stage labels, the status tone/icon treatment, the shared status
// chip every surface renders, and the per-stage state line ("where are we") the
// trailer column leads with. Stage KEYS stay canonical in the store/MCP/CLI —
// only the display layer speaks outcome language.

/** Stage key → what the stage does for the user (outcome, not implementation).
 *  similarity/scout/env-capture named per the R18 feedback table; scaffold and
 *  portify describe their verified function (create the feature in the
 *  workspace / make services port-injectable for concurrent runs). */
export const STAGE_LABEL: Record<FlightStageKey, string> = {
  'similarity': 'Duplicate check',
  'scout': 'Repo scan',
  'scaffold': 'Feature setup',
  'env-capture': 'Environment snapshot',
  'docs': 'Docs extraction',
  'prd-summary': 'Requirements summary',
  'specs-coverage': 'Coverage mapping',
  'portify': 'Parallel readiness',
  'run': 'Test run',
  'heal': 'Auto-repair',
  'evaluation-export': 'Export results',
}

export function stageLabel(key: string): string {
  return (STAGE_LABEL as Record<string, string>)[key] ?? key
}

/** The single status hue map — rail, chip, mini rail, and any artifact surface
 *  all read this so a colour means the same thing everywhere. */
export function stageStatusTone(status: FlightStageStatus | undefined): string {
  if (status === 'done') return 'rgb(52, 211, 153)'
  if (status === 'running') return 'rgb(56, 189, 248)'
  if (status === 'waiting-for-approval') return 'rgb(251, 191, 36)'
  if (status === 'failed') return 'var(--danger)'
  if (status === 'skipped') return 'color-mix(in srgb, rgb(52, 211, 153) 55%, var(--text-muted))'
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

const STAGE_STATUS_LABEL: Record<FlightStageStatus, string> = {
  'pending': 'pending',
  'running': 'generating',
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
    <span
      data-testid="stage-status-chip"
      className="inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{ color: tone, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}
    >
      {status === 'running'
        ? <StatusDot state="running" className="shrink-0" />
        : <span aria-hidden="true">{STAGE_ICON[status]}</span>}
      {STAGE_STATUS_LABEL[status]}
    </span>
  )
}

function num(ev: Record<string, unknown>, key: string): number | null {
  return typeof ev[key] === 'number' ? (ev[key] as number) : null
}
function str(ev: Record<string, unknown>, key: string): string | null {
  return typeof ev[key] === 'string' ? (ev[key] as string) : null
}

/** "Where are we" — one plain-language line per stage per status (R16 Q1).
 *  Folds the load-bearing evidence facts (scan count, coverage %, heal cycles)
 *  into the sentence; the raw evidence JSON stays behind the details
 *  disclosure. Never returns an empty string for a settled or running stage. */
export function stageStateLine(stage: FlightStage, flight: FlightManifest): string {
  const ev = (stage.evidence ?? {}) as Record<string, unknown>
  const { key, status } = stage

  if (status === 'pending') return 'Waiting for earlier stages.'
  if (status === 'waiting-for-approval') return stage.checkpoint?.message ?? 'Paused — your decision is needed below.'
  if (status === 'skipped') return stage.skipReason ?? 'Skipped.'
  if (status === 'failed') return 'Failed — details below.'

  const running = status === 'running'
  switch (key) {
    case 'similarity': {
      if (running) return 'Checking existing features for a duplicate…'
      const match = ev.match as Record<string, unknown> | null | undefined
      const scanned = num(ev, 'scanned')
      if (match && typeof match.feature === 'string') {
        const choice = str(ev, 'choice')
        return `Matched existing feature "${match.feature}"${choice ? ` — continuing as ${choice}` : ''}.`
      }
      return `No duplicate found${scanned != null ? ` (${scanned} feature${scanned === 1 ? '' : 's'} scanned)` : ''} — proceeding fresh.`
    }
    case 'scout':
      return running
        ? 'Agent is reading the repo to draft the feature config…'
        : 'Feature config drafted from the repo.'
    case 'scaffold':
      return running
        ? 'Creating the feature in the workspace…'
        : ev.reused
          ? `Feature "${flight.feature}" already existed — reused.`
          : `Feature "${flight.feature}" created in the workspace.`
    case 'env-capture': {
      if (running) return 'Capturing env files and boot-testing the config…'
      const captured = num(ev, 'captured')
      return `Environment captured${captured != null ? ` (${captured} file${captured === 1 ? '' : 's'})` : ''} — dry-run boot passed.`
    }
    case 'docs': {
      if (running) return 'Collecting requirement docs…'
      const docs = Array.isArray(ev.docs) ? ev.docs.length : null
      const source = str(ev, 'source')
      return `Requirement docs collected${docs != null ? ` (${docs})` : ''}${source ? ` from ${source}` : ''}.`
    }
    case 'prd-summary': {
      if (running) return 'Agent is distilling the docs into requirements…'
      const count = num(ev, 'requirementCount')
      return `Requirements summary ready${count != null ? ` — ${count} requirement${count === 1 ? '' : 's'}` : ''}.`
    }
    case 'specs-coverage': {
      const pct = num(ev, 'coveragePct')
      if (running) return 'Agent is authoring specs to close coverage gaps…'
      if (ev.acceptedPartial) return `Coverage accepted at ${pct ?? '?'}% (partial, per your call).`
      return `Coverage target met${pct != null ? ` — ${pct}%` : ''}.`
    }
    case 'portify':
      if (running) return 'Verifying the services boot concurrently (port injection)…'
      return ev.edits
        ? 'Services are port-injectable — edits applied and double-boot verified.'
        : 'Services are port-injectable — no edits needed, double-boot verified.'
    case 'run': {
      if (running) return 'Tests are running…'
      const runId = str(ev, 'runId') ?? flight.links?.runId
      const runStatus = str(ev, 'status') ?? flight.runVerdict
      return `Run ${runId ?? ''}${runStatus ? ` ${runStatus}` : ''}`.trim() + '.'
    }
    case 'heal': {
      if (running) return 'Repair agent is fixing the failure…'
      const cycles = num(ev, 'healCycles')
      const runStatus = str(ev, 'finalStatus') ?? str(ev, 'status') ?? flight.runVerdict
      if (cycles != null && cycles > 0) return `${cycles} repair cycle${cycles === 1 ? '' : 's'} — run ${runStatus ?? 'settled'}.`
      return `No repair needed — run ${runStatus ?? 'settled'}.`
    }
    case 'evaluation-export': {
      if (running) return 'Building the evaluation archive…'
      const zip = str(ev, 'evaluationZip') ?? flight.links?.evaluationZip
      return `Evaluation ready${zip ? ` — ${zip.split('/').pop() ?? ''}` : ''}.`
    }
    default:
      return running ? 'Working…' : 'Done.'
  }
}
