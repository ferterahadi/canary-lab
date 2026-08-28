import { STAGE_DEPENDS_ON } from '@shared/flights/types'
import { formatCount } from '@/shared/lib/format'
import type { FlightManifest, FlightStage } from '@/shared/api/client'
import type { HealEnd } from '@/shared/api/types'
import { derivedFlightFeature } from '../lib/derived-stages'
import { plural } from './StageFacts'
import { currentStageForPair, settledStageStatus } from './stage-metrics'
import { EXTERNAL_WORK_COPY } from '../lib/external-work'
import { stageRowKey } from './StageRail'
import { PORTIFY_PHASE_LINE, evidenceOf, num, portifyProgress, specsCoverageProgress, str } from './stage-meta'
import { flightRailLabel } from '@shared/flights/stage-labels'

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
  'trust-prompt': 'waiting for you to approve it in the terminal',
  'approval-prompt': 'waiting on a CLI approval prompt',
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
      return `Auto-repair stopped — the agent went quiet without a fix${cause ? ` (${cause})` : ''}.`
    }
    case 'max-cycles': return 'Auto-repair stopped — it hit the cycle limit without passing.'
    case 'no-progress': return 'Auto-repair stopped — repeated tries got nowhere.'
    case 'cancelled': return 'Auto-repair was stopped before the tests passed.'
    case 'foreign-abort': return 'Auto-repair stopped — another Canary window took over this run.'
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
    case 'cancelled': return 'stopped by you'
    case 'foreign-abort': return 'stopped — record taken over'
    default: return null
  }
}

/** Compact wall-clock duration between two ISO stamps ("4s", "2m 14s",
 *  "1h 03m") — the rail rows and the summary strip both render it (R61). */
