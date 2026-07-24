import type { FlightManifest, FlightStage, FlightStageKey, FlightStageStatus, PrdSourceCheckpointData, SpecsCoverageProgress } from '../../../shared/api/client'
import type { HealEnd } from '../../../shared/api/types'
import { StatusDot } from '../../config/components/atoms'
import { Chip } from '../../../shared/ui/StatusChip'
import { PanelCard } from '../../../shared/ui/PanelCard'

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
  'similarity': 'Existing suite found',
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
      chrome="fill"
      tone={tone}
      fontSize={10}
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
  'similarity-choice': 'Existing suite found — what should this flight do?',
  'config-approval': 'Approve the drafted config?',
  'missing-env': 'Environment values needed',
  'prd-source': 'Where should requirements come from?',
  'coverage-stuck': 'Coverage stopped short of the target',
  'portify-gate': 'Run parallel readiness?',
  'portify-apply': 'Save the parallel-readiness overlay?',
  'run-failed': 'The test run did not pass',
  'export-mode': 'How should the report be built?',
}

const CHECKPOINT_OPTION_LABEL: Record<string, Record<string, string>> = {
  'similarity-choice': {
    'rerun': 'Run existing tests',
    'enhance': 'Update it, then run',
    'new': 'Start a fresh suite',
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
    'collect-repo-docs': 'Collect docs from the repos',
    'infer-from-diff': 'Infer from the git diff',
  },
  'coverage-stuck': {
    'accept-partial': 'Accept current coverage',
    'retry': 'Try another round of passes',
  },
  // The wire key stays 'apply' (MCP/autopilot parity) but the ACTION is a save:
  // the verified diff is persisted as the feature's overlay — nothing lands in
  // the product repos; runs apply it into per-run worktrees at boot and reverse
  // it at teardown. Mirrors the wizard's "Save overlay" button so the same
  // The upfront ask, before any agent/double-boot cost is spent. Autopilot
  // answers 'run'; a human can bail here instead of 45 minutes later.
  'portify-gate': {
    'run': 'Make it parallel-ready',
    'skip': 'Skip parallel readiness (stay serial)',
  },
  // decision reads the same everywhere. 'revise' sends feedback back to the
  // agent for another edit + re-verify pass (the checkpoint re-parks with the
  // new diff); 'cancel' discards the worktree edits and SKIPS the stage — the
  // flight proceeds without parallel readiness (declining is a decision, not
  // a failure; a later flight retries).
  'portify-apply': {
    'apply': 'Save the overlay',
    'revise': 'Request changes',
    'cancel': 'Skip parallel readiness (discard the edits)',
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
function portifyProgress(stage: { progress?: unknown }): Record<string, unknown> {
  return (stage.progress ?? {}) as Record<string, unknown>
}

/** Fact-tile label per live portify phase (PortifyStatus, matched by string —
 *  an unknown/new phase renders as itself rather than hiding). */
const PORTIFY_PHASE_LABEL: Record<string, string> = {
  'planning': 'Planning the edits',
  'editing': 'Agent editing services',
  'verifying': 'Double-boot verifying',
  'ready-to-save': 'Verified — review pending',
}

/** State-line sentence per live portify phase — same keys as the labels. */
const PORTIFY_PHASE_LINE: Record<string, string> = {
  'planning': 'Planning which services need port-injection edits…',
  'editing': 'Agent is editing the services to read injected ports…',
  'verifying': 'Double-boot verifying the edits (two instances side by side)…',
  'ready-to-save': 'Edits double-boot verified — preparing the review…',
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
  /** Short qualifier shown beside the label — currently "empty" when a stage
   *  is parked because its agent came back with nothing. `waiting-for-approval`
   *  alone can't distinguish "your turn to choose" from "your turn because the
   *  agent found nothing", and those want different urgency from the rail. */
  note?: string
}

/** Pair-merged rail rows: row key → the companion stage folded into it. The
 *  companion never gets its own row; its status/evidence/checkpoint surface
 *  through the pair (StageDetail reads it via this map too). */
export const STAGE_COMPANION: Partial<Record<FlightStageKey, FlightStageKey>> = {
  'run': 'heal',
  'scaffold': 'env-capture',
  'docs': 'prd-summary',
}

/** The rail row `key` renders in — a folded companion maps back to its
 *  primary, every other stage is its own row. Anything that names a stage to
 *  the user (the resume target, a jump label) must go through this: naming the
 *  raw stage key would surface `prd-summary`, a row the rail never shows. */
export function stageRowKey(key: FlightStageKey): FlightStageKey {
  const primary = (Object.keys(STAGE_COMPANION) as FlightStageKey[]).find(
    (k) => STAGE_COMPANION[k] === key,
  )
  return primary ?? key
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
  // R78: a merged row is done only when BOTH halves have settled. Reporting the
  // primary alone marked Requirements ✓ done while its summary distiller had
  // not run at all (docs approved, flight paused before prd-summary) — the row
  // claimed a step was finished that the conductor will still re-enter. The
  // unsettled half wins, so the row reads exactly as far as it actually got.
  const settled = (s: FlightStageStatus) => s === 'done' || s === 'skipped'
  return settled(p) && !settled(c) ? c : p
}

/** "empty" when this stage is parked on a collector attempt that found
 *  nothing. Reads the same `lastAttempt` the fork panel uses, so the rail and
 *  the panel can never disagree. */
function stageRailNote(stage: { key: string; checkpoint?: { data?: unknown } }): string | undefined {
  if (stage.key !== 'docs') return undefined
  const data = stage.checkpoint?.data as PrdSourceCheckpointData | undefined
  return data?.lastAttempt ? 'empty' : undefined
}

export function stageRailRows(
  stages: Array<{ key: string; status: FlightStageStatus; checkpoint?: { data?: unknown } }>,
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
      // `docs` reaches the rail through here, not the plain branch below — it
      // is the primary of the docs+prd-summary pair ("Requirements").
      rows.push({
        key,
        label: MERGED_LABEL[key] ?? stageLabel(key),
        status: mergedPairStatus(s, companion),
        note: stageRailNote(s),
      })
      continue
    }
    rows.push({ key, label: stageLabel(key), status: s.status, note: stageRailNote(s) })
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
  /** Render the value as a large metric number. Numeric/scalar facts only —
   *  sentence and path values stay in the quiet body size. */
  big?: boolean
  /** A segmented stepper under a `big` value: `[current, total]` (pass N of M). */
  stepper?: [number, number]
  /** A 0–1 progress bar under a `big` value (fraction toward the target). */
  bar?: number
  /** A quiet secondary line under a `big` value (e.g. the gap-kind breakdown). */
  sub?: string
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
      ? [(() => {
          // A many-service stack summarizes to a count (names ride the
          // tooltip) — 20 comma-joined names is a wall, not a fact.
          const names = (list: typeof services) => list.map((s) => s.name).filter(Boolean)
          const ok = failed.length === 0
          const subject = ok ? services : failed
          const label = names(subject).length <= 3
            ? names(subject).join(', ')
            : `${subject.length} services`
          return {
            label: 'Boot check',
            value: `${label} ${ok ? 'healthy' : 'failed'}`,
            title: `${names(subject).join(', ')} ${ok ? 'healthy' : 'failed'}`,
            tone: ok ? 'good' as const : 'bad' as const,
          }
        })()]
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
      const breakdown = [...byKind].map(([kind, n]) => `${n} ${kind}`).join(' · ')
      const target = flight.opts.coverageTarget
      return [
        // Pass N of M — the big number carries the stepper so "3 passes still to
        // go" reads at a glance instead of being inferred from "2 of 5".
        ...(stage.status === 'running' && p
          ? [{
              label: 'Authoring pass',
              value: String(p.pass),
              big: true as const,
              ...(Number.isFinite(p.maxPasses) ? { stepper: [p.pass, p.maxPasses] as [number, number] } : {}),
            }]
          : []),
        ...(pct != null
          ? [{
              label: 'Requirements covered',
              value: `${pct}%`,
              big: true as const,
              bar: target > 0 ? pct / target : pct >= 100 ? 1 : 0,
              tone: pct >= target ? 'good' as const : 'warn' as const,
            }]
          : []),
        ...(gaps != null
          ? [{
              label: 'Coverage gaps',
              value: gaps === 0 ? '0' : String(gaps),
              big: true as const,
              ...(breakdown && gaps > 0 ? { sub: breakdown } : {}),
              tone: gaps === 0 ? 'good' as const : 'warn' as const,
            }]
          : []),
        ...(stage.status !== 'running' && p && p.passes.length > 0 ? [{ label: 'Authoring passes', value: String(p.passes.length), big: true as const }] : []),
      ]
    }
    case 'portify': {
      // R35: verdict → proof → what changed, in that order.
      if (stage.status === 'skipped') return [{ label: 'Parallel', value: 'Already verified — safe for parallel runs', tone: 'good' }]
      if (stage.status === 'running') {
        // Live phase mirror from the workflow (attempt stepper + phase verb) —
        // the embedded agent timeline below carries the detail.
        const prog = portifyProgress(stage)
        const attempt = num(prog, 'attempt')
        const maxAttempts = num(prog, 'maxAttempts')
        const phase = str(prog, 'status')
        return [
          ...(attempt != null && maxAttempts != null
            ? [{ label: 'Attempt', value: String(attempt), big: true as const, stepper: [attempt, maxAttempts] as [number, number] }]
            : []),
          ...(phase ? [{ label: 'Phase', value: PORTIFY_PHASE_LABEL[phase] ?? phase }] : []),
        ]
      }
      if (typeof ev.workflowId !== 'string') return []
      return [
        { label: 'Parallel', value: 'Safe — services boot side by side', tone: 'good' },
        { label: 'Proof', value: 'Concurrent double boot, both green' },
        { label: 'Edits', value: ev.edits ? 'Applied (overlay)' : 'None needed' },
      ]
    }
    case 'run':
      // R80: the run is rendered ONCE, as the Test Run hero (TestRunPanel) — it
      // owns the verdict, pass count, repairs, services and give-up reason as a
      // single object. Emitting stage facts here too would print the same
      // numbers a second time in the "At a glance" card above the hero, which is
      // exactly the duplication the hero replaced. So: no stage-level facts.
      return []
    case 'evaluation-export': {
      const zip = str(ev, 'evaluationZip') ?? flight.links?.evaluationZip
      return zip ? [{ label: 'Archive', value: zip.split('/').pop() ?? zip, mono: true, title: zip }] : []
    }
    default:
      return []
  }
}

