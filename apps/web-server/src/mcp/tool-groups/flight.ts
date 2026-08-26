// MCP tools — the conducted flight pipeline (start / inspect / answer checkpoints).
// Split out of authoring.ts; bodies are unchanged.
import { z } from 'zod'
import path from 'path'
import { flightStageRemedy } from '../../features/flights/logic/stage-remedy'
import {
  createHandOffContactLedger,
  forgetHandOffContact,
  handOffIdleAdvice,
  handOffIdleMs,
  handOffIdleReportFor,
  hasPolled,
  noteHandOffContact,
} from '../handoff-idle'
import type { ExternalWorkCheckpointData, FlightManifest } from '../../../../../shared/flights/types'
import { deriveFeatureSlug } from '../../../../../shared/flights/types'
import { fanOutAdviceFor } from '../client-surface'
import { type ToolGroupContext, asJsonResult, errorResult } from '../tool-support'

export function registerFlightTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  // ── Flight (`canary-lab flight` — conducted onboarding pipeline) ──────
  const FLIGHT_DATA_INLINE_BUDGET = 8 * 1024 // ≈2K tokens — past this, review in the web UI
  const flightView = (raw: unknown): Record<string, unknown> => {
    const m = raw as {
      flightId: string; feature: string; status: string; currentStage: string | null
      pauseReason?: string
      runVerdict?: string; error?: string; links?: unknown
      stages?: Array<{ key: string; status: string; error?: string; skipReason?: string; checkpoint?: unknown }>
    }
    const waiting = (m.stages ?? []).find((s) => s.status === 'waiting-for-approval')
    let checkpoint = waiting?.checkpoint as { kind?: string; data?: unknown } | undefined
    if (checkpoint?.data !== undefined && JSON.stringify(checkpoint.data).length > FLIGHT_DATA_INLINE_BUDGET) {
      // `external-work` is a work hand-off, not a question: its data IS the task,
      // so "review it in the web UI" is not an action the client can take. Keep
      // the structural fields and point at the prompt file the stage wrote, so an
      // oversized task degrades to a Read instead of becoming undoable.
      const d = checkpoint.data as ExternalWorkCheckpointData
      checkpoint = checkpoint.kind === 'external-work' && d.promptPath
        ? {
            ...checkpoint,
            data: {
              stage: d.stage,
              promptPath: d.promptPath,
              // Structural, not payload: without the id the client cannot submit
              // at all, so it must survive the same trim that drops the prompt.
              ...(d.handOffId ? { handOffId: d.handOffId } : {}),
              ...(d.lastRejection ? { lastRejection: d.lastRejection } : {}),
              ...(d.takeoverRequestedAt ? { takeoverRequestedAt: d.takeoverRequestedAt } : {}),
              promptOmitted: true,
              reason: 'the task prompt is over the inline budget — Read promptPath for the full task instead of expecting it inline',
              ...(d.context !== undefined && JSON.stringify(d.context).length <= FLIGHT_DATA_INLINE_BUDGET ? { context: d.context } : {}),
            },
          }
        : { ...checkpoint, data: { omitted: true, reason: 'payload over the inline budget — review it in the web UI flight view, then respond here' } }
    }
    return {
      flightId: m.flightId,
      feature: m.feature,
      status: m.status,
      currentStage: m.currentStage,
      ...(m.pauseReason ? { pauseReason: m.pauseReason } : {}),
      ...(m.runVerdict ? { runVerdict: m.runVerdict } : {}),
      ...(m.error ? { error: m.error } : {}),
      ...(m.links ? { links: m.links } : {}),
      stages: (m.stages ?? []).map((s) => ({
        key: s.key,
        status: s.status,
        ...(s.error ? { error: s.error } : {}),
        ...(s.skipReason ? { skipReason: s.skipReason } : {}),
      })),
      ...(waiting && checkpoint ? { checkpoint: { stage: waiting.key, ...checkpoint } } : {}),
    }
  }
  // One ledger per server. See handoff-idle.ts for why it is in memory.
  const handOffContact = createHandOffContactLedger()

  const flightNext = (view: Record<string, unknown>): string => {
    if (view.status === 'waiting-for-approval') {
      const cp = view.checkpoint as {
        stage?: string
        kind?: string
        options?: string[]
        data?: ExternalWorkCheckpointData & { lastAttempt?: { mode?: string; outcome?: string; reason?: string } }
      } | undefined
      const base = `Flight is parked on the ${cp?.kind ?? 'checkpoint'} checkpoint — call respond_flight_checkpoint(flightId, choice: one of ${JSON.stringify(cp?.options ?? [])}).`
      if (cp?.kind === 'prd-source') {
        const fork = `${base} The Requirements stage ALWAYS pauses here — a two-path fork; ask your user which path. (a) Supply docs yourself: distill THIS conversation with write_feature_doc("${String(view.feature)}", "conversation-prd.md", <markdown>) or link a local file with write_feature_doc(link_path: "~/path/to/prd.md"), then respond "continue". (b) Have Canary's agent gather them guided by the flight's frozen intent: respond "collect-repo-docs" (the agent copies in repo docs relevant to the intent) or "infer-from-diff" (the agent derives requirements from the branch diff vs base). If a previous gather went wrong, pass feedback:"<what was wrong>" with the choice — it is added to the agent's prompt.`
        // A re-park after an empty gather must NOT read as a neutral first
        // visit: repeating the same collector over the same repos is the one
        // choice already known to fail. Mirrors the web UI, which flips its
        // recommendation to the manual path on the same `lastAttempt`.
        const last = cp.data?.lastAttempt
        if (!last) return fork
        const what = last.outcome === 'no-diff'
          ? 'found no meaningful diff vs the base branch'
          : last.reason
            ? `searched and found nothing relevant: ${last.reason}`
            : 'ran but produced no requirements doc'
        return `${fork} NOTE — a previous "${String(last.mode)}" gather already ${what}. Do NOT simply repeat that same choice: the material is not in these repos. Prefer (a) supplying the docs yourself, or re-run the agent ONLY with feedback:"<what it missed>" or after the user points the flight at different repos.`
      }
      // The one checkpoint kind that is WORK, not a question. It only appears on a
      // flight started with stage_producer:"external". Steering rides the RESULT
      // rather than the profile instructions because the CLI truncates a server's
      // `instructions` at 2048 chars and the flight profile is already past it.
      if (cp?.kind === 'external-work') {
        const data = cp.data as ExternalWorkCheckpointData | undefined
        if (data?.takeoverRequestedAt) {
          return `TAKEOVER REQUESTED by the user at ${data.takeoverRequestedAt}. Stop work on this step now, including any subagents or processes you started. Do not submit your result. Release the step with respond_flight_checkpoint(flightId, choice:"run-internally"); only that acknowledgement lets Canary start its local agent. If the user forces takeover before you acknowledge, your later checkpoint response will be rejected. Files you already wrote stay on disk, so tell the user what changed before releasing if they need to review it.`
        }
        const where = data?.promptPath && !data.prompt
          ? `Read checkpoint.data.promptPath (${data.promptPath}) for the task — it was too large to inline`
          : 'checkpoint.data.prompt is the task'
        // A submit was already refused here. Lead with that: an agent that reads
        // the task first and the rejection second tries the same thing again.
        const rejected = data?.lastRejection === 'stale_submission'
          ? 'A previous submit for this step was DISCARDED because it answered an EARLIER hand-off — most likely the user stopped and resumed the flight while that work was in progress. Anything that client produced is void. '
          : ''
        // The token rule, and the cheap check that makes it rare: an external step
        // can run for many minutes, and nothing can interrupt a client mid-turn, so
        // re-reading state right before submitting is the only way it finds out
        // early rather than at the rejection.
        const tokenRule = data?.handOffId
          ? `Pass token:"${data.handOffId}" on your submit — it identifies THIS hand-off. Re-call get_flight immediately before submitting (and between fan-out rounds, or roughly every 10 minutes of work): if the status is no longer waiting-for-approval, or the handOffId has changed, the user stopped or re-asked this step — discard your result and tell them instead of submitting. `
          : ''
        // The rule that has to ride the RESULT, not the skill: a client reads this
        // string fresh on every call, while a skill can be compacted out of its
        // context halfway through an eleven-stage pipeline — which is exactly when
        // this failure happens. Observed live: a client wrote the docs file, posted
        // the user a status table, and ended its turn at stage 5 of 11. A parked
        // hand-off has no deadline, so the flight simply stopped, reporting
        // "waiting-for-approval" with six stages that would never start.
        const stayRule = 'DO NOT END YOUR TURN while this step is open. The flight advances ONLY when you submit — nothing polls it, no timeout rescues it, and a status update to the user is not progress. Keep working through submit, then follow the flight to its next stage. If you truly must stop, say so to the user in the same breath and tell them the flight is parked until they re-invoke the flight skill to pick this hand-off up. '
        // Advice matched to what THIS client can do, rather than one line that
        // tells a subagent-less chat client to fan out and then reads its
        // serial behaviour as disobedience.
        return `${rejected}This flight hands its ${String(data?.stage ?? 'stage')} step to YOU (stage_producer:"external"). ${where}, rendered exactly as Canary's own agent would receive it. ${stayRule}${tokenRule} ${fanOutAdviceFor(ctx.clientFacts())} Do the work with your tools now (write the files the prompt names, on the real paths it gives), then release with respond_flight_checkpoint(flightId, choice:"submit", data:<the result shape the prompt asks for>). Canary re-validates independently — the config must parse, the doc must exist on disk, submitted requirements are reconciled and re-read from the written summary, the specs must compile, a mapping must account for every roster test, a portify submit is judged on the workflow record + overlay mark, a run submit on the run\'s own terminal manifest — so a claim of success that did not land on disk re-parks or fails the stage rather than passing. If you cannot do this step (no file tools, permission refused, wrong machine), answer choice:"run-internally" and Canary's local agent takes just that step; the flight continues either way.`
      }
      if (cp?.kind === 'config-approval') {
        return `${base} The feature is scaffolded — the config being approved is the REAL on-disk feature.config.cjs (checkpoint data carries a snapshot + configPath). Approve as-is, pass an edited configSource via data, or answer "redraft" to re-run the repo scan.`
      }
      if (cp?.kind === 'export-mode') {
        return `${base} raw = fast report straight from run evidence; localized = the per-test reasoning is rewritten for readability — on a stage_producer:"external" flight the localized rewrite comes to YOU as an external-work hand-off (and is the default there).`
      }
      if (cp?.kind === 'portify-gate') {
        return `${base} This is the final Parallel setup ask, after the Report but before any Portify agent or double-boot cost: "run" starts the portify workflow (agent edits port wiring in a throwaway worktree, concurrent double-boot verifies — heavy stacks can take 30-60+ min; a sibling feature's saved overlay for the same app is reused and verified first, so the agent may not run at all); "skip" keeps the feature serial (runs go one at a time) and the flight continues — a later flight can ask again.`
      }
      if (cp?.kind === 'portify-apply') {
        return `${base} The diff passed a concurrent double-boot. "apply" SAVES it as the feature's overlay (nothing lands in the product repos — runs apply it into throwaway per-run worktrees); "revise" REQUIRES feedback:"<what to change>" and sends the agent back for another edit + re-verify pass (the checkpoint re-parks with the new diff); "cancel" discards the edits and SKIPS the stage — the flight continues WITHOUT Parallel setup (the feature stays serial; a later flight can retry).`
      }
      return base
    }
    if (view.status === 'running') {
      const links = view.links as { evaluationZip?: string } | undefined
      if (links?.evaluationZip) {
        return `The Report is ready at links.evaluationZip (${links.evaluationZip}) and can be reviewed now. Final Parallel setup is continuing in the background — re-call get_flight to follow it; a checkpoint or failure still needs attention.`
      }
      return 'Flight is running — re-call get_flight to follow it; it parks on checkpoints and settles to done/paused/failed.'
    }
    if (view.status === 'paused' && view.pauseReason === 'queued') return 'Flight is queued — it is waiting its turn behind another flight on the same repo(s) and starts automatically when that repo frees. No action needed; tell the user it is queued, not stuck. Only if they want it started early, re-call start_flight (it resumes a queued flight now).'
    // A user pause is a DECISION, not a fault to recover from. Telling an agent to
    // resume here was the single most wrong sentence in this surface once pause
    // started meaning "stop": the user presses stop and their assistant restarts it.
    if (view.status === 'paused' && view.pauseReason === 'user') {
      return 'The USER paused this flight — its stage work (spawned agents, run, portify workflow, export) was stopped. Do not resume it unless they ask. If you were doing an external-work step for it, discard that result and do not submit it. When they do want it continued, start_flight on the same repos resumes from the first open stage (repos and intent are frozen — re-call without new repoPaths/description).'
    }
    if (view.status === 'paused') return 'Flight is paused (a stage failed, or the server restarted). Fix the cause if needed, then start_flight on the same repos resumes it from the first open stage — its repos and intent are frozen, so re-call without new repoPaths/description (they are reused).'
    if (view.status === 'aborted') return 'Flight was ABORTED — terminal, and it will not continue. Discard any work in progress for it. Only start_flight with redo:true begins a new attempt, and only if the user asks for one.'
    if (view.status === 'done') return 'Flight is done — links.evaluationZip is the deliverable archive. Point the user at reviewing it now: unzip and open evaluation.html (per-test reasoning + verdicts; video playback where the tests drive a browser). Reviewing the evaluation IS the core loop, not an optional extra.'
    return ''
  }
  const flightsUnavailable = () => errorResult('flightsRequest dependency is not configured')

  registerTool('start_flight', {
    description: 'Start (or resume) a Flight: one background pipeline that takes bare product repo(s) to a green, covered, healed run, publishes a downloadable Report, then completes final Parallel setup (similarity → scout → scaffold → env → docs → PRD → Tests & coverage → Test run → Auto-repair → Report → Parallel setup). The server conducts every stage and computes every verdict; you approve checkpoints via respond_flight_checkpoint and can feed docs via write_feature_doc (content or link_path). Autopilot is ON by default: checkpoints with a safe default answer themselves — config-approval→approve (the scaffolded on-disk config), prd-source→continue when requirement docs exist and collect-repo-docs when they do not, coverage-stuck→accept-partial, portify-gate→run, portify-apply→apply, run-failed→export-as-is, export-mode→raw (localized when stage_producer is external — the rewrite then arrives as an external-work hand-off) — each decision logged [autopilot] on its stage. The flight still parks on similarity-choice and missing-env (no safe default) and on any RE-parked checkpoint (e.g. a config parse error after an auto-approve, or a prd-source whose collector came back empty). A stage you explicitly RE-ENTER (from_stage / redo) always parks its FIRST checkpoint even under autopilot — choosing to re-run a step IS the intent to answer it differently. Pass autopilot:false to be asked at every checkpoint — do that when you plan to distill THIS conversation into requirement docs at the prd-source stop. ONE flight record per feature: a paused flight is resumed, an ACTIVE one returns its id to follow, and a settled one requires redo:true (restart from stage 1) or from_stage (jump to a chosen stage; prerequisites checked, rejected with the missing one named). A restart normally WIPES the entry step and every later record step back to zero on disk — requirement docs (user-added files/links included), authored specs, captured envsets, portify overlay, run record, evaluation export — as if never run. The exception is from_stage:"portify": Parallel setup resets only itself and preserves the completed run, verdict, and Report. Plain resume never wipes, so warn the user before any other redo/from_stage on artifacts they still want. A flight\'s repos and intent are FROZEN against MID-PIPELINE re-entry: on from_stage (and on resume) OMIT repoPaths/description and the stored values are reused — passing DIFFERENT ones is rejected with type:"flight_frozen". A full restart (redo:true) accepts new repoPaths/description and replaces the stored ones (omit to reuse); deleting the flight (web UI only, no tool) removes the record itself. A queued flight (status:"paused", pauseReason:"queued") is waiting its turn behind another flight on the same repo(s) and auto-starts when that repo frees — re-calling start_flight resumes it early. `agent` picks which CLI (claude|codex) conducts the flight\'s stage agents — sticky per record (jump/continue reuse it; only redo may change it); the run stage\'s auto-heal follows the workspace heal setting instead.',
    inputSchema: {
      repoPaths: z.array(z.string()).min(1).optional().describe('Absolute path(s) of the product repo(s); several paths become ONE feature spanning them. REQUIRED for a fresh start; OMIT on redo / from_stage / resume — the flight\'s repos are frozen and the stored set is reused (a different set is rejected with flight_frozen).'),
      description: z.string().optional().describe('What to test, e.g. "checkout flow". REQUIRED for a fresh start; OMIT on redo / from_stage / resume — the flight\'s intent is frozen and the stored value is reused (a different one is rejected with flight_frozen).'),
      feature: z.string().optional().describe('Feature name; defaults to a slug of the first repo basename.'),
      env: z.string().optional().describe('Envset name (default "local").'),
      coverage_target: z.number().min(0).max(100).optional().describe('Coverage % the specs↔coverage loop must reach (default 100).'),
      base: z.string().optional().describe('Base branch for diff-inferred requirements (auto-detected when omitted).'),
      yolo: z.boolean().optional().describe('Skip every checkpoint except missing env secrets.'),
      autopilot: z.boolean().optional().describe('Default true: safe checkpoints answer themselves (logged [autopilot]) — a docs-less prd-source runs the collector agent (collect-repo-docs); similarity-choice, missing-env, and re-parked checkpoints still park. Pass false to be asked at every checkpoint (e.g. to add conversation docs at the prd-source stop).'),
      fresh: z.boolean().optional().describe('Do not resume a paused flight — start over.'),
      agent: z.enum(['claude', 'codex']).optional().describe('R79: which CLI conducts the flight\'s stage agents (scout, requirements collector, PRD summary, spec author, coverage mapper). STICKY per record: jump/continue reuse the stored one; only redo:true may change it. Absent = the stored value, or claude for a fresh start.'),
      stage_producer: z.enum(['internal', 'external']).optional().describe('WHO executes the hand-off-capable stages: scout (survey the repos, draft the feature config), docs (gather/infer requirement docs), prd-summary (distill the docs into requirements), specs-coverage (author the spec files, then map them onto the requirements — two sequential hand-offs per pass), portify (the flight starts an EXTERNAL workflow and parks ONCE for the whole engagement: you drive submit_external_portify / get_portify against the given workflowId, stop at ready-to-save, and submit — never save_portify/cancel_portify, the flight owns the save decision), run/heal (the run starts in external-heal mode UNCLAIMED and the flight parks: claim_heal with your own session, loop wait_for_heal_task, fix APP code — never tests — signal_run, then submit once the run is terminal; Canary reads the verdict from the run record), and evaluation-export when the mode is localized (the DEFAULT for an external flight — the rewrite is thinking; raw stays internal and deterministic). "external" is the DEFAULT for an MCP caller — you are an interactive agent, so the thinking is yours unless you say otherwise. Pass "internal" to have Canary spawn the CLI named by `agent` on the server instead (the right choice when this client has no file tools, or the user wants a hands-off flight); a single stage can also be handed back with choice:"run-internally" on its checkpoint, so a whole-flight "internal" is rarely what you want. "external" means YOU do those steps in THIS client: each one parks the flight on an `external-work` checkpoint whose data carries the rendered prompt — do the work with your own tools and subagents, then release it with respond_flight_checkpoint(choice:"submit", data:<result>). Canary still validates every result the same way it validates its own agent\'s (the config must parse, the doc must exist on disk, the requirements are reconciled and re-read from the written summary, the specs must compile, the mapping must account for every roster test and the tags are written by Canary\'s own tag-writer before the ledger is recomputed, the portify workflow must actually be ready-to-save and the double-boot-verified overlay mark is the save predicate, the run verdict is its own terminal manifest), so the verdict stays evidence rather than your report. Answer choice:"run-internally" on any of those checkpoints to hand that one step back to Canary\'s local agent. STICKY per record for the same reason `agent` is. Pick this when you want the work done with your own context and subagents; the purely mechanical stages (similarity, scaffold, env — and the run\'s own playwright execution) have no thinking to move and are unaffected.'),
      redo: z.boolean().optional().describe('Restart the feature\'s existing flight from stage 1. WIPES every step\'s on-disk artifacts back to zero — requirement docs (user-added included), specs, envsets, portify overlay, run record, export — as if the flight never ran; warn the user first if they may still want them.'),
      from_stage: z.string().optional().describe('Start at this stage instead of stage 1 (e.g. "specs-coverage", "run"). Prerequisite artifacts are checked; rejected with the missing one named. Normally wipes this step and every later record step on disk before re-running. The "portify" exception resets only Parallel setup and preserves the completed run and Report.'),
      feedback: z.string().optional().describe('What went wrong on the previous attempt, in the user\'s words or your own — appended to the ENTRY stage\'s agent prompt so the re-run does something different instead of repeating itself. Only meaningful with redo or from_stage; ignored on a fresh start or a resume. Send it whenever you are re-entering a stage BECAUSE something was wrong: without it the stage has no idea the last attempt was rejected.'),
    },
  }, async ({ repoPaths, description, feature, env, coverage_target, base, yolo, autopilot, agent, stage_producer, fresh, redo, from_stage, feedback }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    // Repos + intent are frozen once a flight exists, so redo / from_stage /
    // resume may OMIT repoPaths/description — but then we need `feature` to
    // locate the record (there is no repo set to match on). Resolving the name
    // here, as one exhaustive fork, is what lets the payload below name the
    // feature unconditionally: the "neither was given" case has already
    // returned, so there is no unreachable empty-string fallback to carry.
    let featureName: string
    if (feature) {
      featureName = feature
    } else if (repoPaths !== undefined && repoPaths.length > 0) {
      featureName = deriveFeatureSlug(repoPaths[0])
    } else {
      return errorResult('start_flight needs repoPaths for a fresh start, or `feature` to redo / jump / resume an existing flight (its frozen repos + intent are reused).')
    }
    const list = await deps.flightsRequest({ method: 'GET', url: '/api/flights' })
    const flights = ((list.body as { flights?: Array<{ flightId: string; feature?: string; status: string; repoPaths?: string[] }> }).flights ?? [])
    const targets = new Set((repoPaths ?? []).map((p) => path.resolve(p)))
    const latest = flights.find((f) =>
      targets.size > 0
        ? (f.repoPaths ?? []).some((p) => targets.has(path.resolve(p)))
        : f.feature === feature,
    )
    if (latest && (latest.status === 'running' || latest.status === 'waiting-for-approval') && !redo && !from_stage) {
      const current = await deps.flightsRequest({ method: 'GET', url: `/api/flights/${encodeURIComponent(latest.flightId)}` })
      const view = flightView(current.body)
      return asJsonResult({ ...view, note: 'a flight is already active for these repos — following it', next: flightNext(view) })
    }
    if (latest && latest.status === 'paused' && !fresh && !redo && !from_stage) {
      const resumed = await deps.flightsRequest({ method: 'POST', url: `/api/flights/${encodeURIComponent(latest.flightId)}/resume` })
      const resumedBody = resumed.body as { error?: string; type?: string; active?: unknown }
      // Resuming the Getting Started demo flight re-claims the workspace demo
      // session, so it can collide with another active demo exactly like start.
      if (resumed.statusCode === 409 && resumedBody.type === 'getting_started_busy') {
        return asJsonResult({
          type: 'getting_started_busy',
          active: resumedBody.active,
          message: resumedBody.error,
          next: 'Follow the active demo in its current owner; do not start another run or Flight.',
        })
      }
      if (resumed.statusCode !== 200) return errorResult(`resume failed (${resumed.statusCode}): ${String(resumedBody.error ?? '')}`)
      const view = flightView(resumed.body)
      return asJsonResult({ ...view, note: 'resumed the paused flight from its first open stage', next: flightNext(view) })
    }
    const hasRepos = repoPaths !== undefined && repoPaths.length > 0
    const started = await deps.flightsRequest({
      method: 'POST',
      url: '/api/flights',
      payload: {
        // Repos + intent are frozen on the record: send them only when the
        // caller actually provided them (a fresh start, or an explicit —
        // matching — reuse). Omitting them on redo / jump lets the server
        // reuse the stored values; a DIFFERENT value would 409 flight_frozen.
        ...(hasRepos ? { repoPaths } : {}),
        ...(description !== undefined ? { description } : {}),
        feature: featureName,
        ...(env ? { env } : {}),
        ...(coverage_target !== undefined ? { coverageTarget: coverage_target } : {}),
        ...(base ? { base } : {}),
        ...(yolo ? { yolo } : {}),
        ...(autopilot === false ? { autopilot: false } : {}),
        ...(agent ? { agent } : {}),
        // Hand the thinking to the caller unless it asked otherwise. A flight
        // reached through MCP has an interactive agent on the other end, and that
        // agent holds the conversation the requirements came from — so it, not a
        // cold server-spawned CLI, is the right author. `internal` stays one word
        // away, a single stage can still degrade via `run-internally`, and a resume
        // keeps whatever its earlier stages actually used (see conductor).
        //
        // No PTY special-case here on purpose. `clientKindFromFacts` deliberately
        // never mints a `*-pty` kind (a handshake must not be able to claim the kind
        // that suppresses heal-claiming), so any check against it would be dead code
        // that reads like a guard. Nor is one needed: a runner-spawned agent that
        // started a flight can answer its own `external-work` checkpoints — it has
        // the same tools — and the place PTY agents are actually held back is the
        // run layer's heal-claim policy, keyed off the env var their spawn sets.
        stageProducer: stage_producer ?? 'external',
        ...(redo ? { mode: 'redo' } : from_stage ? { mode: 'jump' } : {}),
        ...(from_stage ? { fromStage: from_stage } : {}),
        ...(feedback && (redo || from_stage) ? { feedback } : {}),
      },
    })
    const startedBody = started.body as { error?: string; type?: string; options?: string[]; existingFlightId?: string; existingStatus?: string; active?: unknown }
    if (started.statusCode === 409 && startedBody.type === 'getting_started_busy') {
      return asJsonResult({
        type: 'getting_started_busy',
        active: startedBody.active,
        message: startedBody.error,
        next: 'Follow the active demo in its current owner; do not start another run or Flight.',
      })
    }
    if (started.statusCode === 409 && startedBody.type === 'flight_exists_requires_choice') {
      return asJsonResult({
        type: 'flight_exists_requires_choice',
        feature: feature ?? null,
        existingFlightId: startedBody.existingFlightId,
        existingStatus: startedBody.existingStatus,
        options: startedBody.options,
        next: 'This feature already has a flight record. Re-call start_flight with redo:true to restart from stage 1, or from_stage:"<stage>" to jump (prerequisites checked) — OMIT repoPaths/description so the frozen stored values are reused. Redo and most stage jumps wipe the re-entered step and every later record step on disk; from_stage:"portify" resets only Parallel setup and preserves the completed run and Report. A paused record resumes automatically without either flag — resume never wipes.',
      })
    }
    if (started.statusCode === 409 && startedBody.type === 'flight_frozen') {
      return errorResult(`${String(startedBody.error ?? 'this flight\'s repos and intent are frozen')}. Re-call start_flight WITHOUT repoPaths/description (the stored values are reused), or delete the flight in the web UI to start fresh with different ones.`)
    }
    if (started.statusCode !== 201) {
      return errorResult(`start_flight failed (${started.statusCode}): ${String(startedBody.error ?? '')}`)
    }
    const view = flightView(started.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  // The current stage's agent record, when there is one. Two fields, so it is
  // inline-budget safe — enough for a client to know an agent is live and that
  // stop_flight_agent could reach it, without shipping the whole row.
  // Takes the resolved request function rather than reading `deps` again: its
  // only caller has already returned on a missing dependency, so a second
  // not-configured guard here would be a branch no test could reach.
  const agentJobOf = async (
    request: NonNullable<typeof deps.flightsRequest>,
    flightId: string,
  ): Promise<{ jobId: string; status: string; stage?: string } | null> => {
    try {
      const resp = await request({ method: 'GET', url: `/api/agent-jobs?flight=${encodeURIComponent(flightId)}` })
      if (resp.statusCode !== 200) return null
      const jobs = (resp.body as { jobs?: Array<{ jobId: string; status: string; stage?: string }> }).jobs ?? []
      // Prefer a live one; otherwise the newest row, so a tombstone after a crash
      // is visible rather than the flight looking like it never ran an agent.
      return jobs.find((j) => j.status === 'running') ?? jobs[0] ?? null
    } catch {
      // Never let bookkeeping sink the flight read.
      return null
    }
  }

  // Whether the open external-work hand-off has gone quiet, recording this read
  // as client contact on the way out. Returns null for any other checkpoint kind
  // and for a hand-off still inside its budget.
  const handOffIdleStatus = (manifest: FlightManifest, view: Record<string, unknown>) => {
    // `stage` is not optional: flightView builds the checkpoint as
    // `{ stage: waiting.key, ...checkpoint }`, so a checkpoint that exists always
    // carries one. Typing it optional here would only add an unreachable fallback.
    const cp = view.checkpoint as { stage: string; kind?: string; data?: ExternalWorkCheckpointData } | undefined
    if (view.status !== 'waiting-for-approval' || cp?.kind !== 'external-work') return null
    if (cp.data?.takeoverRequestedAt) return null
    const handOffId = cp.data?.handOffId
    const nowMs = Date.now()
    // A parked flight is written once and then untouched, so its updatedAt IS the
    // moment of the park.
    const parkedAtMs = Date.parse(manifest.updatedAt ?? '') || nowMs
    const report = handOffIdleReportFor({
      stage: cp.stage,
      idleMs: handOffIdleMs(handOffContact, { flightId: manifest.flightId, handOffId, parkedAtMs, nowMs }),
      everPolled: hasPolled(handOffContact, manifest.flightId, handOffId),
    })
    noteHandOffContact(handOffContact, { flightId: manifest.flightId, handOffId, nowMs })
    return report
  }

  registerTool('get_flight', {
    description: 'Fetch one flight (stage rail + open checkpoint) by id, or list all flights when flightId is omitted. Poll this to follow a running flight; it parks on checkpoints (respond via respond_flight_checkpoint) and settles to done/paused/failed. A paused flight carries pauseReason: "queued" means it is waiting its turn behind another flight on the same repo(s) and auto-starts when that repo frees (narrate it as waiting, not stuck — do not ask the user to resume it); "user"/"stage-failed"/"restart" are the resumable pauses. When a stage failed on uncommitted repo changes the result carries `remedy` — the still-dirty repos (live git re-check) — and `next` says how to help the user stash/commit them before resuming. A flight parked on an external-work hand-off that no client has checked in on for 45+ minutes also carries `handOffIdle` — the step was handed out and abandoned (usually a client that ended its turn with it open). Nothing resumes a parked hand-off on its own. If checkpoint.data.takeoverRequestedAt is present, the user asked Canary to take this step: stop your work and acknowledge with respond_flight_checkpoint(choice:"run-internally") instead of submitting.',
    inputSchema: {
      flightId: z.string().optional().describe('Omit to list all flights (slim rows).'),
    },
  }, async ({ flightId }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    if (!flightId) {
      const list = await deps.flightsRequest({ method: 'GET', url: '/api/flights' })
      const rows = ((list.body as { flights?: Array<Record<string, unknown>> }).flights ?? []).map((f) => ({
        flightId: f.flightId, feature: f.feature, status: f.status,
        ...(f.pauseReason ? { pauseReason: f.pauseReason } : {}),
        currentStage: f.currentStage, repoPaths: f.repoPaths,
      }))
      return asJsonResult({ flights: rows })
    }
    const resp = await deps.flightsRequest({ method: 'GET', url: `/api/flights/${encodeURIComponent(flightId)}` })
    if (resp.statusCode !== 200) return errorResult(`flight not found: ${flightId}`)
    const view = flightView(resp.body)
    // Read-time remedy for a failed stage (live git re-check, never stored):
    // give the agent the machine-actionable fix, not just the error prose.
    const remedy = await flightStageRemedy(resp.body as FlightManifest).catch(() => null)
    if (remedy) {
      const fix = remedy.repos.length === 0
        ? `The failed ${remedy.stage} stage blamed uncommitted changes, but every repo is CLEAN now (fixed outside this conversation) — just start_flight(feature) to resume.`
        : `The failed ${remedy.stage} stage is blocked by uncommitted changes in ${remedy.repos.map((r) => `"${r.name}" (${r.modified} files, ${r.path})`).join(', ')}. Help the user clean each repo — \`git stash push -u\` (undoable) or commit — then start_flight(feature) to resume; the stage retries automatically.`
      return asJsonResult({ ...view, remedy, next: `${flightNext(view)} ${fix}`.trim() })
    }
    const agentJob = await agentJobOf(deps.flightsRequest, flightId)
    // Hand-off staleness is measured BEFORE this poll is recorded — otherwise the
    // very read that should report the stall resets the clock and never can.
    const idle = handOffIdleStatus(resp.body as FlightManifest, view)
    const next = idle ? `${handOffIdleAdvice(idle)} ${flightNext(view)}` : flightNext(view)
    return asJsonResult({
      ...view,
      ...(agentJob ? { agentJob } : {}),
      ...(idle ? { handOffIdle: idle } : {}),
      next,
    })
  })

  // Two tools rather than one with a mode argument: pause is safe and resumable,
  // abort is terminal and by this repo's convention gates on `confirm` (pattern:
  // abort_run). A single mode-arg tool cannot express "confirm required only for
  // abort" in its schema, so it would either nag on the safe path or leave the
  // terminal one unguarded.
  registerTool('pause_flight', {
    description:
      'Stop a running flight, resumably. Everything the flight had in progress is stopped before this returns — the stage\'s spawned agent, its test run (including a repair in progress), a portify workflow, an evaluation export — so a success here means the work is stopped, not merely signalled. A verified portify review awaiting an answer is deliberately preserved. The record and its stage evidence are kept: start_flight on the same repos resumes from the first open stage (OMIT repoPaths/description — they are frozen and reused). Use this when the user says to stop, pause, or hold a flight. If you are executing an external-work step for this flight, stop that work and discard the result rather than submitting it.',
    inputSchema: {
      flightId: z.string(),
    },
  }, async ({ flightId }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    const resp = await deps.flightsRequest({
      method: 'POST',
      url: `/api/flights/${encodeURIComponent(flightId)}/pause`,
    })
    if (resp.statusCode !== 200) {
      return errorResult(`pause failed (${resp.statusCode}): ${String((resp.body as { error?: string }).error ?? '')}`)
    }
    // The hand-off is settled or the flight is stopping: drop its contact
    // record so the ledger cannot grow across a long-lived server.
    forgetHandOffContact(handOffContact, flightId)
    const view = flightView(resp.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  registerTool('abort_flight', {
    description:
      'End a flight for good. Requires `confirm: true`: this is terminal, unlike pause_flight. It stops the same live work a pause does, then settles the record `aborted` — no resume. A queued sibling flight waiting on the same repo(s) may start as soon as this one releases them. Only start_flight with redo:true begins a new attempt afterwards, and a redo WIPES the record\'s artifacts. Prefer pause_flight unless the user wants the flight abandoned.',
    inputSchema: {
      flightId: z.string(),
      confirm: z.literal(true).describe('Must be true. Aborting is terminal — pause_flight is the resumable stop.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ flightId }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    const resp = await deps.flightsRequest({
      method: 'POST',
      url: `/api/flights/${encodeURIComponent(flightId)}/abort`,
    })
    if (resp.statusCode !== 200) {
      return errorResult(`abort failed (${resp.statusCode}): ${String((resp.body as { error?: string }).error ?? '')}`)
    }
    // The hand-off is settled or the flight is stopping: drop its contact
    // record so the ledger cannot grow across a long-lived server.
    forgetHandOffContact(handOffContact, flightId)
    const view = flightView(resp.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  registerTool('stop_flight_agent', {
    description:
      "Stop just the agent a flight's CURRENT stage is running, instead of pausing the whole flight. Requires `confirm: true`. Be clear about what this does: the flight is waiting on that stage, so killing its agent FAILS the stage attempt and the flight parks with pauseReason \"stage-failed\" — it does not carry on. What you get over pause_flight is narrower and better recorded: the test run and the evaluation export are left alone, the stage keeps the error rather than being reset to not-started, and queued sibling flights on the same repo(s) are released. Resuming re-runs the stage. Use pause_flight when the user wants the whole flight held; use this when one agent is misbehaving and everything else should stay up.",
    inputSchema: {
      flightId: z.string(),
      confirm: z.literal(true).describe('Must be true. This fails the running stage.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ flightId }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    const listed = await deps.flightsRequest({ method: 'GET', url: `/api/agent-jobs?flight=${encodeURIComponent(flightId)}` })
    if (listed.statusCode !== 200) {
      return errorResult(`could not read this flight's agent jobs (${listed.statusCode})`)
    }
    const live = ((listed.body as { jobs?: Array<{ jobId: string; status: string; stage?: string }> }).jobs ?? [])
      .filter((j) => j.status === 'running')
    if (live.length === 0) {
      // Not an error: the honest answer is that there is nothing to stop, and the
      // reason matters — a flight parked on a checkpoint has no live agent, and one
      // whose stage delegated its work has a run or workflow instead.
      return asJsonResult({
        stopped: [],
        next: 'This flight has no live agent right now — it may be parked on a checkpoint, running a delegated job (a test run, a portify workflow, an export), or between stages. Call get_flight to see where it is; pause_flight stops a flight whatever it is doing.',
      })
    }
    const stopped: Array<{ jobId: string; stage?: string }> = []
    for (const job of live) {
      const resp = await deps.flightsRequest({ method: 'POST', url: `/api/agent-jobs/${encodeURIComponent(job.jobId)}/stop` })
      if (resp.statusCode === 202) stopped.push({ jobId: job.jobId, ...(job.stage ? { stage: job.stage } : {}) })
    }
    return asJsonResult({
      stopped,
      next: stopped.length
        ? 'Stopped. The stage that agent belonged to will fail and the flight parks stage-failed (resumable) — its run/export were left alone, and a queued sibling flight on the same repos may now start. Call get_flight to confirm, and start_flight on the same repos to re-run the stage when the user wants it.'
        : 'Nothing was stopped — the agents finished on their own between the read and the stop. Call get_flight for the flight\'s current state.',
    })
  })

  registerTool('respond_flight_checkpoint', {
    description: 'Release a flight parked waiting-for-approval: pass the choice (from the checkpoint\'s options), user-supplied env values for missing-env, or an edited configSource via data for config-approval (the config is the scaffolded feature\'s REAL on-disk file — data.configSource writes through to it). Under autopilot (the default) only similarity-choice, missing-env, and re-parked checkpoints reach you; a flight started with autopilot:false parks at every checkpoint. A prd-source park is a two-path fork: supply the docs yourself (write_feature_doc with content or link_path, then respond "continue"), or have Canary\'s agent gather them guided by the flight\'s frozen intent — respond "collect-repo-docs" (copies in repo docs relevant to the intent) or "infer-from-diff" (derives requirements from the branch diff vs base); optional feedback rides a retry into the agent\'s prompt. A portify-gate park is the final Parallel setup ask after Report and BEFORE any Portify agent/double-boot cost: "run" starts the portify workflow (a sibling feature\'s saved overlay for the same app is reused and verified first — the agent only runs if that fails), "skip" keeps the feature serial and the flight continues. A portify-apply park is a verified-diff review: "apply" saves the overlay (nothing lands in the product repos), "revise" REQUIRES feedback:"<what to change>" and re-runs the agent + double-boot re-verify (the checkpoint re-parks with the new diff), "cancel" discards the edits and SKIPS the stage — the flight continues without Parallel setup (the feature stays serial; a later flight can retry). export-mode picks the evaluation flavor: raw (fast) or localized (rewritten reasoning — on a stage_producer:"external" flight the localized rewrite is handed to YOU as an external-work checkpoint, and is the default there). On external-work, checkpoint.data.takeoverRequestedAt means the user asked Canary to take this step: stop your work and respond choice:"run-internally" to release it; any submit is rejected.',
    inputSchema: {
      flightId: z.string(),
      choice: z.string().optional().describe('One of the checkpoint\'s options.'),
      values: z.record(z.string(), z.string()).optional().describe('missing-env only: KEY→value map, written to the missing env file then captured.'),
      data: z.unknown().optional().describe('config-approval only: { configSource } with the hand-edited config — written through to the feature\'s on-disk feature.config.cjs before validation.'),
      feedback: z.string().optional().describe('prd-source agent choices and portify-apply "revise" only: for prd-source, what went wrong last time (added to the collector agent\'s prompt); for portify-apply revise (where it is REQUIRED), what the agent should change before the double-boot re-verify.'),
      token: z.string().optional().describe('external-work submit only: the `handOffId` from the checkpoint data you are answering. Identifies WHICH hand-off your result belongs to — without it, a result you started before the user paused and resumed the flight could settle a step against an ask that has since changed. Pass it back verbatim; a submit carrying a superseded id is discarded and the step re-parks.'),
    },
  }, async ({ flightId, choice, values, data, feedback, token }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    const resp = await deps.flightsRequest({
      method: 'POST',
      url: `/api/flights/${encodeURIComponent(flightId)}/respond`,
      payload: { response: { ...(choice ? { choice } : {}), ...(values ? { values } : {}), ...(data !== undefined ? { data } : {}), ...(feedback ? { feedback } : {}), ...(token ? { token } : {}) } },
    })
    if (resp.statusCode !== 200) {
      const body = resp.body as { error?: string; type?: string; status?: string; pauseReason?: string }
      // The one rejection whose recipient may have just spent minutes on work
      // nobody wants any more. A bare error string reads as "retry" — which is the
      // opposite of what has to happen, and there is no other channel to say so:
      // an external client cannot be interrupted mid-turn, so this reply IS the
      // stop signal.
      if (body.type === 'flight_not_parked') {
        return asJsonResult({
          type: 'flight_stopped',
          flightId,
          status: body.status,
          ...(body.pauseReason ? { pauseReason: body.pauseReason } : {}),
          next: body.status === 'aborted'
            ? 'This flight was ABORTED — it will not continue. Discard the work you were doing for it and do not resubmit. Tell the user it was stopped; only start_flight with redo:true begins a new attempt, and only if they ask.'
            : 'The flight is no longer waiting on you — the user stopped it, or it moved on. DISCARD the result you were about to submit and stop working on this step. Do not resubmit and do not resume the flight yourself; tell the user it was stopped. Files you already wrote stay on disk, and if they resume, a fresh hand-off re-parks with a new handOffId.',
        })
      }
      if (body.type === 'flight_takeover_requested') {
        return asJsonResult({
          type: 'takeover_requested',
          flightId,
          requestedAt: (body as { requestedAt?: string }).requestedAt,
          next: 'The user asked Canary to take this step. STOP your work now, including subagents/processes; do not submit this result or attempt another submit. Release it with respond_flight_checkpoint(flightId, choice:"run-internally"). Canary starts its local agent only after that acknowledgement. Files you already wrote stay on disk, so tell the user what changed if they need to review it.',
        })
      }
      return errorResult(`respond failed (${resp.statusCode}): ${String(body.error ?? '')}`)
    }
    // The hand-off is settled or the flight is stopping: drop its contact
    // record so the ledger cannot grow across a long-lived server.
    forgetHandOffContact(handOffContact, flightId)
    const view = flightView(resp.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })
}