export function formatDuration(startedAt?: string, endedAt?: string): string | null {
  if (!startedAt || !endedAt) return null
  const ms = Date.parse(endedAt) - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  return formatMs(ms)
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Milliseconds of actual work a stage did. Reads the banked work clock
 *  (`activeMs`, accumulated segment by segment as the stage leaves `running`)
 *  so a step parked overnight on a checkpoint reports its 90 seconds of work,
 *  not nine wall-clock hours. Records from before the clock existed carry only
 *  the startedAt→endedAt span — all the evidence there is, so it stands. */
export function stageWorkMs(stage: Pick<FlightStage, 'startedAt' | 'endedAt' | 'activeMs' | 'activeSince'> | undefined): number | null {
  if (!stage) return null
  if (stage.activeMs != null || stage.activeSince) {
    const live = stage.activeSince ? Math.max(0, Date.now() - Date.parse(stage.activeSince)) : 0
    return (stage.activeMs ?? 0) + live
  }
  if (!stage.startedAt || !stage.endedAt) return null
  const ms = Date.parse(stage.endedAt) - Date.parse(stage.startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** A merged rail row's duration: the primary's work plus its folded
 *  companion's (run→heal, scaffold→env-capture, docs→prd-summary — R61). The
 *  two run back to back, so the sum is the pair's honest total where the old
 *  first-start→last-end span silently included any wait between them. */
export function formatStageDuration(
  primary?: Pick<FlightStage, 'startedAt' | 'endedAt' | 'activeMs' | 'activeSince'>,
  folded?: Pick<FlightStage, 'startedAt' | 'endedAt' | 'activeMs' | 'activeSince'>,
): string | null {
  const a = stageWorkMs(primary)
  const b = stageWorkMs(folded)
  if (a == null && b == null) return null
  return formatMs((a ?? 0) + (b ?? 0))
}

/** `skipReason` is a mixed field: the conductor writes prose for evidence-based
 *  jumps ("rerun of existing feature X") but a bare machine token for the
 *  stage-entry pre-skip. Map the tokens; wrap prose so every skipped stage
 *  reads as a sentence instead of leaking an enum into the UI. */
export function skippedLine(reason: string | undefined): string {
  if (!reason) return 'Skipped.'
  if (reason === 'stage-entry') return 'Skipped — this flight started at a later step.'
  // Records written before 2.0.0 carry a reason that already opens with
  // "parallel readiness skipped — ", which printed the word twice here.
  const bare = reason.replace(/^parallel readiness skipped — /, '')
  return `Skipped — ${bare.replace(/\.$/, '')}.`
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
  // Guard the double-blank: with neither an id nor a status this printed "Run ."
  if (!runId && !runStatus) return 'Run finished.'
  return `Run${runId ? ` ${runId}` : ''}${runStatus ? ` — ${runStatus}` : ''}.`
}

/** The docs evidence's `source` enum in plain words — raw values like
 *  `repo-docs` and `agent-diff` are wire vocabulary, not sentences. An unknown
 *  value renders nothing rather than leaking. */
function docSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null
  const labels: Record<string, string> = {
    'repo-docs': 'found in the repos',
    'agent-repo-docs': 'collected from the repos by an agent',
    'agent-diff': 'worked out from the branch changes',
    'description-only': 'from the intent alone',
    'intent-linked': 'the files named in the intent',
    'existing': 'already in the suite',
    'user-confirmed': 'the docs you added',
  }
  return labels[source] ?? null
}

/** Sentence for a step whose artifacts were probed from the workspace but which
 *  is NOT finished — the part-done case a status alone cannot express. Only
 *  `specs-coverage` can reach it today: spec files exist (so the authoring half
 *  happened) while no requirements exist to map them onto, which is what leaves
 *  the step open. Null when the stage is not in that state. */
export function partialProbedLine(stage: FlightStage): string | null {
  if (stage.evidenceSource !== 'workspace' || stage.key !== 'specs-coverage') return null
  const ev = evidenceOf(stage)
  if (num(ev, 'total') === 0) return 'Tests are written, but there are no requirements to match them to yet.'
  const mappingState = str(ev, 'mappingState')
  const tests = num(ev, 'testsWritten')
  if (mappingState === 'absent') {
    return `${tests != null ? plural(tests, 'test') : 'Tests'} ${tests === 1 ? 'is' : 'are'} written, but coverage mapping has not run yet.`
  }
  if (mappingState === 'stale') return 'Tests are written, but coverage mapping is stale — run Coverage again.'
  return null
}

/** One sentence for what a stage's agent is doing right now, from the live
 *  partial-message snapshot. Null when no agent is in flight, so a caller keeps
 *  whatever line it would otherwise show.
 *
 *  Gated on `running`: a settled stage keeps its last snapshot, and reporting
 *  that as present tense would claim work that has already finished. */
export function agentActivityLine(stage: FlightStage): string | null {
  const activity = stage.status === 'running' ? stage.agentActivity : undefined
  if (!activity) return null
  switch (activity.phase) {
    case 'requesting': return 'Waiting for the model to reply…'
    case 'thinking': return `Thinking — still working (${formatCount(activity.thinkingTokens)} tokens so far)…`
    case 'tool': return `Running ${activity.tool}…`
    case 'writing': return `Writing the answer — ${formatCount(activity.chars)} characters so far…`
  }
}

// No answer-tail reader here any more. Showing the newest words of a streaming
// answer sounded like the difference between a count climbing and seeing the
// work — but the answers these agents write are JSON, so every sample was a
// slice cut mid-token (`…"tier": 3, "description": "…` }]}]}`). It read as a
// defect rather than as progress. The character count is the sign of life; the
// full output is AgentSessionView's job. `agentActivity.tail` stays on the wire
// for that view's use.

export function stageStateLine(stage: FlightStage, flight: FlightManifest, companion?: FlightStage): string {
  const currentStage = currentStageForPair(stage, companion)
  if (currentStage !== stage) return stageStateLine(currentStage, flight)

  const ev = (stage.evidence ?? {}) as Record<string, unknown>
  const { key } = stage
  // Skipped-with-evidence narrates as settled — same rule the rail draws, so
  // the row's ✓ and this sentence can't contradict each other.
  const status = settledStageStatus(stage)

  const companionDone = companion?.status === 'done'

  // A pending stage that already has a startedAt was INTERRUPTED mid-run
  // (pause / restart-reconcile flips running back to pending but keeps the
  // timestamp) — "waiting for earlier stages" would contradict the activity
  // shown right below it.
  if (status === 'pending') {
    if (stage.startedAt) return 'Stopped part way — Continue picks it up here.'
    // A part-done step: the artifacts are on disk but the step never completed,
    // so say what exists. "Not started" would hide real work — a suite with
    // authored specs and no requirements to map them against is the live case.
    const partial = partialProbedLine(stage)
    if (partial) return partial
    // What a step waits on is what it READS, not what sits above it in the rail.
    // The old rule was positional — "is any earlier row unfinished" — which told a
    // portified suite it was waiting on requirements it never opens, and told an
    // exportable run the same. STAGE_DEPENDS_ON is the shared dependency graph.
    // A dependency is satisfied when its ARTIFACT exists, not when its step is
    // ticked. Workspace-probed evidence is exactly that proof: a part-done step
    // (specs authored, nothing mapping them) has still produced the specs the run
    // stage needs. Without this the rail would claim the run is blocked while the
    // server's entry validator — which checks artifacts — allows it.
    const satisfied = (s: FlightStage): boolean =>
      s.status === 'done' || s.status === 'skipped' || s.evidenceSource === 'workspace'
    const blockers = STAGE_DEPENDS_ON[key]
      .map((dep) => flight.stages.find((s) => s.key === dep))
      .filter((s): s is FlightStage => Boolean(s) && !satisfied(s!))
    if (blockers.length > 0) {
      // Name it exactly as the rail row does — a merged pair reads "Requirements",
      // never the raw `prd-summary` key the rail never shows.
      const row = stageRowKey(blockers[0].key)
      return `Waiting for ${flightRailLabel(row)}.`
    }
    // Nothing it depends on is outstanding — this step simply hasn't run. A
    // derived flight is never "paused by you": there is no record to have paused.
    return flight.status === 'paused' && derivedFlightFeature(flight.flightId) === null
      ? 'Paused before it started — Continue starts this step.'
      : 'Not started yet.'
  }
  if (status === 'waiting-for-approval') {
    // A hand-off is not a stop: the step is being worked on inside the client
    // that started the flight. The checkpoint's own `message` is addressed to
    // that agent ("Run this scout step in your own client…"), which is the wrong
    // voice — and the wrong reader — for the person watching the web UI.
    if (stage.checkpoint?.kind === 'external-work') {
      return EXTERNAL_WORK_COPY.stateLine
    }
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
    return stage.checkpoint?.message ?? 'Paused — pick an option below.'
  }
  if (status === 'skipped') return skippedLine(stage.skipReason)
  if (status === 'failed') return 'Failed — details below.'

  // Pair-settled combined lines (R32/R33): one sentence for the whole step.
  if (companionDone && key === 'scaffold') {
    const cev = (companion?.evidence ?? {}) as Record<string, unknown>
    const captured = num(cev, 'captured')
    const verb = ev.reused ? 'reused' : 'created'
    const files = captured != null ? ` (${captured} file${captured === 1 ? '' : 's'})` : ''
    // The dry-run boot is a GATE the env-capture stage runs. Read-time evidence
    // only proves the envset is on disk — it could have been written by hand or
    // by write_envset — so a probed pair states the artifact and stops there.
    if (companion?.evidenceSource === 'workspace') return `Suite "${flight.feature}" ${verb} — settings copied${files}.`
    return `Suite "${flight.feature}" ${verb} — settings copied${files}, the app started fine.`
  }
  if (companionDone && key === 'docs') {
    const cev = (companion?.evidence ?? {}) as Record<string, unknown>
    const count = num(cev, 'requirementCount')
    const docs = Array.isArray(ev.docs) ? ev.docs.length : null
    const source = docSourceLabel(str(ev, 'source'))
    return `${count != null ? `${count} requirement${count === 1 ? '' : 's'}` : 'Requirements'} written${docs != null ? ` from ${docs} doc${docs === 1 ? '' : 's'}` : ''}${source ? ` (${source})` : ''}.`
  }

  // A running stage with a live agent snapshot says what the agent is doing
  // instead of its generic "…ing" sentence. The generic line describes the whole
  // step and never changes while it runs — exactly the stillness that reads as a
  // hang. This is the same text the rail row's hover tooltip carries.
  const liveAgent = agentActivityLine(stage)
  if (liveAgent) return liveAgent

  const running = status === 'running'
  switch (key) {
    case 'similarity': {
      if (running) return 'Checking whether a suite for this already exists…'
      const match = ev.match as Record<string, unknown> | null | undefined
      const scanned = num(ev, 'scanned')
      if (match && typeof match.feature === 'string') {
        const choice = str(ev, 'choice')
        return `Matched existing suite "${match.feature}"${choice ? ` — continuing as ${choice}` : ''}.`
      }
      return `No match found${scanned != null ? ` (${scanned} suite${scanned === 1 ? '' : 's'} checked)` : ''} — starting fresh.`
    }
    case 'scout': {
      const repos = flight.repoPaths.length
      // What the scan SAW is only knowable from its own evidence — no artifact on
      // disk records it, so a stage without that key has to drop the clause. The
      // old `: 0` fallback turned "never measured" into "detected none", which on
      // a feature whose envset is captured contradicted the very next row.
      const envFiles = Array.isArray(ev.envFiles) ? ev.envFiles.length : null
      const detected = envFiles != null ? `, ${plural(envFiles, 'settings file')} found` : ''
      return running
        ? `Reading ${plural(repos, 'repo')} — how the app starts, which settings files it needs…`
        : `Scanned ${plural(repos, 'repo')} — setup drafted${detected}.`
    }
    case 'scaffold':
      return running
        ? 'Creating the suite in the workspace…'
        : ev.reused
          ? `Suite "${flight.feature}" already existed — reused.`
          : `Suite "${flight.feature}" created in the workspace.`
    case 'env-capture': {
      if (running) return 'Copying settings files and checking the app starts…'
      const captured = num(ev, 'captured')
      return `Settings copied${captured != null ? ` (${captured} file${captured === 1 ? '' : 's'})` : ''} — the app started fine.`
    }
    case 'docs': {
      if (running) return 'Collecting the documents…'
      const docs = Array.isArray(ev.docs) ? ev.docs.length : null
      const source = docSourceLabel(str(ev, 'source'))
      return `Collected ${docs != null ? `${docs} document${docs === 1 ? '' : 's'}` : 'the documents'}${source ? ` — ${source}` : ''}.`
    }
    case 'prd-summary': {
      if (running) return 'Turning the documents into requirements…'
      const count = num(ev, 'requirementCount')
      return `Requirements ready${count != null ? ` — ${count} of them` : ''}.`
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
              ? `writing tests to close ${p.gapsOpen} gap${p.gapsOpen === 1 ? '' : 's'}`
              : p.phase === 'validating'
                ? 'checking the new tests compile'
                : 'matching the tests to the requirements'
          return `Pass ${p.pass} of ${p.maxPasses} — ${doing}…`
        }
        return 'Writing tests to close the gaps…'
      }
      if (ev.acceptedPartial) return `Coverage accepted at ${pct ?? '?'}% — your call.`
      // Read-time evidence proves the specs EXIST; it cannot prove a target was
      // met, because no coverage loop ran to accept one. Report what the ledger
      // says right now instead — the number the old "target met" sentence was
      // asserting over (a suite at 36% with open variant gaps read as met).
      if (stage.evidenceSource === 'workspace') {
        const covered = num(ev, 'covered')
        const total = num(ev, 'total')
        const mappingState = str(ev, 'mappingState')
        const tests = num(ev, 'testsWritten')
        // No requirements means coverage is UNDEFINED, not zero. A suite with real
        // specs and no PRD to map them against would otherwise read "0% — 0 of 0
        // covered", which sounds like a failure instead of nothing to measure.
        if (total === 0) return 'Tests are written, but there are no requirements to match them to yet.'
        if (mappingState === 'absent') {
          return `${tests != null ? plural(tests, 'test') : 'Tests'} ${tests === 1 ? 'is' : 'are'} written, but coverage mapping has not run yet.`
        }
        if (mappingState === 'generating') return 'Matching tests to requirements…'
        if (mappingState === 'stale') return 'Tests are written, but coverage mapping is stale — run Coverage again.'
        const of = covered != null && total != null ? ` — ${covered} of ${total} requirement${total === 1 ? '' : 's'} mapped` : ''
        return `Tests written. Mapped coverage is ${pct ?? '?'}%${of}. Nothing has run yet.`
      }
      return `Coverage target met${pct != null ? ` — ${pct}%` : ''}.`
    }
    case 'portify': {
      if (running) {
        // The workflow's live phase (see PortifyStageProgress) — older flights
        // have no mirror and fall back to the generic line.
        const phase = str(portifyProgress(stage), 'status')
        return phase && PORTIFY_PHASE_LINE[phase]
          ? PORTIFY_PHASE_LINE[phase]
          : 'Checking the services start side by side…'
      }
      return ev.edits
        ? 'Ports can be swapped now — two copies started side by side.'
        : 'Ports were already swappable — two copies started side by side.'
    }
    case 'run': {
      if (running) return 'Tests are running…'
      return runOutcomeLine(stage, flight, companion)
    }
    case 'heal': {
      if (running) return 'An agent is fixing the app…'
      const cycles = num(ev, 'healCycles')
      const runStatus = str(ev, 'finalStatus') ?? str(ev, 'status') ?? flight.runVerdict
      if (cycles != null && cycles > 0) return `${cycles} repair cycle${cycles === 1 ? '' : 's'} — run ${runStatus ?? 'settled'}.`
      return `No repair needed — run ${runStatus ?? 'settled'}.`
    }
    case 'evaluation-export': {
      if (running) return 'Building the report…'
      // Deliberately unnamed here: the sentence used to end in `export.zip`, the
      // archive's internal filename inside the logs dir and NOT the name the
      // download hands over. The card's Archive tile carries the real one.
      return 'Report ready.'
    }
    default:
      return running ? 'Working…' : 'Done.'
  }
}