// ─── Auto-repair give-up reason (R80) ───────────────────────────────────────
// The manifest's typed `healEnd` (from the run orchestrator) → plain language.
// The server already writes a `message`, so the full line prefers it and only
// composes a fallback for older manifests; the short form is for the Repairs
// tile's `sub`, where a whole sentence won't fit.

const HEAL_CAUSE_PHRASE: Record<NonNullable<HealEnd['agentCause']>, string> = {
  'usage-limit': 'usage limit',
  'auth': 'not signed in',
  'rate-limit': 'rate-limited',
  'crash': 'agent crashed',
  'unknown': '',
}

/** Full plain-language sentence for why auto-repair stopped — the hero's
 *  decision-footer "why" line. Null when the run never entered heal. */
export function healEndLine(healEnd: HealEnd | undefined): string | null {
  if (!healEnd) return null
  if (healEnd.message) return healEnd.message
  switch (healEnd.reason) {
    case 'no-signal': {
      const cause = HEAL_CAUSE_PHRASE[healEnd.agentCause ?? 'unknown']
      return `Auto-repair stopped: the repair agent went quiet without a fix${cause ? ` — ${cause}` : ''}.`
    }
    case 'max-cycles': return 'Auto-repair stopped after reaching the repair-cycle limit without passing.'
    case 'no-progress': return 'Auto-repair stopped: repeated attempts made no progress.'
    case 'spawn-failed': return 'Auto-repair stopped: the repair agent failed to start.'
    case 'cancelled': return 'Auto-repair was stopped before the suite passed.'
    default: return null
  }
}

