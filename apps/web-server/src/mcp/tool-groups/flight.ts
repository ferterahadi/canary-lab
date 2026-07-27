// MCP tools — the conducted flight pipeline (start / inspect / answer checkpoints).
// Split out of authoring.ts; bodies are unchanged.
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { flightStageRemedy } from '../../features/flights/logic/stage-remedy'
import type { FlightManifest } from '../../../../../shared/flights/types'
import { deriveFeatureSlug } from '../../../../../shared/flights/types'
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
    let checkpoint = waiting?.checkpoint as { data?: unknown } | undefined
    if (checkpoint?.data !== undefined && JSON.stringify(checkpoint.data).length > FLIGHT_DATA_INLINE_BUDGET) {
      checkpoint = { ...checkpoint, data: { omitted: true, reason: 'payload over the inline budget — review it in the web UI flight view, then respond here' } }
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
  const flightNext = (view: Record<string, unknown>): string => {
    if (view.status === 'waiting-for-approval') {
      const cp = view.checkpoint as {
        stage?: string
        kind?: string
        options?: string[]
        data?: { lastAttempt?: { mode?: string; outcome?: string; reason?: string } }
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
      if (cp?.kind === 'config-approval') {
        return `${base} The feature is scaffolded — the config being approved is the REAL on-disk feature.config.cjs (checkpoint data carries a snapshot + configPath). Approve as-is, pass an edited configSource via data, or answer "redraft" to re-run the repo scan.`
      }
      if (cp?.kind === 'export-mode') {
        return `${base} raw = fast report straight from run evidence; localized = an agent rewrites per-test reasoning (slower, more readable).`
      }
      if (cp?.kind === 'portify-gate') {
        return `${base} This is the UPFRONT parallel-readiness ask, before any agent or double-boot cost: "run" starts the portify workflow (agent edits port wiring in a throwaway worktree, concurrent double-boot verifies — heavy stacks can take 30-60+ min; a sibling feature's saved overlay for the same app is reused and verified first, so the agent may not run at all); "skip" keeps the feature serial (runs go one at a time) and the flight continues — a later flight can ask again.`
      }
      if (cp?.kind === 'portify-apply') {
        return `${base} The diff passed a concurrent double-boot. "apply" SAVES it as the feature's overlay (nothing lands in the product repos — runs apply it into throwaway per-run worktrees); "revise" REQUIRES feedback:"<what to change>" and sends the agent back for another edit + re-verify pass (the checkpoint re-parks with the new diff); "cancel" discards the edits and SKIPS the stage — the flight continues WITHOUT parallel readiness (the feature stays serial; a later flight can retry).`
      }
      return base
    }
    if (view.status === 'running') return 'Flight is running — re-call get_flight to follow it; it parks on checkpoints and settles to done/paused/failed.'
    if (view.status === 'paused' && view.pauseReason === 'queued') return 'Flight is queued — it is waiting its turn behind another flight on the same repo(s) and starts automatically when that repo frees. No action needed; tell the user it is queued, not stuck. Only if they want it started early, re-call start_flight (it resumes a queued flight now).'
    if (view.status === 'paused') return 'Flight is paused (a stage failed, the server restarted, or the user paused it). Fix the cause if needed, then start_flight on the same repos resumes it from the first open stage — its repos and intent are frozen, so re-call without new repoPaths/description (they are reused).'
    if (view.status === 'done') return 'Flight is done — links.evaluationZip is the deliverable archive. Point the user at reviewing it now: unzip and open evaluation.html (per-test reasoning + verdicts; video playback where the tests drive a browser). Reviewing the evaluation IS the core loop, not an optional extra.'
    return ''
  }
  const flightsUnavailable = () => errorResult('flightsRequest dependency is not configured')

  registerTool('start_flight', {
    description: 'Start (or resume) a Flight: one background pipeline that takes bare product repo(s) to a green, covered, healed run ending in an evaluation export (similarity → scout → scaffold → env → docs → PRD → specs↔coverage → portify → run → heal → export). The server conducts every stage and computes every verdict; you approve checkpoints via respond_flight_checkpoint and can feed docs via write_feature_doc (content or link_path). Autopilot is ON by default: checkpoints with a safe default answer themselves — config-approval→approve (the scaffolded on-disk config), prd-source→continue (only when requirement docs already exist), coverage-stuck→accept-partial, portify-gate→run, portify-apply→apply, run-failed→export-as-is, export-mode→raw — each decision logged [autopilot] on its stage. The flight still parks on similarity-choice and missing-env (no safe default), on prd-source when NO docs exist yet, and on any RE-parked checkpoint (e.g. a config parse error after an auto-approve). A stage you explicitly RE-ENTER (from_stage / redo) always parks its FIRST checkpoint even under autopilot — choosing to re-run a step IS the intent to answer it differently. Pass autopilot:false to be asked at every checkpoint — do that when you plan to distill THIS conversation into requirement docs at the prd-source stop. ONE flight record per feature: a paused flight is resumed, an ACTIVE one returns its id to follow, and a settled one requires redo:true (restart from stage 1) or from_stage (jump to a chosen stage; prerequisites checked, rejected with the missing one named). A restart WIPES the entry step and every later step back to zero on disk — requirement docs (user-added files/links included), authored specs, captured envsets, portify overlay, run record, evaluation export — as if never run; plain resume never wipes, so warn the user before redo/from_stage on artifacts they still want. A flight\'s repos and intent are FROZEN against MID-PIPELINE re-entry: on from_stage (and on resume) OMIT repoPaths/description and the stored values are reused — passing DIFFERENT ones is rejected with type:"flight_frozen". A full restart (redo:true) accepts new repoPaths/description and replaces the stored ones (omit to reuse); deleting the flight (web UI only, no tool) removes the record itself. A queued flight (status:"paused", pauseReason:"queued") is waiting its turn behind another flight on the same repo(s) and auto-starts when that repo frees — re-calling start_flight resumes it early. `agent` picks which CLI (claude|codex) conducts the flight\'s stage agents — sticky per record (jump/continue reuse it; only redo may change it); the run stage\'s auto-heal follows the workspace heal setting instead.',
    inputSchema: {
      repoPaths: z.array(z.string()).min(1).optional().describe('Absolute path(s) of the product repo(s); several paths become ONE feature spanning them. REQUIRED for a fresh start; OMIT on redo / from_stage / resume — the flight\'s repos are frozen and the stored set is reused (a different set is rejected with flight_frozen).'),
      description: z.string().optional().describe('What to test, e.g. "checkout flow". REQUIRED for a fresh start; OMIT on redo / from_stage / resume — the flight\'s intent is frozen and the stored value is reused (a different one is rejected with flight_frozen).'),
      feature: z.string().optional().describe('Feature name; defaults to a slug of the first repo basename.'),
      env: z.string().optional().describe('Envset name (default "local").'),
      coverage_target: z.number().min(0).max(100).optional().describe('Coverage % the specs↔coverage loop must reach (default 100).'),
      base: z.string().optional().describe('Base branch for diff-inferred requirements (auto-detected when omitted).'),
      yolo: z.boolean().optional().describe('Skip every checkpoint except missing env secrets.'),
      autopilot: z.boolean().optional().describe('Default true: safe checkpoints answer themselves (logged [autopilot]); similarity-choice, missing-env, docs-less prd-source, and re-parked checkpoints still park. Pass false to be asked at every checkpoint (e.g. to add conversation docs at the prd-source stop).'),
      fresh: z.boolean().optional().describe('Do not resume a paused flight — start over.'),
      agent: z.enum(['claude', 'codex']).optional().describe('R79: which CLI conducts the flight\'s stage agents (scout, requirements collector, PRD summary, spec author, coverage mapper). STICKY per record: jump/continue reuse the stored one; only redo:true may change it. Absent = the stored value, or claude for a fresh start.'),
      redo: z.boolean().optional().describe('Restart the feature\'s existing flight from stage 1. WIPES every step\'s on-disk artifacts back to zero — requirement docs (user-added included), specs, envsets, portify overlay, run record, export — as if the flight never ran; warn the user first if they may still want them.'),
      from_stage: z.string().optional().describe('Start at this stage instead of stage 1 (e.g. "specs-coverage", "run"). Prerequisite artifacts are checked; rejected with the missing one named. WIPES this step\'s and every later step\'s on-disk artifacts (user-added inputs included) back to zero before re-running; earlier steps keep theirs.'),
    },
  }, async ({ repoPaths, description, feature, env, coverage_target, base, yolo, autopilot, agent, fresh, redo, from_stage }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    // Repos + intent are frozen once a flight exists, so redo / from_stage /
    // resume may OMIT repoPaths/description — but then we need `feature` to
    // locate the record (there is no repo set to match on).
    if ((repoPaths === undefined || repoPaths.length === 0) && !feature) {
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
      if (resumed.statusCode !== 200) return errorResult(`resume failed (${resumed.statusCode}): ${String((resumed.body as { error?: string }).error ?? '')}`)
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
        feature: feature ?? (hasRepos ? deriveFeatureSlug(repoPaths[0]) : ''),
        ...(env ? { env } : {}),
        ...(coverage_target !== undefined ? { coverageTarget: coverage_target } : {}),
        ...(base ? { base } : {}),
        ...(yolo ? { yolo } : {}),
        ...(autopilot === false ? { autopilot: false } : {}),
        ...(agent ? { agent } : {}),
        ...(redo ? { mode: 'redo' } : from_stage ? { mode: 'jump' } : {}),
        ...(from_stage ? { fromStage: from_stage } : {}),
      },
    })
    const startedBody = started.body as { error?: string; type?: string; options?: string[]; existingFlightId?: string; existingStatus?: string }
    if (started.statusCode === 409 && startedBody.type === 'flight_exists_requires_choice') {
      return asJsonResult({
        type: 'flight_exists_requires_choice',
        feature: feature ?? null,
        existingFlightId: startedBody.existingFlightId,
        existingStatus: startedBody.existingStatus,
        options: startedBody.options,
        next: 'This feature already has a flight record. Re-call start_flight with redo:true to restart from stage 1, or from_stage:"<stage>" to jump (prerequisites checked) — OMIT repoPaths/description so the frozen stored values are reused. Either flag WIPES the re-entered step\'s and every later step\'s on-disk artifacts (user-added docs included) back to zero. A paused record resumes automatically without either flag — resume never wipes.',
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

  registerTool('get_flight', {
    description: 'Fetch one flight (stage rail + open checkpoint) by id, or list all flights when flightId is omitted. Poll this to follow a running flight; it parks on checkpoints (respond via respond_flight_checkpoint) and settles to done/paused/failed. A paused flight carries pauseReason: "queued" means it is waiting its turn behind another flight on the same repo(s) and auto-starts when that repo frees (narrate it as waiting, not stuck — do not ask the user to resume it); "user"/"stage-failed"/"restart" are the resumable pauses. When a stage failed on uncommitted repo changes the result carries `remedy` — the still-dirty repos (live git re-check) — and `next` says how to help the user stash/commit them before resuming.',
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
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  registerTool('respond_flight_checkpoint', {
    description: 'Release a flight parked waiting-for-approval: pass the choice (from the checkpoint\'s options), user-supplied env values for missing-env, or an edited configSource via data for config-approval (the config is the scaffolded feature\'s REAL on-disk file — data.configSource writes through to it). Under autopilot (the default) only similarity-choice, missing-env, a docs-less prd-source, and re-parked checkpoints reach you; a flight started with autopilot:false parks at every checkpoint. A prd-source park is a two-path fork: supply the docs yourself (write_feature_doc with content or link_path, then respond "continue"), or have Canary\'s agent gather them guided by the flight\'s frozen intent — respond "collect-repo-docs" (copies in repo docs relevant to the intent) or "infer-from-diff" (derives requirements from the branch diff vs base); optional feedback rides a retry into the agent\'s prompt. A portify-gate park is the upfront parallel-readiness ask BEFORE any agent/double-boot cost: "run" starts the portify workflow (a sibling feature\'s saved overlay for the same app is reused and verified first — the agent only runs if that fails), "skip" keeps the feature serial and the flight continues. A portify-apply park is a verified-diff review: "apply" saves the overlay (nothing lands in the product repos), "revise" REQUIRES feedback:"<what to change>" and re-runs the agent + double-boot re-verify (the checkpoint re-parks with the new diff), "cancel" discards the edits and SKIPS the stage — the flight continues without parallel readiness (the feature stays serial; a later flight can retry). export-mode picks the evaluation flavor: raw (fast) or localized (agent-rewritten reasoning).',
    inputSchema: {
      flightId: z.string(),
      choice: z.string().optional().describe('One of the checkpoint\'s options.'),
      values: z.record(z.string(), z.string()).optional().describe('missing-env only: KEY→value map, written to the missing env file then captured.'),
      data: z.unknown().optional().describe('config-approval only: { configSource } with the hand-edited config — written through to the feature\'s on-disk feature.config.cjs before validation.'),
      feedback: z.string().optional().describe('prd-source agent choices and portify-apply "revise" only: for prd-source, what went wrong last time (added to the collector agent\'s prompt); for portify-apply revise (where it is REQUIRED), what the agent should change before the double-boot re-verify.'),
    },
  }, async ({ flightId, choice, values, data, feedback }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    const resp = await deps.flightsRequest({
      method: 'POST',
      url: `/api/flights/${encodeURIComponent(flightId)}/respond`,
      payload: { response: { ...(choice ? { choice } : {}), ...(values ? { values } : {}), ...(data !== undefined ? { data } : {}), ...(feedback ? { feedback } : {}) } },
    })
    if (resp.statusCode !== 200) {
      return errorResult(`respond failed (${resp.statusCode}): ${String((resp.body as { error?: string }).error ?? '')}`)
    }
    const view = flightView(resp.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })
}
