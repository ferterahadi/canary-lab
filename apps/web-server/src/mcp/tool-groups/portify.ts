// MCP tools — port-ification (make a feature's apps take injectable ports) plus
// the two external heal-context reads. Split out of authoring.ts; bodies unchanged.
import { z } from 'zod'
import { buildExternalFailureDetail, buildExternalHealContext } from '../../features/runs/logic/heal/external-heal-surface'
import { loadFeatures } from '../../shared/feature-loader'
import { computePortPreflight } from '../../features/runs/logic/runtime/port-preflight'
import { publishWorkspaceEvent } from '../../shared/workspace-events'
import { overlayExists as portifyOverlayExists } from '../../features/portify/logic/runtime/overlay'
import { portInjectability } from '../../../../../shared/launcher/port-injectability'
import { type ToolGroupContext, asJsonResult, ensureExternalClaimForMcpCall, errorResult, failureResult, summarizeUnifiedDiff } from '../tool-support'

export function registerPortifyTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  // ── Port-ification (make a feature's apps use injectable ports) ──────────
  registerTool('start_external_portify', {
    description: "Start a port-ification workflow YOU drive — no local agent. Canary sets up a scratch worktree per repo and returns the edit paths + task. Edit the listeners to read injected ports IN PLACE, declare the `ports` slots in the feature config, then submit_external_portify to verify (concurrent double-boot); save_portify captures the result as the feature's overlay. Async — returns a workflowId + targets; one workflow PER FEATURE (different features can port-ify concurrently up to a resource cap, so you can fan out a subagent per feature; at capacity start_external_portify returns a 429 — wait for one to finish, or save/cancel it).",
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      session_id: z.string().describe('Stable id for your conversation — reuse it across calls.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, session_id, client_kind, conversation_name, external_session_url }) => {
    if (!deps.startExternalPortify) return errorResult('startExternalPortify dependency is not configured')
    try {
      const result = await deps.startExternalPortify({
        feature,
        clientKind: client_kind,
        sessionId: session_id,
        ...(conversation_name ? { conversationName: conversation_name } : {}),
        ...(external_session_url ? { sessionUrl: external_session_url } : {}),
      })
      return asJsonResult({
        ...result,
        status: 'editing',
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'You edit the scratch worktrees in place; Canary Lab is not running a local agent — it verifies + saves.',
        nextSteps: ['submit_external_portify'],
        next: `Edit each target's source (in its worktree path) so the listener reads an injected port, declare the matching \`ports\` slots in ${result.configPath}, then call submit_external_portify with workflowId "${result.workflowId}". Poll get_portify; save_portify once status is "ready-to-save".`,
      })
    } catch (err) {
      return failureResult(err)
    }
  })

  registerTool('submit_external_portify', {
    description: 'Submit your in-place edits for an external port-ification workflow: Canary Lab captures the worktree diff and boots the stack twice concurrently on different ports to verify. Async — the workflow goes to verifying, then ready-to-save (passed) or back to editing (failed — read verification.failureDetail, fix the worktree, and submit again). Poll get_portify. Only valid while the workflow is in "editing".',
    inputSchema: { workflowId: z.string() },
  }, async ({ workflowId }) => {
    if (!deps.submitExternalPortify) return errorResult('submitExternalPortify dependency is not configured')
    try {
      const manifest = await deps.submitExternalPortify(workflowId)
      return asJsonResult({
        ...manifest,
        nextSteps: ['get_portify'],
        next: `Poll get_portify with workflowId "${workflowId}": on "ready-to-save" call save_portify; if it returns to "editing", read verification.failureDetail, fix the worktree, and submit_external_portify again. cancel_portify discards the workflow.`,
      })
    } catch (err) {
      return failureResult(err)
    }
  })

  registerTool('revise_external_portify', {
    description: 'Act on human feedback about an already-VERIFIED port-ification diff, WITHOUT losing it. Reopens the workflow (ready-to-save → editing) so you keep editing the SAME scratch worktree your verified edits live in, and returns a `prompt` restating the constraints (ports-only, never touch test files, never commit, envsets stay `${port.x}`-driven). Use this whenever the user asks for a change after the double-boot passed — cancel_portify would throw the verified worktree away and make you start over. Apply the feedback, then submit_external_portify to re-verify. Only valid when status is "ready-to-save".',
    inputSchema: {
      workflowId: z.string(),
      feedback: z.string().describe("What the human wants changed, in their words. Required — a reopen with nothing to act on just loses the verified state."),
    },
  }, async ({ workflowId, feedback }) => {
    if (!deps.reviseExternalPortify) return errorResult('reviseExternalPortify dependency is not configured')
    try {
      const { manifest, instructions } = deps.reviseExternalPortify(workflowId, feedback)
      const { diff, ...rest } = manifest
      return asJsonResult({
        ...rest,
        ...(diff ? { diffStats: summarizeUnifiedDiff(diff), diffOmitted: true, diffHint: 'call get_portify with includeDiff:true to inline the patch' } : {}),
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'The workflow is back in "editing" with your prior verified edits still on disk. Canary spawns no agent — you apply the feedback, then submit_external_portify re-runs the double-boot.',
        prompt: instructions,
        nextSteps: ['submit_external_portify'],
        next: `Follow prompt: apply the feedback ON TOP of the existing edits in the worktree (they are still there — do not start over), then call submit_external_portify with workflowId "${workflowId}" to re-verify. The double-boot runs again, so re-check the change did not reintroduce a hardcoded listener.`,
      })
    } catch (err) {
      return failureResult(err)
    }
  })

  registerTool('get_portify', {
    description: 'Read a port-ification workflow: status (planning/editing/verifying/ready-to-save/saved/failed/aborted), attempt count, and the double-boot verification result. When an external workflow is back at "editing" because verification FAILED, the result also carries `prompt` — the retry playbook for reading that failure (baseline-boot vs concurrency verdict, the non-HTTP listeners a first pass usually misses, the shared build-cache race). The full unified diff is OMITTED by default (it can be a large multi-file patch) — `diffStats` summarizes it; pass includeDiff:true to inline the patch text.',
    inputSchema: {
      workflowId: z.string(),
      includeDiff: z.boolean().default(false).describe('Inline the full unified diff. Off by default (the patch can be large); diffStats gives files/additions/deletions. Call again with includeDiff:true for the patch text.'),
    },
  }, async ({ workflowId, includeDiff }) => {
    if (!deps.getPortify) return errorResult('getPortify dependency is not configured')
    const manifest = deps.getPortify(workflowId)
    if (!manifest) return errorResult(`port-ification workflow not found: ${workflowId}`)
    // A failed double-boot re-parks at `editing`, so this read is where an
    // external client actually LEARNS it failed (submit is fire-and-forget).
    // Ride the retry playbook along — the raw failureDetail carries the verdict
    // but none of its reading.
    const retryPrompt = deps.externalPortifyRetryPrompt?.(workflowId) ?? null
    const retry = retryPrompt
      ? { prompt: retryPrompt, nextSteps: ['submit_external_portify'], next: 'Verification FAILED and the workflow is back in "editing". Follow prompt: re-scan for the listener that still binds a hardcoded port, fix it in the worktree, then submit_external_portify again.' }
      : {}
    if (includeDiff) return asJsonResult({ ...manifest, ...retry })
    const { diff, ...rest } = manifest
    return asJsonResult({
      ...rest,
      ...(diff ? { diffStats: summarizeUnifiedDiff(diff), diffOmitted: true, diffHint: 'call get_portify with includeDiff:true to inline the patch' } : {}),
      ...retry,
    })
  })

  registerTool('list_portify_status', {
    description: "List every feature with whether it can boot concurrently (benchmark arms / parallel runs) without an EADDRINUSE clash. TWO ways to get there, and both count: `portified` — a VERIFIED saved overlay exists under features/<feature>/portify/ (proven by the double-boot at save time); or `injectability: 'declared'` — every start command already declares a port slot in feature.config.cjs, because its service natively reads the port from its env. A 'declared' feature needs NO overlay; do not run start_portify on it. Only `injectability: 'partial'` or `'none'` (and not portified) still need start_portify. `declaredSlots` lists the slots per service/command.",
    inputSchema: {},
  }, async () => {
    const features = loadFeatures(deps.featuresDir).map((f) => {
      const pf = computePortPreflight(f)
      return {
        feature: f.name,
        portified: portifyOverlayExists(f.featureDir),
        injectability: portInjectability(f.repos),
        declaredSlots: pf.repos,
      }
    })
    const portified = features.filter((f) => f.portified).length
    const concurrencyReady = features.filter((f) => f.portified || f.injectability === 'declared').length
    return asJsonResult({
      features,
      summary: {
        total: features.length,
        portified,
        notPortified: features.length - portified,
        concurrencyReady,
        needsPortify: features.length - concurrencyReady,
      },
    })
  })

  registerTool('save_portify', {
    description: "Save a verified port-ification workflow as the feature's EPHEMERAL OVERLAY (captured patch under features/<feature>/portify/) and discard the scratch worktree — NOTHING is committed or merged; the product repo stays pristine. The overlay is applied into a fresh per-run worktree before each run and reverse-applied at teardown. Only valid when status is ready-to-save. Requires confirm: true. If the human wants a change first, call revise_external_portify (feedback) instead — it reopens the SAME verified worktree; cancel_portify would discard it.",
    inputSchema: {
      workflowId: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against saving an unreviewed rewrite.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ workflowId }) => {
    if (!deps.savePortify) return errorResult('savePortify dependency is not configured')
    try {
      const manifest = await deps.savePortify(workflowId)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return asJsonResult({
        ...manifest,
        next: `Overlay saved to features/${manifest.feature}/portify/. The feature now boots with injectable ports on every run — concurrent runs and benchmark arms will not clash — without ever modifying the product repo.`,
      })
    } catch (err) {
      return failureResult(err)
    }
  })

  registerTool('cancel_portify', {
    description: 'Cancel a port-ification workflow — discards its scratch worktree + branch and restores the feature config. Requires confirm: true.',
    inputSchema: {
      workflowId: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against discarding in-flight work.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ workflowId }) => {
    if (!deps.cancelPortify) return errorResult('cancelPortify dependency is not configured')
    try {
      return asJsonResult(await deps.cancelPortify(workflowId))
    } catch (err) {
      return failureResult(err)
    }
  })

  registerTool('remove_portification', {
    description: "Un-portify a SAVED feature: reverts its feature config (the declared `ports` slots + the `${port.x}` health-check rewrites) and deletes the port overlay, so it boots on its hardcoded ports again and is no longer portified. Always auto-cleans — overlays carry a pre-Portify config snapshot, so the revert is exact. Legacy overlays (no snapshot) best-effort strip the slots; their health-check tokens need a re-run of Portify to regenerate. Requires confirm: true.",
    inputSchema: {
      feature: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against discarding a saved overlay + reverting config.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ feature }) => {
    if (!deps.removePortification) return errorResult('removePortification dependency is not configured')
    try {
      const result = deps.removePortification(feature)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return asJsonResult(result)
    } catch (err) {
      return failureResult(err)
    }
  })

  registerTool('get_heal_context', {
    description: 'Compact failure handoff packet an external heal agent needs first: current failures, artifact URLs, heal-index, journal, repo branches, lifecycle, and heal prompt map. Use get_run_snapshot for verbose raw summary/debugging fields.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
      client_kind: clientKindInput,
    },
  }, async ({ runId, session_id, client_kind }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (session_id) {
      ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    }
    const context = buildExternalHealContext({
      detail,
      logsDir: deps.store.logsDir,
      projectRoot: deps.projectRoot,
    })
    if (session_id) deps.broker.touch(runId, session_id)
    return asJsonResult(context)
  })

  registerTool('get_failure_detail', {
    description:
      'One failing test\'s detail: error, location, resolved pointer dirs (trace-extract, playwright-mcp), curated trace summary, and the full error text — both inlined in full (never truncated; a large file over the inline budget is swapped for a `traceSummaryPath`/`errorTextPath` to Read in chunks). Use `failureId` from a failedTests[] entry (get_heal_context / wait_for_heal_task). Built for fan-out: hand each failureId to its own read-only sub-agent to investigate AND draft a proposed patch in parallel; the claim owner then applies the patches serially and signals once.',
    inputSchema: {
      runId: z.string(),
      failureId: z.string().describe('The failureId (== failed test name) from a failedTests[] entry.'),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
      client_kind: clientKindInput,
    },
  }, async ({ runId, failureId, session_id, client_kind }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (session_id) {
      ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    }
    const failure = buildExternalFailureDetail({ detail, logsDir: deps.store.logsDir, failureId })
    if (!failure) return errorResult(`failure not found: ${failureId} (use a failureId from failedTests[])`)
    if (session_id) deps.broker.touch(runId, session_id)
    return asJsonResult(failure)
  })
}