/** Short form for the Repairs tile's secondary line. Null when the run passed
 *  cleanly (no give-up) or never entered heal. */
export function healEndShort(healEnd: HealEnd | undefined): string | null {
  if (!healEnd) return null
  switch (healEnd.reason) {
    case 'no-signal':
      return healEnd.agentCause && healEnd.agentCause !== 'unknown'
        ? `stopped — ${HEAL_CAUSE_PHRASE[healEnd.agentCause]}`
        : 'stopped — agent went quiet'
    case 'max-cycles': return 'stopped — cycle limit'
    case 'no-progress': return 'stopped — no progress'
    case 'spawn-failed': return 'stopped — agent failed to start'
    case 'cancelled': return 'stopped by you'
    default: return null
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
  good: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--danger)',
}

/** A segmented pass stepper under a `big` value: done segments quiet, the
 *  current one lit sky, the rest hairline — so the remaining passes are visible
 *  as empty track, not inferred from the number. */
function FactStepper({ current, total }: { current: number; total: number }) {
  return (
    <div className="mt-2 flex gap-1" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className="h-[3px] flex-1 rounded-full"
          style={{
            background:
              i < current - 1 ? 'var(--text-secondary)' : i === current - 1 ? 'var(--accent-strong)' : 'var(--border-strong)',
          }}
        />
      ))}
    </div>
  )
}

