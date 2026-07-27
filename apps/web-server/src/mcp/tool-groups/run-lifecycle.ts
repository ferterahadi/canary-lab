// MCP tools — run lifecycle.
//
// Registration bodies are unchanged from the pre-split tools.ts; only the
// enclosing function is new. Add a tool here, then wire its name into the
// profile arrays in ../tool-support.ts (see the cl_add-mcp-tool skill).
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { normalizeRunCounts } from '../../features/runs/logic/heal/external-heal-surface'
import { isHealClaimAllowed } from '../../features/runs/logic/heal/heal-claim-policy'
import { isActiveRunStatus } from '../../../../../shared/run-state'
import { type ToolGroupContext,
  CLAIM_SUPPRESSED_MESSAGE,
  asJsonResult,
  bootSessionValue,
  claimRun,
  errorResult,
  findHealingRunForFeature,
  healWaitNext,
  isActiveBootRun,
  resolveRunRef,
  runCandidate } from '../tool-support'

export function registerRunLifecycleTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  // ─── run lifecycle ────────────────────────────────────────────────────

  registerTool('start_run', {
    description:
      'Smart entrypoint for runs. If a matching run is healing, returns it and blocks fresh/different starts until cancel_heal stops it. If runId/run_ref targets a failed/aborted run and no heal is active, restarts it in remaining-test mode (failed → skipped → pending/not-run). Otherwise starts a new run. To retry a failed/aborted run prefer this rerun path (pass run_ref) over abort_run + a fresh start — a fresh start re-runs the whole suite, only worth it when prior passes are invalidated (e.g. a global data/state change). The rerun path already re-runs skipped + pending tests (failed → skipped → pending/not-run), so it is complete — do NOT force_new just to avoid "skipped" tests; force_new on a portified feature spins a brand-new per-run worktree and resets the heal journal to Iteration 1, losing the prior cycles. After code changes call signal_run (hypothesis + fixDescription), then wait_for_heal_task on the same run.',
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
      force_new: z.boolean().default(false).describe('Start a fresh concurrent run even if a matching run is healing (it continues independently). A same-repo collision still asks you to choose isolation.'),
      isolation: z.enum(['worktree', 'queue']).optional().describe('Only needed after start_run returns repo_collision_requires_choice: "worktree" isolates this run in a per-run git worktree and starts it now (concurrent); "queue" waits until the conflicting run finishes.'),
    },
  }, async ({ feature, env, runId, run_ref, claim_heal, session_id, client_kind, conversation_name, guidance, force_new, isolation }) => {
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
      // Default (no explicit ref, no force_new): continue the run that's
      // already healing for this feature — the external-heal continuation
      // pattern. With concurrency, `force_new` (or targeting a different run)
      // no longer blocks: it falls through to a fresh concurrent start, where
      // same-repo collisions surface a worktree/queue choice.
      const healing = findHealingRunForFeature(deps, feature, env)
      if (healing && !force_new && !requestedRef) {
        const claim = claimAllowed ? claimRun(deps, healing.manifest.runId, session_id, client_kind, conversation_name) : null
        return asJsonResult({
          runId: healing.manifest.runId,
          reused: true,
          status: healing.manifest.status,
          claimed: claimAllowed ? claim?.accepted === true : false,
          claim,
          ...suppressionFields,
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
      )
      if (outcome.kind === 'collision') {
        // Same-repo collision and the client didn't choose. Nothing started —
        // ask the user, then re-call start_run with isolation:"worktree"|"queue".
        return asJsonResult({
          type: 'repo_collision_requires_choice',
          conflictingRunId: outcome.conflictingRunId,
          conflictingFeature: outcome.conflictingFeature,
          repoPaths: outcome.repoPaths,
          options: outcome.options,
          message: outcome.message,
          nextSteps: ['ask_user_worktree_or_queue'],
        })
      }
      if (outcome.kind === 'queued') {
        return asJsonResult({
          runId: outcome.runId,
          reused: false,
          queued: true,
          queueReason: outcome.reason,
          claimed: claimAllowed,
          ...suppressionFields,
          ...(claimAllowed ? healWaitNext() : {}),
        })
      }
      return asJsonResult({
        runId: outcome.runId,
        reused: false,
        claimed: claimAllowed,
        ...suppressionFields,
        ...(claimAllowed ? healWaitNext() : {}),
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('boot_services', {
    description:
      "Apply the feature's envset and boot its services, then HOLD them — no Playwright tests, no heal loop. Use this to bring an app up so you (or the user) can exercise it manually. The run stays active until torn down with `abort_run`, which stops the services and reverts the envset. Same-repo collisions and resource limits behave exactly like start_run (returns repo_collision_requires_choice / queued).",
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      env: z.string().optional().describe("Envset name. Defaults to the feature's first declared env."),
      isolation: z.enum(['worktree', 'queue']).optional().describe('Only needed after this returns repo_collision_requires_choice: "worktree" boots in a per-run git worktree (concurrent); "queue" waits until the conflicting run finishes.'),
    },
  }, async ({ feature, env, isolation }) => {
    try {
      const outcome = await deps.startRun(feature, env, undefined, isolation, 'boot')
      if (outcome.kind === 'collision') {
        return asJsonResult({
          type: 'repo_collision_requires_choice',
          conflictingRunId: outcome.conflictingRunId,
          conflictingFeature: outcome.conflictingFeature,
          repoPaths: outcome.repoPaths,
          options: outcome.options,
          message: outcome.message,
          nextSteps: ['ask_user_worktree_or_queue'],
        })
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
        nextSteps: ['services are booting and will be held — exercise them, then call abort_run (confirm:true) to stop services + revert the envset. A service that fails its readiness probe is marked failed (status "timeout") but the session stays held; boot does not self-abort on a health-check failure'],
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
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
      'Hard-abort an active run. Requires `confirm: true` because this kills Playwright + services and cannot be undone. Do not abort just to re-run: for an active healing run use `signal_run`, and to retry a failed/aborted run pass its `run_ref` to `start_run` (rerun, remaining-test mode). Abort is for killing a run you no longer want.',
    inputSchema: {
      runId: z.string(),
      confirm: z.literal(true).describe('Must be true. Guard against accidental aborts.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ runId }) => {
    const result = await deps.store.abort(runId)
    if (!result.ok) return errorResult(`could not abort: ${result.reason}`)
    return asJsonResult({ aborted: true, runId })
  })

}
