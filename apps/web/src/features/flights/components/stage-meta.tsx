import type { FlightManifest, FlightStage, FlightStageKey, FlightStageStatus, SpecsCoverageProgress } from '../../../shared/api/client'
import { StatusDot } from '../../config/components/atoms'
import { Chip } from '../../../shared/ui/StatusChip'

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
  'scaffold': 'Suite setup',
  'env-capture': 'Environment snapshot',
  'docs': 'Docs extraction',
  'prd-summary': 'Requirements summary',
  'specs-coverage': 'Test authoring & coverage',
  'portify': 'Parallel readiness',
  'run': 'Test Run',
  'heal': 'Auto-repair',
  'evaluation-export': 'Evaluation Report',
}

export function stageLabel(key: string): string {
  return (STAGE_LABEL as Record<string, string>)[key] ?? key
}

/** One-line "what this stage does", in plain language — shown in the flight
 *  launcher's full-flight preview so the pipeline explains itself, instead of
 *  every locked row repeating the same "unlocks after the first flight" note
 *  (that lock is stated once, on the section header). */
export const STAGE_BLURB: Record<FlightStageKey, string> = {
  'similarity': 'Runs every step below, start to finish.',
  'scout': 'Scans your repo to learn its stack, structure, and how it boots.',
  'scaffold': 'Creates the test suite in your workspace with a config and boot command.',
  'env-capture': 'Captures the environment variables the app needs to start.',
  'docs': 'Gathers the requirement docs (PRD, specs) that describe the feature.',
  'prd-summary': 'Distills those docs into a short, testable requirements summary.',
  'specs-coverage': 'Writes Playwright tests and maps them to requirements until covered.',
  'portify': 'Makes services read their ports from env so runs can go concurrent.',
  'run': 'Boots the app and runs the test suite, repairing failures as they surface.',
  'heal': 'Fixes failing tests by editing app code, then reruns.',
  'evaluation-export': 'Packages the finished run into a scored, downloadable report.',
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
    <Chip
      testId="stage-status-chip"
      chrome="border"
      tone={tone}
      icon={status === 'running'
        ? <StatusDot state="running" className="shrink-0" />
        : <span aria-hidden="true">{STAGE_ICON[status]}</span>}
      label={STAGE_STATUS_LABEL[status]}
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
  'similarity-choice': 'Existing feature found — what should this flight do?',
  'config-approval': 'Approve the drafted config?',
  'missing-env': 'Environment values needed',
  'prd-source': 'Where should requirements come from?',
  'coverage-stuck': 'Coverage stopped short of the target',
  'portify-apply': 'Apply the parallel-readiness edits?',
  'run-failed': 'The test run did not pass',
  'export-mode': 'How should the report be built?',
}

const CHECKPOINT_OPTION_LABEL: Record<string, Record<string, string>> = {
  'similarity-choice': {
    'rerun': 'Run existing tests',
    'enhance': 'Update it, then run',
    'new': 'Start a fresh feature',
  },
  'config-approval': {
    'approve': 'Approve config',
    'redraft': 'Redraft from a fresh scan',
  },
  'missing-env': {
    'retry': 'Re-check the files',
    'waive': 'Capture only what exists',
  },
  'prd-source': {
    'continue': 'Use the docs present',
    'use-repo-docs': 'Copy repo docs in',
    'infer-from-diff': 'Infer from git diff',
    'description-only': 'From the intent alone',
    'retry': 'Re-check docs',
  },
  'coverage-stuck': {
    'accept-partial': 'Accept current coverage',
    'retry': 'Try another round of passes',
  },
  'portify-apply': {
    'apply': 'Apply the edits',
    'cancel': 'Reject them (stage fails)',
  },
  'run-failed': {
    'rerun': 'Start a new run',
    'export-as-is': 'Export the report as-is',
  },
  'export-mode': {
    'raw': 'Fast report from evidence',
    'localized': 'Agent-rewritten reasoning (slower)',
  },
}

export function checkpointTitle(kind: string): string {
  return CHECKPOINT_TITLE[kind] ?? kind
}