/** A thin progress bar under a `big` value — coverage filling toward target. */
function FactBar({ frac, color }: { frac: number; color: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * 100
  return (
    <div className="mt-2 h-[3px] overflow-hidden rounded-full" style={{ background: 'var(--border-strong)' }} aria-hidden>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

/** One fact as a tile. Numeric/scalar facts (`big`) render a large metric value
 *  with an optional stepper/bar/sub; text, path, and sentence values stay in the
 *  quiet body size and truncate inside the tile — so a value like a file path or
 *  "Safe — services boot side by side" reads on the same grid as "0%". */
export function FactTile({ fact: f }: { fact: StageFact }) {
  const toneColor = f.tone ? FACT_TONE[f.tone] : null
  return (
    <div className="min-w-0 rounded-md px-3 py-2.5" style={{ background: 'var(--bg-elevated)' }}>
      <div className="cl-rubric">{f.label}</div>
      {f.big ? (
        <>
          <div className="mt-1 flex items-baseline gap-1 leading-none">
            <span className="text-[22px] font-medium" style={{ color: toneColor ?? 'var(--text-primary)' }}>{f.value}</span>
            {f.stepper ? <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{` of ${f.stepper[1]}`}</span> : null}
          </div>
          {f.stepper ? <FactStepper current={f.stepper[0]} total={f.stepper[1]} /> : null}
          {f.bar != null ? <FactBar frac={f.bar} color={toneColor ?? 'var(--accent)'} /> : null}
          {f.sub ? <div className="mt-1.5 text-[10.5px]" style={{ color: 'var(--text-secondary)' }}>{f.sub}</div> : null}
        </>
      ) : (
        <div
          className="mt-1 min-w-0 truncate text-[11.5px]"
          title={f.title ?? f.value}
          style={{ color: toneColor ?? 'var(--text-secondary)', ...(f.mono ? { fontFamily: 'var(--font-mono)' } : {}) }}
        >
          {f.value}
        </div>
      )}
    </div>
  )
}

/** The one facts renderer every stage uses (R20): the 2–4 things that matter at
 *  this stage, carded on the same `PanelCard` surface as the Service / Playwright
 *  / docs digests below it, so the whole pane reads as one stack of like blocks.
 *  Facts render as a responsive tile grid (R77): numeric facts get a large
 *  metric treatment (coverage %, pass N of M), text/path facts stay quiet — one
 *  layout that fits every stage's mix of scalar and sentence values. */
export function FactsGrid({ facts }: { facts: StageFact[] }) {
  if (facts.length === 0) return null
  return (
    // Same 76ch column as every stage panel — the tile grid wraps inside it and
    // long values truncate within a tile, never sprawling the whole pane.
    <div className="w-full max-w-[76ch]">
      <PanelCard kicker="At a glance" testId="stage-facts-card">
        <div
          data-testid="stage-facts"
          className="grid gap-2"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
        >
          {facts.map((f, i) => (
            <FactTile key={`${f.label}-${i}`} fact={f} />
          ))}
        </div>
      </PanelCard>
    </div>
  )
}

/** `skipReason` is a mixed field: the conductor writes prose for evidence-based
 *  jumps ("rerun of existing feature X") but a bare machine token for the
 *  stage-entry pre-skip. Map the tokens; wrap prose so every skipped stage
 *  reads as a sentence instead of leaking an enum into the UI. */
function skippedLine(reason: string | undefined): string {
  if (!reason) return 'Skipped.'
  if (reason === 'stage-entry') return 'Skipped — this flight started at a later step.'
  return `Skipped — ${reason}.`
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

  // A pending stage that already has a startedAt was INTERRUPTED mid-run
  // (pause / restart-reconcile flips running back to pending but keeps the
  // timestamp) — "waiting for earlier stages" would contradict the activity
  // shown right below it.
  if (status === 'pending') {
    if (stage.startedAt) return 'Interrupted mid-step — Continue resumes it from here.'
    // "Waiting for earlier stages" only makes sense when an earlier stage is
    // still ahead of this one. For the first stage to run (nothing earlier,
    // or every earlier stage already done/skipped) there is nothing to wait
    // on — a flight parked here was stopped before this step began.
    const idx = flight.stages.findIndex((s) => s.key === key)
    const waitingOnEarlier = flight.stages
      .slice(0, idx < 0 ? 0 : idx)
      .some((s) => s.status !== 'done' && s.status !== 'skipped')
    if (!waitingOnEarlier) {
      return flight.status === 'paused'
        ? 'Paused before it started — Continue begins this step.'
        : 'Not started yet.'
    }
    return 'Waiting for earlier stages.'
  }
  if (status === 'waiting-for-approval') {
    // `prd-source` renders as the RequirementsFork, which owns the whole
    // surface: it shows the verdict band (the same finding this message
    // carries) and the two path cards (the same "add docs yourself, or have an
    // agent gather them" advice). Echoing `message` here would print both a
    // second time — the message exists for the CLI/MCP surfaces, which have no
    // fork to render. Other checkpoint kinds still need it: their generic card
    // shows options, not prose.
    if (stage.checkpoint?.kind === 'prd-source') {
      return 'Paused — choose where requirements come from below.'
    }
    // R80: the run-failed decision is fused into the Test Run hero's footer
    // (with the give-up reason as its why-line), so the state line stays terse
    // instead of echoing the whole checkpoint message a second time.
    if (stage.checkpoint?.kind === 'run-failed') {
      return 'The run did not pass — review it and decide below.'
    }
    return stage.checkpoint?.message ?? 'Paused — your decision is needed below.'
  }
  if (status === 'skipped') return skippedLine(stage.skipReason)
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
      if (running) return 'Checking existing suites for a duplicate…'
      const match = ev.match as Record<string, unknown> | null | undefined
      const scanned = num(ev, 'scanned')
      if (match && typeof match.feature === 'string') {
        const choice = str(ev, 'choice')
        return `Matched existing suite "${match.feature}"${choice ? ` — continuing as ${choice}` : ''}.`
      }
      return `No duplicate found${scanned != null ? ` (${scanned} suite${scanned === 1 ? '' : 's'} scanned)` : ''} — proceeding fresh.`
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
    case 'portify': {
      if (running) {
        // The workflow's live phase (see PortifyStageProgress) — older flights
        // have no mirror and fall back to the generic line.
        const phase = str(portifyProgress(stage), 'status')
        return phase && PORTIFY_PHASE_LINE[phase]
          ? PORTIFY_PHASE_LINE[phase]
          : 'Verifying the services boot concurrently (port injection)…'
      }
      return ev.edits
        ? 'Services are port-injectable — edits applied and double-boot verified.'
        : 'Services are port-injectable — no edits needed, double-boot verified.'
    }
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
