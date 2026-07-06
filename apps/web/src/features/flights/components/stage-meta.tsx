import type { FlightManifest, FlightStage, FlightStageKey, FlightStageStatus, SpecsCoverageProgress } from '../../../shared/api/client'
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
  'similarity': 'Existing feature found',
  'scout': 'Repo scan',
  'scaffold': 'Feature setup',
  'env-capture': 'Environment snapshot',
  'docs': 'Docs extraction',
  'prd-summary': 'Requirements summary',
  'specs-coverage': 'Test authoring & coverage',
  'portify': 'Parallel readiness',
  'run': 'Test run & auto-repair',
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
function evidenceOf(stage: { evidence?: unknown } | undefined): Record<string, unknown> {
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

// ─── Rail rows (R21/R22) ────────────────────────────────────────────────────
// The rail is a lens for the USER, not a dump of the conductor's internals:
// - similarity is plumbing — visible ONLY when it needs a human (parked on the
//   similarity-choice checkpoint) or failed; a silent pass/skip never shows.
// - run + heal are one step in the user's mental model ("run my tests, repair
//   what breaks") — merged into one row keyed `run`; the heal mirror's status
//   folds into it. Store/MCP/CLI keys are untouched.

export interface StageRailRow {
  key: FlightStageKey
  label: string
  status: FlightStageStatus
}

function mergedRunStatus(
  run: { status: FlightStageStatus } | undefined,
  heal: { status: FlightStageStatus } | undefined,
): FlightStageStatus {
  const r = run?.status ?? 'pending'
  const h = heal?.status ?? 'pending'
  if (r === 'running' || h === 'running') return 'running'
  if (r === 'waiting-for-approval' || h === 'waiting-for-approval') return 'waiting-for-approval'
  if (r === 'failed' || h === 'failed') return 'failed'
  return r
}

export function stageRailRows(
  stages: Array<{ key: string; status: FlightStageStatus }>,
): StageRailRow[] {
  const rows: StageRailRow[] = []
  for (const s of stages) {
    const key = s.key as FlightStageKey
    if (key === 'similarity') {
      if (s.status !== 'waiting-for-approval' && s.status !== 'failed') continue
      rows.push({ key, label: s.status === 'failed' ? 'Pre-flight check' : STAGE_LABEL.similarity, status: s.status })
      continue
    }
    if (key === 'heal') continue // folded into the run row
    if (key === 'run') {
      const heal = stages.find((x) => x.key === 'heal')
      rows.push({ key, label: STAGE_LABEL.run, status: mergedRunStatus(s, heal) })
      continue
    }
    rows.push({ key, label: stageLabel(key), status: s.status })
  }
  return rows
}

// ─── Stage facts (R20) ──────────────────────────────────────────────────────
// One uniform template for every stage: the 2–4 things the user cares about at
// that stage, as label→value rows. Everything else is the details disclosure
// or the drill-through page's job.

export interface StageFact {
  label: string
  value: string
  tone?: 'good' | 'warn' | 'bad'
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function stageFacts(
  stage: FlightStage,
  flight: FlightManifest,
  heal?: FlightStage,
): StageFact[] {
  const ev = evidenceOf(stage)
  if (stage.status === 'pending') return []
  switch (stage.key) {
    case 'similarity': {
      const match = ev.match as Record<string, unknown> | null | undefined
      return match && typeof match.feature === 'string'
        ? [{ label: 'Matches', value: match.feature }]
        : []
    }
    case 'scout': {
      const envFiles = Array.isArray((ev as { envFiles?: unknown }).envFiles) ? (ev.envFiles as unknown[]).length : null
      return [
        { label: 'Repos', value: plural(flight.repoPaths.length, 'repo') },
        ...(envFiles != null ? [{ label: 'Env files', value: String(envFiles) }] : []),
      ]
    }
    case 'scaffold': {
      const dir = str(ev, 'featureDir')
      return [
        { label: 'Feature', value: flight.feature },
        ...(ev.reused ? [{ label: 'Setup', value: 'Reused existing', tone: 'good' as const }] : []),
        ...(dir ? [{ label: 'Location', value: dir.split('/').slice(-2).join('/') }] : []),
      ]
    }
    case 'env-capture': {
      const captured = num(ev, 'captured')
      const boot = ev.boot as { services?: Array<{ name?: string; status?: string }> } | undefined
      const services = boot?.services ?? []
      const failed = services.filter((s) => s.status === 'timeout')
      return [
        ...(captured != null ? [{ label: 'Env files', value: plural(captured, 'file') }] : []),
        ...(services.length > 0
          ? [{
              label: 'Boot check',
              value: failed.length === 0
                ? `${services.map((s) => s.name).filter(Boolean).join(', ')} healthy`
                : `${failed.map((s) => s.name).filter(Boolean).join(', ')} failed`,
              tone: failed.length === 0 ? 'good' as const : 'bad' as const,
            }]
          : []),
      ]
    }
    case 'docs': {
      const docs = Array.isArray(ev.docs) ? (ev.docs as unknown[]).length : null
      const source = str(ev, 'source')
      return [
        ...(docs != null ? [{ label: 'Docs', value: String(docs) }] : []),
        ...(source ? [{ label: 'Source', value: source }] : []),
      ]
    }
    case 'prd-summary': {
      const count = num(ev, 'requirementCount')
      return count != null ? [{ label: 'Requirements', value: String(count) }] : []
    }
    case 'specs-coverage': {
      const p = specsCoverageProgress(stage)
      // Evidence lands when the stage settles; while the loop runs the same
      // facts come from the live progress shape.
      const pct = num(ev, 'coveragePct') ?? p?.coveragePct ?? null
      const gaps = Array.isArray(ev.gaps) ? (ev.gaps as unknown[]).length : p?.gapsOpen ?? null
      return [
        ...(stage.status === 'running' && p ? [{ label: 'Pass', value: `${p.pass} of ${p.maxPasses}` }] : []),
        ...(pct != null ? [{ label: 'Coverage', value: `${pct}%`, tone: pct >= flight.opts.coverageTarget ? 'good' as const : 'warn' as const }] : []),
        ...(gaps != null ? [{ label: 'Open gaps', value: String(gaps), tone: gaps === 0 ? 'good' as const : 'warn' as const }] : []),
        ...(stage.status !== 'running' && p && p.passes.length > 0 ? [{ label: 'Passes', value: String(p.passes.length) }] : []),
      ]
    }
    case 'portify':
      if (stage.status === 'skipped') return [{ label: 'Ports', value: 'Already verified', tone: 'good' }]
      if (typeof ev.workflowId !== 'string') return []
      return [
        { label: 'Ports', value: 'Injectable — parallel runs safe', tone: 'good' },
        { label: 'Edits', value: ev.edits ? 'Applied (overlay)' : 'None needed' },
      ]
    case 'run': {
      const runStatus = str(ev, 'status') ?? flight.runVerdict
      const healEv = evidenceOf(heal)
      const cycles = num(ev, 'healCycles') ?? num(healEv, 'healCycles')
      const healMode = str(healEv, 'healMode')
      return [
        ...(runStatus ? [{ label: 'Verdict', value: runStatus, tone: runStatus === 'passed' ? 'good' as const : 'bad' as const }] : []),
        ...(cycles != null ? [{ label: 'Repairs', value: cycles === 0 ? 'None needed' : plural(cycles, 'cycle'), tone: cycles === 0 ? 'good' as const : undefined }] : []),
        ...(healMode ? [{ label: 'Repair agent', value: healMode === 'external' ? 'External client' : 'Canary (this server)' }] : []),
      ]
    }
    case 'evaluation-export': {
      const zip = str(ev, 'evaluationZip') ?? flight.links?.evaluationZip
      return zip ? [{ label: 'Archive', value: zip.split('/').pop() ?? zip }] : []
    }
    default:
      return []
  }
}

const FACT_TONE: Record<NonNullable<StageFact['tone']>, string> = {
  good: 'rgb(52, 211, 153)',
  warn: 'rgb(251, 191, 36)',
  bad: 'var(--danger)',
}

/** The one facts renderer every stage uses (R20): quiet label → value rows. */
export function FactsGrid({ facts }: { facts: StageFact[] }) {
  if (facts.length === 0) return null
  return (
    <dl data-testid="stage-facts" className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1">
      {facts.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{f.label}</dt>
          <dd className="m-0 truncate text-[12px]" title={f.value} style={{ color: f.tone ? FACT_TONE[f.tone] : 'var(--text-primary)' }}>{f.value}</dd>
        </div>
      ))}
    </dl>
  )
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
      if (running) {
        // The loop's live sub-phase (R27): which half of author↔map is
        // happening, and which pass we're on. Older flights have no
        // progress shape — fall back to the generic line.
        const p = specsCoverageProgress(stage)
        if (p) {
          const doing =
            p.phase === 'authoring'
              ? `agent is authoring specs to close ${p.gapsOpen} gap${p.gapsOpen === 1 ? '' : 's'}`
              : p.phase === 'validating'
                ? 'validating the authored specs (compile + list)'
                : 'mapping the specs against the requirements'
          return `Pass ${p.pass} of ${p.maxPasses} — ${doing}…`
        }
        return 'Agent is authoring specs to close coverage gaps…'
      }
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