export function checkpointOptionLabel(kind: string, option: string): string {
  return CHECKPOINT_OPTION_LABEL[kind]?.[option] ?? option
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

// ─── Rail rows (R21/R22/R32/R33) ────────────────────────────────────────────
// The rail is a lens for the USER, not a dump of the conductor's internals:
// - similarity is plumbing — visible ONLY when it needs a human (parked on the
//   similarity-choice checkpoint) or failed; a silent pass/skip never shows.
// - three stage PAIRS are one step in the user's mental model and merge into
//   one row keyed by the pair's first stage; the companion's status folds in.
//   Store/MCP/CLI keys are untouched:
//     run + heal          → "Test Run"       (run my tests, repair what breaks)
//     scaffold + env-capture → "Feature setup" (create it, prove it boots)
//     docs + prd-summary  → "Requirements"   (collect docs, distill them)

export interface StageRailRow {
  key: FlightStageKey
  label: string
  status: FlightStageStatus
}

/** Pair-merged rail rows: row key → the companion stage folded into it. The
 *  companion never gets its own row; its status/evidence/checkpoint surface
 *  through the pair (StageDetail reads it via this map too). */
export const STAGE_COMPANION: Partial<Record<FlightStageKey, FlightStageKey>> = {
  'run': 'heal',
  'scaffold': 'env-capture',
  'docs': 'prd-summary',
}
const FOLDED_KEYS = new Set<string>(Object.values(STAGE_COMPANION))

/** Merged label where the pair reads as one outcome the individual stage
 *  labels don't cover (the stage-entry menu still names each stage alone). */
const MERGED_LABEL: Partial<Record<FlightStageKey, string>> = {
  'scaffold': 'Suite setup',
  'docs': 'Requirements',
}

function mergedPairStatus(
  primary: { status: FlightStageStatus } | undefined,
  companion: { status: FlightStageStatus } | undefined,
): FlightStageStatus {
  const p = primary?.status ?? 'pending'
  const c = companion?.status ?? 'pending'
  if (p === 'running' || c === 'running') return 'running'
  if (p === 'waiting-for-approval' || c === 'waiting-for-approval') return 'waiting-for-approval'
  if (p === 'failed' || c === 'failed') return 'failed'
  return p
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
    if (FOLDED_KEYS.has(key)) continue // folded into its pair row
    const companionKey = STAGE_COMPANION[key]
    if (companionKey) {
      const companion = stages.find((x) => x.key === companionKey)
      rows.push({ key, label: MERGED_LABEL[key] ?? stageLabel(key), status: mergedPairStatus(s, companion) })
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
  /** Render the value in the mono face (paths, filenames, commands). */
  mono?: boolean
  /** Hover detail when the visible value is a shortened form (e.g. a path). */
  title?: string
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Boot-proof fact from the env-capture evidence (rendered on the merged
 *  Feature setup row — R32). */
function bootCheckFacts(envEv: Record<string, unknown>): StageFact[] {
  const captured = num(envEv, 'captured')
  const boot = envEv.boot as { services?: Array<{ name?: string; status?: string }> } | undefined
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

const MAX_LIST_FACTS = 5

export function stageFacts(
  stage: FlightStage,
  flight: FlightManifest,
  companion?: FlightStage,
): StageFact[] {
  const ev = evidenceOf(stage)
  const cev = evidenceOf(companion)
  if (stage.status === 'pending') return []
  switch (stage.key) {
    case 'similarity': {
      const match = ev.match as Record<string, unknown> | null | undefined
      return match && typeof match.feature === 'string'
        ? [{ label: 'Matches', value: match.feature }]
        : []
    }
    case 'scout':
      // R72c: everything the scan surfaces is per-repo and lives on the
      // RepoScanPanel's cards (name · location · env files) under the one
      // global intent — no facts left at the stage level.
      return []
    case 'scaffold': {
      // R32: the merged Feature setup row — the env/boot proof from the folded
      // env-capture companion. The suite name is NOT a fact here: it already
      // reads in the breadcrumb and the state line. The config digest (run
      // command, ports, Playwright) renders beside these from the live config.
      const dir = str(ev, 'featureDir')
      return [
        ...(ev.reused ? [{ label: 'Setup', value: 'Reused existing', tone: 'good' as const }] : []),
        ...(dir ? [{ label: 'Location', value: dir.split('/').slice(-2).join('/'), mono: true, title: dir }] : []),
        ...bootCheckFacts(cev),
      ]
    }
    case 'env-capture':
      // Folded into the scaffold row (R32); kept for completeness if a caller
      // renders the stage standalone.
      return bootCheckFacts(ev)
    case 'docs': {
      // R33: the merged Requirements row — the collected docs by name (path on
      // hover), the source rung, and the distilled requirement count from the
      // folded prd-summary companion.
      const docs = Array.isArray(ev.docs) ? (ev.docs as unknown[]).filter((d): d is string => typeof d === 'string') : []
      const source = str(ev, 'source')
      const count = num(cev, 'requirementCount')
      const shown = docs.slice(0, MAX_LIST_FACTS)
      return [
        ...shown.map((d, i) => ({
          label: docs.length === 1 ? 'Doc' : `Doc ${i + 1}`,
          value: d,
          mono: true,
          title: `features/${flight.feature}/docs/${d}`,
        })),
        ...(docs.length > shown.length ? [{ label: ' ', value: `+${docs.length - shown.length} more` }] : []),
        ...(source ? [{ label: 'Source', value: source }] : []),
        ...(count != null ? [{ label: 'Requirements', value: String(count) }] : []),
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
      const gapRows = Array.isArray(ev.gaps) ? (ev.gaps as Array<{ gap?: string }>) : null
      const gaps = gapRows ? gapRows.length : p?.gapsOpen ?? null
      // R35: name the gap kinds, not just the count ("2 untested, 1 path-incomplete").
      const byKind = new Map<string, number>()
      for (const g of gapRows ?? []) {
        if (typeof g.gap === 'string') byKind.set(g.gap, (byKind.get(g.gap) ?? 0) + 1)
      }
      const breakdown = [...byKind].map(([kind, n]) => `${n} ${kind}`).join(', ')
      return [
        ...(stage.status === 'running' && p ? [{ label: 'Pass', value: `${p.pass} of ${p.maxPasses}` }] : []),
        ...(pct != null ? [{ label: 'Coverage', value: `${pct}%`, tone: pct >= flight.opts.coverageTarget ? 'good' as const : 'warn' as const }] : []),
        ...(gaps != null
          ? [{
              label: 'Open gaps',
              value: gaps === 0 ? '0' : breakdown ? `${gaps} — ${breakdown}` : String(gaps),
              tone: gaps === 0 ? 'good' as const : 'warn' as const,
            }]
          : []),
        ...(stage.status !== 'running' && p && p.passes.length > 0 ? [{ label: 'Passes', value: String(p.passes.length) }] : []),
      ]
    }
    case 'portify':
      // R35: verdict → proof → what changed, in that order.
      if (stage.status === 'skipped') return [{ label: 'Parallel', value: 'Already verified — safe for parallel runs', tone: 'good' }]
      if (typeof ev.workflowId !== 'string') return []
      return [
        { label: 'Parallel', value: 'Safe — services boot side by side', tone: 'good' },
        { label: 'Proof', value: 'Concurrent double boot, both green' },
        { label: 'Edits', value: ev.edits ? 'Applied (overlay)' : 'None needed' },
      ]
    case 'run': {
      const runStatus = str(ev, 'status') ?? flight.runVerdict
      const cycles = num(ev, 'healCycles') ?? num(cev, 'healCycles')
      const healMode = str(cev, 'healMode')
      return [
        ...(runStatus ? [{ label: 'Verdict', value: runStatus, tone: runStatus === 'passed' ? 'good' as const : 'bad' as const }] : []),
        ...(cycles != null ? [{ label: 'Repairs', value: cycles === 0 ? 'None needed' : plural(cycles, 'cycle'), tone: cycles === 0 ? 'good' as const : undefined }] : []),
        ...(healMode ? [{ label: 'Repair agent', value: healMode === 'external' ? 'External client' : 'Canary (this server)' }] : []),
      ]
    }
    case 'evaluation-export': {
      const zip = str(ev, 'evaluationZip') ?? flight.links?.evaluationZip
      return zip ? [{ label: 'Archive', value: zip.split('/').pop() ?? zip, mono: true, title: zip }] : []
    }
    default:
      return []
  }
}

/** Compact wall-clock duration between two ISO stamps ("4s", "2m 14s",
 *  "1h 03m") — the rail rows and the summary strip both render it (R61). */
export function formatDuration(startedAt?: string, endedAt?: string): string | null {
  if (!startedAt || !endedAt) return null
  const ms = Date.parse(endedAt) - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
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
      {facts.map((f, i) => (
        <div key={`${f.label}-${i}`} className="contents">
          <dt className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{f.label}</dt>
          <dd
            className="m-0 truncate text-[12px]"
            title={f.title ?? f.value}
            style={{
              color: f.tone ? FACT_TONE[f.tone] : 'var(--text-primary)',
              ...(f.mono ? { fontFamily: 'var(--font-mono)', fontSize: 11.5 } : {}),
            }}
          >
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** "Where are we" — one plain-language line per stage per status (R16 Q1).
 *  Folds the load-bearing evidence facts (scan count, coverage %, heal cycles)
 *  into the sentence; the raw evidence stays in the facts and the log. Never
 *  returns an empty string for a settled or running stage.
 *
 *  For a merged pair row (R22/R32/R33) pass the companion: while the companion
 *  is the active/blocking half its line speaks ("Repair agent is fixing…",
 *  "Capturing env files…"); once both settle the pair gets one combined line. */
export function stageStateLine(stage: FlightStage, flight: FlightManifest, companion?: FlightStage): string {
  const ev = (stage.evidence ?? {}) as Record<string, unknown>
  const { key, status } = stage

  // The companion is the half that needs narrating right now.
  if (companion && (companion.status === 'running' || companion.status === 'waiting-for-approval' || companion.status === 'failed')) {
    return stageStateLine(companion, flight)
  }
  const companionDone = companion?.status === 'done'

  if (status === 'pending') return 'Waiting for earlier stages.'
  if (status === 'waiting-for-approval') return stage.checkpoint?.message ?? 'Paused — your decision is needed below.'
  if (status === 'skipped') return stage.skipReason ?? 'Skipped.'
  if (status === 'failed') return 'Failed — details below.'

  // Pair-settled combined lines (R32/R33): one sentence for the whole step.
  if (companionDone && key === 'scaffold') {
    const cev = (companion?.evidence ?? {}) as Record<string, unknown>
    const captured = num(cev, 'captured')
    const verb = ev.reused ? 'reused' : 'created'
    return `Suite "${flight.feature}" ${verb} — env captured${captured != null ? ` (${captured} file${captured === 1 ? '' : 's'})` : ''}, dry-run boot passed.`
  }
  if (companionDone && key === 'docs') {
    const cev = (companion?.evidence ?? {}) as Record<string, unknown>
    const count = num(cev, 'requirementCount')
    const docs = Array.isArray(ev.docs) ? ev.docs.length : null
    const source = str(ev, 'source')
    return `${count != null ? `${count} requirement${count === 1 ? '' : 's'}` : 'Requirements'} distilled${docs != null ? ` from ${docs} doc${docs === 1 ? '' : 's'}` : ''}${source ? ` (${source})` : ''}.`
  }

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
    case 'scout': {
      const repos = flight.repoPaths.length
      const envFiles = Array.isArray(ev.envFiles) ? ev.envFiles.length : 0
      return running
        ? `Inspecting ${plural(repos, 'repo')} to learn how it boots and which environment files it uses…`
        : `Scanned ${plural(repos, 'repo')} — suite configuration drafted, ${plural(envFiles, 'environment file')} detected.`
    }
    case 'scaffold':
      return running
        ? 'Creating the suite in the workspace…'
        : ev.reused
          ? `Suite "${flight.feature}" already existed — reused.`
          : `Suite "${flight.feature}" created in the workspace.`
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
