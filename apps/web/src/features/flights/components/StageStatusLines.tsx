import type { FlightManifest, FlightStage } from '@/shared/api/client'
import type { HealEnd } from '@/shared/api/types'
import { plural } from './StageFacts'
import { PORTIFY_PHASE_LINE, evidenceOf, num, portifyProgress, specsCoverageProgress, str } from './stage-meta'

// ─── Auto-repair give-up reason (R80) ───────────────────────────────────────
// The manifest's typed `healEnd` (from the run orchestrator) → plain language.
// The server already writes a `message`, so the full line prefers it and only
// composes a fallback for older manifests; the short form is for the Repairs
// tile's `sub`, where a whole sentence won't fit.

export const HEAL_CAUSE_PHRASE: Record<NonNullable<HealEnd['agentCause']>, string> = {
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

/** `skipReason` is a mixed field: the conductor writes prose for evidence-based
 *  jumps ("rerun of existing feature X") but a bare machine token for the
 *  stage-entry pre-skip. Map the tokens; wrap prose so every skipped stage
 *  reads as a sentence instead of leaking an enum into the UI. */
export function skippedLine(reason: string | undefined): string {
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
/** The run's one-sentence outcome, from the run stage's own evidence (R82).
 *  Counts ride in `evidence.counts` (written by the run adapter off the run's
 *  summary artifact): `failed` and `total` are REPORTED, never inferred, because
 *  a test absent from every result list is not-run rather than passed. The
 *  repair-cycle tail reads the same `healCycles` the Repair cycles tile shows, so
 *  the sentence and the tile can't disagree. A run with no counts (older flight,
 *  never-listed suite) falls back to naming the verdict. */
export function runOutcomeLine(stage: FlightStage, flight: FlightManifest, companion?: FlightStage): string {
  // A PARKED stage has no evidence yet — the run adapter returns its evidence as
  // the checkpoint's `data` (a checkpoint outcome doesn't settle the stage), and
  // run-failed is precisely the state this sentence matters most in. Read
  // whichever one this stage actually has.
  const ev = { ...(stage.checkpoint?.data as Record<string, unknown> | undefined ?? {}), ...evidenceOf(stage) }
  const counts = ev.counts as { passed?: number; total?: number; failed?: number } | undefined
  // healCycles lives on whichever half of the merged run↔heal row carries it.
  const cycles = num(ev, 'healCycles') ?? num(evidenceOf(companion), 'healCycles')
  const tail = cycles != null && cycles > 0 ? ` after ${cycles} repair cycle${cycles === 1 ? '' : 's'}` : ''
  const total = counts && typeof counts.total === 'number' ? counts.total : null
  if (total != null && typeof counts?.failed === 'number' && counts.failed > 0) {
    return `${counts.failed} of ${total} test${total === 1 ? '' : 's'} failed${tail}.`
  }
  if (total != null && total > 0 && counts?.passed === total) {
    return `All ${total} test${total === 1 ? '' : 's'} passed${tail}.`
  }
  const runStatus = str(ev, 'status') ?? flight.runVerdict
  const runId = str(ev, 'runId') ?? flight.links?.runId
  return `Run ${runId ?? ''}${runStatus ? ` ${runStatus}` : ''}`.trim() + '.'
}

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
    // R82: the run-failed decision renders as the SAME generic checkpoint card
    // every other kind gets, and that card already carries the question — so the
    // state line spends its one sentence on the outcome instead of echoing the
    // ask ("review it and decide below", pointing at a card that says so itself).
    if (stage.checkpoint?.kind === 'run-failed') {
      return runOutcomeLine(stage, flight, companion)
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
      return runOutcomeLine(stage, flight, companion)
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
