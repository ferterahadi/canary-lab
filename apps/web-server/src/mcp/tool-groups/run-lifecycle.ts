// MCP tools — run lifecycle.
//
// Add a tool here, then wire its name into the
// profile arrays in ../tool-support.ts (see the cl_add-mcp-tool skill).
import { z } from 'zod'
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server'
import { applyUserInput, completedUserInput, inputPending, matchesUserInput, requestNextUserInput, requestUserInput } from '../elicitation'
import { normalizeRunCounts } from '../../features/runs/logic/heal/external-heal-surface'
import { isHealClaimAllowed } from '../../features/runs/logic/heal/heal-claim-policy'
import { isActiveRunStatus } from '../../../../../shared/run-state'
import { type ToolGroupContext, CLAIM_SUPPRESSED_MESSAGE, asJsonResult, bootSessionValue, claimRun, errorResult, failureResult, findContinuingRunForFeature, healWaitNext, isActiveBootRun, resolveRunRef, runCandidate } from '../tool-support'
import { readCoverageUpdate } from '../coverage-catchup'

const coverageChangeResponse = z.object({
  change: z.object({
    feature: z.string(),
    freshness: z.object({
      revision: z.string(),
      state: z.enum(['current', 'stale', 'unavailable', 'updating', 'not-measured']),
      reasons: z.array(z.string()),
      changedTests: z.array(z.string()),
      nextAction: z.object({
        stage: z.enum(['prd-summary', 'specs-coverage', 'run']),
        label: z.string(),
        command: z.enum(['start_external_summary', 'start_external_coverage', 'start_run']),
        arguments: z.object({ feature: z.string() }),
      }).optional(),
    }),
    activeJobId: z.string().optional(),
    activeJobOwner: z.string().optional(),
    flightId: z.string().optional(),
    flightStatus: z.string().optional(),
  }),
})

type CoverageChange = z.infer<typeof coverageChangeResponse>['change']
type CoverageDecision = { revision: string; allowStale: boolean; change?: CoverageChange }

