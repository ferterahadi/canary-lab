// MCP tools — external heal flow.
//
// Registration bodies are unchanged from the pre-split tools.ts; only the
// enclosing function is new. Add a tool here, then wire its name into the
// profile arrays in ../tool-support.ts (see the cl_add-mcp-tool skill).
import { z } from 'zod'
import { writeHealSignal } from '../../features/runs/logic/heal/external-heal-surface'
import { isActiveRunStatus } from '../../../../../shared/run-state'
import { type ToolGroupContext, HEAL_STATUS, SIGNAL_KIND, WAIT_FOR_HEAL_TASK_DEFAULT_TIMEOUT_MS, WAIT_FOR_HEAL_TASK_MAX_TIMEOUT_MS, asJsonResult, ensureExternalClaimForMcpCall, errorResult, failureResult, hasText, healWaitNext, waitForHealTask } from '../tool-support'

export function registerHealFlowTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  // ─── external heal flow ───────────────────────────────────────────────

  registerTool('claim_heal', {
    description:
      'Claim heal duty for a run as this external session. Idempotent if the same session_id is already the holder; rejected with already-claimed if a different session holds it.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string(),
      client_kind: clientKindInput,
      client_version: z.string().optional(),
      conversation_name: z.string().optional(),
    },
  }, async ({ runId, session_id, client_kind, client_version, conversation_name }) => {
    if (!deps.store.get(runId)) return errorResult(`run not found: ${runId}`)
    const result = deps.broker.claim(runId, {
      sessionId: session_id,
      clientKind: client_kind,
      ...(client_version ? { clientVersion: client_version } : {}),
      ...(conversation_name ? { conversationName: conversation_name } : {}),
    })
    if (!result.accepted) {
      if (result.reason === 'client-kind-not-allowed') {
        return errorResult(
          `client-kind-not-allowed: heal claiming is open to interactive Claude/Codex clients (Desktop or CLI); it is suppressed only for runner-spawned PTY agents Canary Lab launches itself (this client is ${result.clientKind}). The run can still be run/verified; drive heal from an interactive client or the web UI.`,
        )
      }
      return errorResult(`already-claimed by session ${result.currentSession.sessionId} (${result.currentSession.clientKind})`)
    }
    return asJsonResult({ accepted: true, session: result.session })
  })

  registerTool('release_heal', {
    description: 'Release a heal claim. No-op if the session_id does not match the current holder.',
    inputSchema: { runId: z.string(), session_id: z.string() },
  }, async ({ runId, session_id }) => {
    const result = deps.broker.release(runId, session_id)
    return asJsonResult({ released: result.released })
  })

  registerTool('heartbeat', {
    description: 'Refresh external heal session liveness. Sessions auto-disconnect after 10 min without MCP traffic; signal_run / get_heal_context also refresh it, so you rarely need to call this explicitly.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string(),
      client_kind: clientKindInput,
      status: HEAL_STATUS.default('connected'),
    },
  }, async ({ runId, session_id, client_kind, status }) => {
    ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    const result = deps.broker.heartbeat(runId, session_id, status)
    if (!result.ok) return errorResult(`heartbeat rejected: ${result.reason}`)
    return asJsonResult({ ok: true, session: result.session })
  })

  registerTool('wait_for_heal_task', {
    description:
      'Wait until a claimed run needs code fixes or reaches a terminal result. Use after start_run/claim_heal and again after signal_run. Blocks for a short bounded window and heartbeats for you. If still active when the window elapses it returns type:"still_waiting" (NOT terminal) — immediately call wait_for_heal_task again with the same runId + session_id. Loop on still_waiting until needs_heal / passed / failed. Never poll get_run_snapshot or get_run to wait. A needs_heal task may be a service that failed to boot (no tests ran): context.failedTests is empty and context.bootFailure points at the service log — fix the service/app code, then signal_run kind:"restart".',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().describe('External heal session id that owns this run.'),
      client_kind: clientKindInput,
      timeout_ms: z.number().int().positive().max(WAIT_FOR_HEAL_TASK_MAX_TIMEOUT_MS)
        .default(WAIT_FOR_HEAL_TASK_DEFAULT_TIMEOUT_MS)
        .describe('Per-call block budget in ms (default 90s). A single call blocks at most ~2 minutes regardless; larger values are clamped, then you get still_waiting to loop on. This is not the overall heal budget — that is unbounded across re-calls.'),
    },
  }, async ({ runId, session_id, client_kind, timeout_ms }) => {
    const result = await waitForHealTask(deps, runId, session_id, client_kind, timeout_ms)
    return result.ok ? asJsonResult(result.value) : errorResult(result.error)
  })

  registerTool('signal_run', {
    description:
      'Write a heal-cycle signal. The orchestrator picks it up via its existing poll loop and writes the diagnosis journal from this signal plus runner-observed git diff. Use `rerun` for test-only fixes (no service restart) and `restart` when services need to be restarted.',
    inputSchema: {
      runId: z.string(),
      kind: SIGNAL_KIND,
      session_id: z.string().optional().describe('Required when the run holds an external claim; must match the claim holder.'),
      client_kind: clientKindInput,
      hypothesis: z.string().optional().describe('Required for restart/rerun. Concise diagnosis of what was wrong.'),
      fixDescription: z.string().optional().describe('Required for restart/rerun. Concise summary of what the fix changed.'),
    },
  }, async ({ runId, kind, session_id, client_kind, hypothesis, fixDescription }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (!isActiveRunStatus(detail.manifest.status)) {
      return errorResult(`run not active (status=${detail.manifest.status})`)
    }
    if ((kind === 'restart' || kind === 'rerun') && (!hasText(hypothesis) || !hasText(fixDescription))) {
      return errorResult('restart/rerun signal requires hypothesis and fixDescription')
    }
    if (session_id) ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    const ownership = deps.broker.assertOwnership(runId, session_id)
    if (!ownership.ok && ownership.reason === 'session-mismatch') {
      return errorResult(`session-mismatch: run is held by ${ownership.currentSession?.sessionId}`)
    }
    if (session_id) deps.broker.touch(runId, session_id)
    const body = kind === 'restart' || kind === 'rerun'
      ? { hypothesis: hypothesis!.trim(), fixDescription: fixDescription!.trim() }
      : {}
    let signal: ReturnType<typeof writeHealSignal>
    try {
      signal = writeHealSignal({ logsDir: deps.store.logsDir, runId, kind, body })
    } catch (err) {
      return errorResult(`could not write signal: ${(err as Error).message}`)
    }
    deps.broker.bumpCycle(runId)
    return asJsonResult({ accepted: true, kind, path: signal.path, runId, ...healWaitNext() })
  })

  registerTool('handoff_heal', {
    description:
      'Hand off heal duty from this external session to a local heal mode (auto/claude/codex/manual). For active runs only manual is supported (the orchestrator cannot hot-swap to a local agent); for failed/aborted runs auto/claude/codex restart the heal with a fresh agent.',
    inputSchema: {
      runId: z.string(),
      to: z.enum(['auto', 'claude', 'codex', 'manual']),
      session_id: z.string().optional().describe('External heal session id. Required when the run holds an external claim and the caller is not the broker holder.'),
      guidance: z.string().optional().describe('Optional context passed to the restarted local heal agent. Ignored for to=manual.'),
      confirm: z.literal(true).describe('Must be true. Guards against accidental handoffs.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ runId, to, session_id, guidance }) => {
    if (!deps.handoffHeal) return errorResult('handoffHeal dependency is not configured')
    try {
      const result = await deps.handoffHeal(runId, to, session_id, guidance)
      if (result.statusCode >= 200 && result.statusCode < 300) {
        return asJsonResult(result.body)
      }
      const body = result.body
      const message = body && typeof body === 'object' && 'reason' in body
        ? `${(body as { reason: string }).reason}${'message' in body ? `: ${(body as { message: string }).message}` : ''}`
        : typeof body === 'string' ? body : `handoff failed (${result.statusCode})`
      return errorResult(message)
    } catch (err) {
      return failureResult(err)
    }
  })
}