export function registerRunLifecycleTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  // ─── run lifecycle ────────────────────────────────────────────────────

  registerTool('start_run', {
    description:
      'Start or continue a run. Before a fresh run, stale test-to-requirement coverage asks the user whether to update coverage first or run now with the historical percentage explicitly qualified; no run starts while that choice is pending. A matching active run is reused even with force_new:true, and run_ref resumes an ordinary failed/aborted run with its recorded suite and journal, so neither path is blocked by current coverage freshness. An intentional concurrent run of the same feature must be started from the Run panel. Fresh starts reject pending suite changes unless a human durably approved the exact terminal-run revision; after that approval start without run_ref, and only the new run can produce a verdict. After a code fix use signal_run (hypothesis + fixDescription), then wait_for_heal_task on the same run. Ordinary skips remain incomplete; only reporter-observed, predeclared environment exclusions settle as not applicable and never count as passes.',
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      env: z.string().optional().describe('Envset name. Defaults to the feature\'s first declared env.'),
      runId: z.string().optional().describe('Exact run id to resume/restart. A different run currently healing blocks this.'),
      run_ref: z.string().optional().describe('Exact run id or unique suffix (e.g. "7cvh") to resume/restart. A different run currently healing blocks this.'),
      claim_heal: z.boolean().default(true).describe('Claim this run\'s heal duty for the current MCP session.'),
      session_id: z.string().describe('Stable id for this MCP/agent session. Reuse across calls in one conversation to enable reconnects.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional().describe('Human label shown in the Canary Lab UI (e.g. "fix checkout").'),
      guidance: z.string().optional().describe('Optional user guidance when restarting a failed/aborted run by runId or run_ref.'),
      force_new: z.boolean().default(false).describe('Request a fresh run only when no matching run is active and no pending test review would be bypassed. A terminal review must first carry durable human approval for its exact revision. An active run is reused even when true; use the Run panel for an intentional separate concurrent run.'),
      isolation: z.enum(['worktree', 'queue']).optional().describe('Only needed after start_run returns repo_collision_requires_choice: "worktree" isolates this run in a per-run git worktree and starts it now (concurrent); "queue" waits until the conflicting run finishes.'),
      update_repos: z.boolean().optional().describe('Fast-forward each declared repo checkout to its upstream tip (git fetch + ff-only) before booting, so the run tests the branch\'s latest commit rather than whatever was checked out. Omitted = only repos with `track: \'upstream\'` in feature.config.cjs; true = every repo; false = none. Refused (type:"repo_update_refused", nothing started) when a checkout is dirty, has diverged, or an in-place run is booted from it — local work is never discarded; get_feature_repo_status shows behindUpstream first. Fresh starts only.'),
      perturbation: z.record(z.string(), z.unknown()).optional().describe('Robustness envelope (the `envelope` object from a get_robustness finding, or the suite\'s robustness/envelope.json) to boot the services under: latency, duplicated writes and slot restarts through a per-slot proxy. Use it to repair a Robustness Lab finding — the failing test fails again under the same environment, and the heal context carries `perturbation` (with a one-line `repro`) so the fix targets the app\'s tolerance, not the test. Applies to fresh starts only; omitted = unperturbed.'),
    },
  }, async (args, request) => {
    const { feature, env, runId, run_ref, claim_heal, session_id, client_kind, conversation_name, guidance, force_new, perturbation, update_repos } = args
    const coverageScope = ['run-coverage-preflight', deps.projectRoot, args]
    const coverageChoiceSchema = z.object({ choice: z.enum(['Update coverage first', 'Run now with stale coverage']) })
    const isolationSchema = z.object({ isolation: z.enum(['worktree', 'queue']) })
    const coverageRevision = (change: CoverageChange | undefined): string => change?.freshness.revision ?? 'coverage-check-unavailable'
    const requiresCoverageChoice = (change: CoverageChange | undefined): change is CoverageChange =>
      change?.freshness.state === 'stale' && change.freshness.nextAction?.stage === 'specs-coverage'
    const readCoverage = async (): Promise<CoverageChange | undefined> => {
      const parsed = coverageChangeResponse.safeParse(await readCoverageUpdate(feature, deps))
      return parsed.success ? parsed.data.change : undefined
    }
    const coverageRecovery = (change: CoverageChange): CallToolResult => {
      const owner = change.activeJobId
        ? `Coverage job ${change.activeJobId}${change.activeJobOwner ? ` (${change.activeJobOwner})` : ''} already owns this update; follow it instead of starting another.`
        : change.flightId
          ? `Flight ${change.flightId}${change.flightStatus ? ` is ${change.flightStatus}` : ''} owns this update; resume it instead of starting duplicate coverage work.`
          : 'Call start_external_coverage, submit the mapping, confirm freshness, then retry start_run.'
      return asJsonResult({
        type: 'coverage_update_required',
        runStarted: false,
        feature,
        freshness: change.freshness,
        ...(change.activeJobId ? { activeJobId: change.activeJobId, activeJobOwner: change.activeJobOwner } : {}),
        ...(change.flightId ? { flightId: change.flightId, flightStatus: change.flightStatus } : {}),
        message: `Run not started. ${owner}`,
        nextSteps: change.activeJobId || change.flightId
          ? ['follow the existing coverage owner', 'confirm coverage freshness', 'retry start_run']
          : ['start_external_coverage', 'submit_external_coverage', 'get_feature_coverage', 'start_run'],
      })
    }
    const coverageQuestion = (change: CoverageChange | undefined) => ({
      scope: coverageScope,
      revision: coverageRevision(change),
      mode: 'form' as const,
      schema: coverageChoiceSchema,
    })
    const isolationScope = (decision: CoverageDecision) => [
      decision.allowStale ? 'run-isolation-after-stale-coverage' : 'run-isolation-after-coverage-check',
      deps.projectRoot,
      args,
    ]
    const isolationQuestion = (decision: CoverageDecision) => ({
      scope: isolationScope(decision),
      revision: decision.revision,
      mode: 'form' as const,
      schema: isolationSchema,
    })
    const askCoverage = (
      change: CoverageChange,
      nextRound: boolean,
    ): Promise<CallToolResult | InputRequiredResult> => {
      const spec = {
        ...coverageQuestion(change),
        message: `${change.freshness.reasons.join(' ')} Previous coverage percentages do not describe the current tests. Update coverage before running, or run now for diagnostics with coverage still marked stale?`,
        fallback: () => asJsonResult({
          type: 'coverage_update_requires_choice',
          runStarted: false,
          feature,
          freshness: change.freshness,
          options: ['Update coverage first', 'Run now with stale coverage'],
          message: 'Ask the user whether to update coverage first or run now with stale coverage. Do not start a run until they choose.',
          nextSteps: ['ask_user_update_coverage_or_run_now'],
        }),
      }
      const chosen = async (answer: z.infer<typeof coverageChoiceSchema>) => answer.choice === 'Update coverage first'
        ? coverageRecovery(change)
        : begin(args.isolation, { revision: change.freshness.revision, allowStale: true, change }, true)
      return nextRound
        ? Promise.resolve(requestNextUserInput(request, ctx.clientFacts(), spec, chosen))
        : requestUserInput(request, ctx.clientFacts(), spec, chosen)
    }
    const askIsolation = (
      decision: CoverageDecision,
      fallback: () => CallToolResult,
      message: string,
      nextRound: boolean,
    ): Promise<CallToolResult | InputRequiredResult> => {
      const spec = { ...isolationQuestion(decision), message, fallback }
      const chosen = async (answer: z.infer<typeof isolationSchema>) => begin(answer.isolation, decision, true)
      return nextRound
        ? Promise.resolve(requestNextUserInput(request, ctx.clientFacts(), spec, chosen))
        : requestUserInput(request, ctx.clientFacts(), spec, chosen)
    }
    const begin = async (
      isolation = args.isolation,
      approvedCoverage?: CoverageDecision,
      answeringQuestion = false,
    ): Promise<CallToolResult | InputRequiredResult> => {
      try {
        const requestedRef = runId ?? run_ref
        // Heal-claim policy (see heal-claim-policy.ts): claiming is open to every
        // human-driven interactive client — claude/codex (Desktop or CLI) and even
        // undetected 'other'. The ONLY kinds blocked are runner-spawned PTY agents
        // (claude-pty/codex-pty), which would otherwise claim their own run. A
        // blocked client may still start/verify the run, but must not own its heal
        // loop — so we down-shift claim_heal to false and tell the caller, instead
        // of grabbing heal duty behind their back.
        const claimAllowed = claim_heal && isHealClaimAllowed(client_kind)
        const claimSuppressed = claim_heal && !claimAllowed
        const suppressionFields = claimSuppressed
          ? { claimSuppressed: true, message: CLAIM_SUPPRESSED_MESSAGE }
          : {}
        // An agent cannot turn a repair into a new baseline by setting a flag.
        // Deliberate concurrent runs remain available through the human Run UI.
        const healing = findContinuingRunForFeature(deps, feature, env)
        if (healing && (!requestedRef || force_new)) {
          const claim = claimAllowed ? claimRun(deps, healing.manifest.runId, session_id, client_kind, conversation_name) : null
          return asJsonResult({
            runId: healing.manifest.runId,
            reused: true,
            status: healing.manifest.status,
            claimed: claimAllowed ? claim?.accepted === true : false,
            claim,
            ...suppressionFields,
            ...(force_new ? { freshStartBlocked: true, message: 'Continue this run with signal_run. A separate concurrent run must be started from the Run panel.' } : {}),
            ...(claimAllowed ? healWaitNext() : {}),
          })
        }
        if (requestedRef) {
          const resolved = resolveRunRef(deps, feature, env, requestedRef)
          if (resolved.kind === 'missing') return errorResult(`run-not-found: ${requestedRef}`)
          if (resolved.kind === 'ambiguous') {
            return asJsonResult({
              type: 'ambiguous_run_ref',
              run_ref: requestedRef,
              candidates: resolved.candidates.map(runCandidate),
            })
          }
          const target = resolved.detail
          const status = target.manifest.status
          if (isActiveBootRun(target)) {
            // Boot-only sessions hold services up with no tests and no heal loop.
            // Don't claim heal or tell the caller to wait_for_heal_task.
            return asJsonResult({ ...bootSessionValue(target), reused: true })
          }
          if (isActiveRunStatus(status)) {
            const claim = claimAllowed ? claimRun(deps, target.manifest.runId, session_id, client_kind, conversation_name) : null
            return asJsonResult({
              runId: target.manifest.runId,
              reused: true,
              status,
              claimed: claimAllowed ? claim?.accepted === true : false,
              claim,
              ...suppressionFields,
              ...(claimAllowed ? healWaitNext() : {}),
            })
          }
          if (status === 'passed') {
            return asJsonResult({
              type: 'not_restartable',
              runId: target.manifest.runId,
              status,
              message: 'Passed runs are not restarted by start_run. Start a fresh run without runId/run_ref if you want to test again.',
            })
          }
          if (status !== 'failed' && status !== 'aborted') {
            return errorResult(`run-not-restartable: ${target.manifest.runId} status=${status}`)
          }
          if (!deps.restartExternalRun) return errorResult('restartExternalRun dependency is not configured')
          // Restarting a failed run re-enters external heal. A disallowed (CLI /
          // 'other') client may still trigger the restart — it just can't own the
          // loop: `claimable: false` restarts into external mode with no session
          // and no broker claim, so the run waits for a Desktop/UI drive rather
          // than silently restarting into a session the client owns.
          const restarted = await deps.restartExternalRun(
            target.manifest.runId,
            {
              kind: 'external',
              sessionId: session_id,
              clientKind: client_kind,
              ...(conversation_name ? { conversationName: conversation_name } : {}),
              claimable: claimAllowed,
            },
            guidance,
          )
          const claim = claimAllowed ? claimRun(deps, restarted.runId, session_id, client_kind, conversation_name) : null
          const counts = normalizeRunCounts(target.summary ?? null)
          return asJsonResult({
            runId: restarted.runId,
            reused: true,
            restarted: true,
            mode: restarted.mode ?? 'remaining',
            statusLine: counts.statusLine,
            counts,
            status: 'running',
            claimed: claimAllowed ? claim?.accepted === true : false,
            claim,
            ...suppressionFields,
            ...(claimAllowed ? healWaitNext() : {}),
          })
        }
        const coverage = await readCoverage()
        const revision = coverageRevision(coverage)
        if (approvedCoverage && approvedCoverage.revision !== revision) {
          return inputPending('Coverage changed while the question was open. Nothing was applied; review current coverage before resuming.')
        }
        if (requiresCoverageChoice(coverage) && !approvedCoverage?.allowStale) {
          return askCoverage(coverage, answeringQuestion)
        }
        const coverageDecision: CoverageDecision = approvedCoverage ?? { revision, allowStale: false, change: coverage }
        const coverageQualification = coverageDecision.allowStale ? {
          coverageStale: true,
          coverageRevision: coverageDecision.revision,
          coverageReasons: coverageDecision.change?.freshness.reasons ?? [],
          coverageMessage: 'This diagnostic run does not update or validate the stale coverage mapping.',
        } : {}

        // Any MCP-triggered run is external-origin: it must use External-client
        // heal regardless of the project's Heal Agent setting (which only governs
        // UI-triggered runs). `claimable` is what splits a Desktop client that
        // owns the loop from a CLI/'other' client that can't — the latter still
        // runs in external mode and waits for a Desktop/UI drive instead of
        // falling back to a locally-spawned auto-heal agent.
        const outcome = await deps.startRun(
          feature,
          env,
          {
            kind: 'external',
            sessionId: session_id,
            clientKind: client_kind,
            ...(conversation_name ? { conversationName: conversation_name } : {}),
            claimable: claimAllowed,
          },
          isolation,
          undefined,
          perturbation,
          update_repos,
        )
        if (outcome.kind === 'getting-started-busy') {
          return asJsonResult({
            type: 'getting_started_busy',
            active: outcome.active,
            message: outcome.message,
            nextSteps: ['follow the active demo in its current owner; do not start another run or flight'],
          })
        }
        if (outcome.kind === 'repo-update-refused') {
          // A tracked repo could not be brought to its upstream tip. Nothing
          // started; the rows say what to reconcile, and update_repos:false is
          // the explicit way to boot the checked-out commit anyway.
          return asJsonResult({
            type: 'repo_update_refused',
            feature,
            repos: outcome.repos,
            message: outcome.message,
            nextSteps: [
              'tell the user which repo refused and why (dirty / diverged / in-use); do not stash, reset or discard their work',
              'once they have reconciled, re-call start_run; or re-call with update_repos:false to boot the checked-out commit as-is',
            ],
          })
        }
        if (outcome.kind === 'collision') {
          // Same-repo collision and the client didn't choose. Nothing started —
          // ask the user, then re-call start_run with isolation:"worktree"|"queue".
          return askIsolation(coverageDecision, () => asJsonResult({
            type: 'repo_collision_requires_choice',
            conflictingRunId: outcome.conflictingRunId,
            conflictingFeature: outcome.conflictingFeature,
            repoPaths: outcome.repoPaths,
            options: outcome.options,
            message: outcome.message,
            nextSteps: ['ask_user_worktree_or_queue'],
          }), outcome.message, answeringQuestion)
        }
        if (outcome.kind === 'queued') {
          return asJsonResult({
            runId: outcome.runId,
            reused: false,
            queued: true,
            queueReason: outcome.reason,
            claimed: claimAllowed,
            ...suppressionFields,
            ...coverageQualification,
            ...(claimAllowed ? healWaitNext() : {}),
          })
        }
        return asJsonResult({
          runId: outcome.runId,
          reused: false,
          claimed: claimAllowed,
          ...suppressionFields,
          ...coverageQualification,
          ...(claimAllowed ? healWaitNext() : {}),
        })
      } catch (err) {
        return failureResult(err)
      }
    }
    const state = request?.mcpReq.requestState?.()
    if (state === undefined) return begin()

    // start_run can ask coverage first and repository isolation second. Route
    // the opaque handle to its exact question; never interpret one answer as
    // the other or let a stale approval authorize a changed coverage revision.
    const coverage = await readCoverage()
    if (matchesUserInput(request, coverageScope)) {
      const spec = coverageQuestion(coverage)
      return applyUserInput(request, spec, async (answer) => {
        if (!requiresCoverageChoice(coverage)) return inputPending('Coverage changed while the question was open. Nothing was applied; review current coverage before resuming.')
        return answer.choice === 'Update coverage first'
          ? coverageRecovery(coverage)
          : begin(args.isolation, { revision: coverage.freshness.revision, allowStale: true, change: coverage }, true)
      })
    }
    for (const allowStale of [false, true]) {
      const decision: CoverageDecision = { revision: coverageRevision(coverage), allowStale, change: coverage }
      if (!matchesUserInput(request, isolationScope(decision))) continue
      return applyUserInput(request, isolationQuestion(decision), async (answer) => begin(answer.isolation, decision, true))
    }
    return applyUserInput(request, coverageQuestion(coverage), async () => inputPending('The input request belongs to a different operation. Nothing was applied.'))
  })

  registerTool('boot_services', {
    description:
      "Apply the feature's envset and boot its services, then HOLD them — no Playwright tests, no heal loop. Use this to bring an app up so you (or the user) can exercise it manually. The run stays active until torn down with `abort_run`, which stops the services and reverts the envset. Same-repo collisions and resource limits behave exactly like start_run (returns repo_collision_requires_choice / queued).",
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      env: z.string().optional().describe("Envset name. Defaults to the feature's first declared env."),
      isolation: z.enum(['worktree', 'queue']).optional().describe('Only needed after this returns repo_collision_requires_choice: "worktree" boots in a per-run git worktree (concurrent); "queue" waits until the conflicting run finishes.'),
    },
  }, async (args, request) => {
    const { feature, env } = args
    const isolationQuestion = { scope: ['boot-isolation', deps.projectRoot, args], mode: 'form' as const, schema: z.object({ isolation: z.enum(['worktree', 'queue']) }) }
    // One `chosen` for both entries: the fresh ask never runs it (it returns the
    // question), and the answering call reaches it through `applyUserInput`.
    const chosen = async (answer: { isolation: 'worktree' | 'queue' }) => begin(answer.isolation)
    const ask = (fallback: () => CallToolResult, message = 'Boot in an isolated worktree now, or queue until the repositories are free?') =>
      requestUserInput(request, ctx.clientFacts(), { ...isolationQuestion, message, fallback }, chosen)
    const begin = async (isolation = args.isolation): Promise<CallToolResult | InputRequiredResult> => {
      try {
        const outcome = await deps.startRun(feature, env, undefined, isolation, 'boot')
        if (outcome.kind === 'getting-started-busy') {
          return asJsonResult({
            type: 'getting_started_busy',
            active: outcome.active,
            message: outcome.message,
            nextSteps: ['follow the active demo in its current owner; do not start another run or flight'],
          })
        }
        if (outcome.kind === 'repo-update-refused') {
          // Boots honour the feature's `track: 'upstream'` setting too, so a
          // dirty or diverged checkout stops the boot the same way it stops a
          // run. boot_services has no update_repos switch; use start_run for
          // an explicit as-is boot of the checked-out commit.
          return asJsonResult({
            type: 'repo_update_refused',
            feature,
            repos: outcome.repos,
            message: outcome.message,
            nextSteps: [
              'tell the user which repo refused and why (dirty / diverged / in-use); do not stash, reset or discard their work',
              'once they have reconciled, re-call boot_services',
            ],
          })
        }
        if (outcome.kind === 'collision') {
          return ask(() => asJsonResult({
            type: 'repo_collision_requires_choice',
            conflictingRunId: outcome.conflictingRunId,
            conflictingFeature: outcome.conflictingFeature,
            repoPaths: outcome.repoPaths,
            options: outcome.options,
            message: outcome.message,
            nextSteps: ['ask_user_worktree_or_queue'],
          }), outcome.message)
        }
        if (outcome.kind === 'queued') {
          return asJsonResult({
            runId: outcome.runId,
            queued: true,
            queueReason: outcome.reason,
            nextSteps: ['boot starts automatically when capacity frees; stop it with abort_run when done'],
          })
        }
        return asJsonResult({
          runId: outcome.runId,
          booted: true,
          nextSteps: ['services are booting and will be held — exercise them, then request abort_run and let the human accept its stop form to stop services + revert the envset. A service that fails its readiness probe is marked failed (status "timeout") but the session stays held; boot does not self-abort on a health-check failure'],
        })
      } catch (err) {
        return failureResult(err)
      }
    }
    // A call carrying requestState is ANSWERING the isolation question, not asking
    // to start again: matching it to the open question is what turns the user's
    // choice into the boot. It needs no capability fallback — the answer is here.
    return request?.mcpReq.requestState?.() !== undefined ? applyUserInput(request, isolationQuestion, chosen) : begin()
  })

  registerTool('pause_run', {
    description: 'Pause an active run and jump into heal mode immediately.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const orch = deps.store.registry.get(runId)
    if (!orch) return errorResult(`run not active: ${runId}`)
    const result = await orch.pauseAndHeal()
    if (!result.ok) return errorResult(`could not pause: ${result.reason}`)
    return asJsonResult({ status: 'healing', failureCount: result.failureCount })
  })

  registerTool('cancel_heal', {
    description: 'Cancel an in-flight heal cycle. Run transitions to failed.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const orch = deps.store.registry.get(runId)
    if (!orch) return errorResult(`run not active: ${runId}`)
    const result = await orch.cancelHeal()
    if (!result.ok) return errorResult(`could not cancel: ${result.reason}`)
    return asJsonResult({ status: 'cancelled' })
  })

  registerTool('abort_run', {
    description:
      'Request human confirmation to stop an active run and its services. An agent-supplied confirm:true does not authorize cancellation. The owning command opens a user form; clients without forms must use the Run panel Stop action. Do not abort just to re-run: use signal_run for an active healing run, or start_run with run_ref for a failed/aborted run.',
    inputSchema: {
      runId: z.string(),
      confirm: z.literal(true).describe('Must be true. Compatibility flag only; the human must accept the stop form.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ runId }, request) => {
    const scope = ['abort-run', deps.projectRoot, runId]
    const completed = completedUserInput(request, scope)
    if (completed) return completed
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (!isActiveRunStatus(detail.manifest.status)) return errorResult(`run not active: ${runId}`)
    return requestUserInput(request, ctx.clientFacts(), {
      scope,
      revision: [detail.manifest.startedAt, detail.manifest.status, detail.manifest.healCycles],
      mode: 'form',
      schema: z.object({ action: z.enum(['keep', 'abort']).describe('Keep the existing run, or stop it and its services.') }),
      message: `Stop run ${runId} (${detail.manifest.feature}) and its services? Keeping it preserves the current repair cycle.`,
      fallback: () => asJsonResult({
        type: 'abort_requires_confirmation', runId,
        message: 'Stop this run from its Run panel. confirm:true from an agent is not a human cancellation decision.',
        nextSteps: ['continue the existing run with signal_run, or let the human stop it in Canary Lab'],
      }),
    }, async ({ action }) => {
      if (action === 'keep') return inputPending('The user kept the run. Nothing was stopped.')
      const result = await deps.store.abort(runId)
      return result.ok ? asJsonResult({ aborted: true, runId }) : errorResult(`could not abort: ${result.reason}`)
    })
  })

}
