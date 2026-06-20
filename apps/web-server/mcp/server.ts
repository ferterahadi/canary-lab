import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../src/features/runs/logic/run-store'
import type { ExternalHealBroker } from '../src/features/runs/logic/heal/external-heal-broker'
import {
  normalizeCanaryLabMcpProfile,
  registerCanaryLabTools,
  toolsForCanaryLabMcpProfile,
  type CanaryLabMcpDeps,
  type CanaryLabMcpProfile,
} from './tools'
import type { ExternalHealClientKind } from '../src/features/runs/logic/runtime/manifest'

// Singleton MCP server mounted on the existing Fastify instance at `/mcp`.
// Uses the streamable HTTP transport so Claude Desktop / Codex Desktop and
// other MCP clients (claude-cli, codex-cli, mcp-inspector, custom scripts)
// can connect over plain HTTP at localhost:7421/mcp.
//
// The implementation is intentionally thin: every tool is a wrapper around an
// existing REST endpoint or internal helper. The MCP server doesn't own
// state — RunStore + ExternalHealBroker do. Notifications + resources are a
// follow-up; v1 ships tools only.

export interface McpRouteDeps extends CanaryLabMcpDeps {
  store: RunStore
  broker: ExternalHealBroker
  featuresDir: string
  projectRoot: string
  /** Same startRun factory used by the runs route — lets MCP `start_run`
   *  reuse the production code path (envset apply, repo validation, admission/
   *  collision, etc.). Inherited signature from CanaryLabMcpDeps. */
  startRun: CanaryLabMcpDeps['startRun']
}

const SERVER_INFO = { name: 'canary-lab', version: '1.0.0', title: 'Canary Lab' }

// Sent to MCP clients in the `initialize` result so external agents that do
// not carry the Canary Lab skill still learn the run/heal/author loops. The
// repair text is load-bearing: without it, result-driven clients invent their
// own get_run_snapshot poll loop instead of blocking on wait_for_heal_task,
// and never pick up the needs_heal handoff.
const REPAIR_INSTRUCTIONS = `Canary Lab — external repair loop. Fix failing runs by editing app/service code (not tests, unless a test is provably wrong).

1. start_run with claim_heal:true, a stable session_id reused for the whole conversation, and conversation_name. Do NOT pass client_kind — the MCP bridge auto-detects it (CLI vs Desktop) from the connection; passing it yourself can mis-set it and suppress heal claim. For "rerun <id>" pass run_ref (e.g. "7cvh").
   - If start_run returns type:"repo_collision_requires_choice", another run is using the same app/repo. ASK THE USER whether to run isolated (a per-run git worktree, concurrent) or queue until the other run finishes, then re-call start_run with isolation:"worktree" or isolation:"queue". Do not guess.
   - If start_run returns queued:true, the run is parked (queueReason tells you why) and will start automatically when capacity frees; wait_for_heal_task still works — it blocks until the run starts and needs fixes.
   - If start_run (or wait_for_heal_task) returns type:"boot_session" (executionType:"boot"), the run is a held boot-only session: services are up, no tests run, and there is NO heal task. Do not wait for heal — report that services are ready and that abort_run (confirm:true) stops them. A service that fails its readiness probe is marked failed (its status shows "timeout") but the session stays held — boot never self-aborts on a health-check failure, so report which services came up and which failed; only abort_run tears it down.
2. wait_for_heal_task with the same runId + session_id. This BLOCKS for a short bounded window (and heartbeats for you) until the run needs fixes, passes, or fails. If it returns type:"still_waiting" the run is still active and the window simply elapsed — this is NOT terminal: immediately call wait_for_heal_task again with the same runId + session_id. Loop on still_waiting until you get needs_heal / passed / failed. Always wait this way — never poll get_run_snapshot or get_run in a loop.
3. On needs_heal: read context.healPrompt.startHere first. The packet is slim — context.healIndex / context.journal are PATHS (Read them when needed), and each context.failedTests[] entry carries a failureId plus pointer dirs (errorPath, traceDir, playwrightMcpDir). When SEVERAL tests fail, fan out: spawn one read-only sub-agent per failure, hand it the failureId, and have it call get_failure_detail(runId, failureId) to investigate just that slice in parallel and report back a hypothesis + proposed fix. The sub-agents must NOT edit code or call signal_run. Then YOU apply all the fixes and signal_run ONCE (kind:"rerun" for test-only/app-code fixes, "restart" when services or env must restart) with hypothesis + fixDescription. One accountable signal per cycle.
4. wait_for_heal_task again on the same run (loop on still_waiting as in step 2). Repeat until passed or terminal failure.

To re-execute a run, reuse it rather than tearing it down: for an active healing run use signal_run (re-runs the failed tests in place); to retry a failed/aborted run pass its run_ref to start_run (reruns failed → skipped → pending/not-run only). Do not abort_run then start a fresh run as a way to re-run — a fresh start re-runs the whole suite and is only worth it when prior passes are invalidated (e.g. a global data/state change), and even then you rarely need to abort first.

get_run_snapshot is for verbose debugging only, not for waiting. Read pass counts from result.counts.statusLine / result.counts.passed, never total - failed.`

const VERIFY_INSTRUCTIONS = `Canary Lab — verification profile. Manage saved Verify configs and run them: list_verification_configs, get/create/update_verification_config, then execute_verification and get_verification_result.`

const AUTHOR_INSTRUCTIONS = `Canary Lab — authoring profile. Create or extend features and export evaluations; Canary Lab is the control plane, this client writes the test/report content.

- New feature: create_feature (returns the skeleton + nextSteps). For random/test feature creation, choose a unique slug and call create_feature directly; do not call list_features just to avoid collisions. If the chosen name exists, retry create_feature with a different name. Author specs under features/<feature>/e2e importing from 'canary-lab/feature-support/log-marker-fixture'. To preserve repo env/config, call capture_feature_env_files (secret values are never returned).
- Docs/plans/distillations: write_feature_doc puts markdown into features/<feature>/docs/ — the home for feature-scoped prose. For "add this plan/distillation to feature <name>", call write_feature_doc with a descriptive relPath (e.g. "2026-05-28-line-notes.md"). Create-or-replace, .md/.markdown only.
- Verified coverage: get_feature_coverage(feature) returns the grounded ledger — PRD requirements → covering tests → last passing run + gap type (untested / unverified / path-incomplete / verified / shallow-verified), a coverage % (verified ÷ total, evidence-based math, never an opinion), per-requirement rigor (tierReached/tierAvailable/strictness + weakestAssertion + suggestedStrongerCheck), orphanTestNames (tests with no requirement), and a derived state view (summary × coverage axes + headline + drift naming changed docs). Link a test to a requirement with Playwright tags ON the test: test('…', { tag: ['@req-R3', '@path-happy'] }, …) (greppable, rename-proof; legacy @requirement/@path comments still parse as a fallback). Generation is ASYNC and Summary + Coverage are ONE exercise: start_coverage_job(feature, kind:"summary") regenerates the PRD summary AND auto-chains the coverage engine (recording the chained coverage job as chainedJobId); start_coverage_job(feature, kind:"coverage") re-runs only the engine. Both are non-blocking with a server-side single-flight guard; poll get_coverage_job(jobId) until done (for a summary job, then poll its chainedJobId), then re-read get_feature_coverage. The coverage engine infers which requirement each untagged test covers and writes the @req-* tag immediately — there is NO accept/reject review gate. Use the ledger to find requirements with no passing run and tests that pass too laxly, then write a stronger/missing test (canary attests + maps the tag; it never writes the test body for you). list_feature_docs(feature) lists the docs that feed the PRD; write_feature_doc adds one and delete_feature_doc(feature, relPath) removes a source doc; after you add/edit/remove docs run a summary job (or regenerate_prd_summary(feature), preserving requirement ids). clear_prd_summary(feature) removes the generated summary (+ coverage sidecars), returning the feature to the no-summary state.
- Draft flow: start_external_draft → update_external_draft_stage (scaffolding → authoring-tests → validating → ready → applied) → apply_external_draft. start_external_draft only creates a visible Canary Lab task so the user sees that you are authoring tests; it does not start an internal wizard agent. After it returns, tell the user you are authoring tests, keep writing the specs in this external client, and call apply_external_draft when the files are ready.
- Evaluation export (run must be terminal, not necessarily passing): start_external_evaluation_export returns editable textSlots/rewrite; submit structured wording through submit_external_evaluation_export, then get/list/download_evaluation_export. Canary Lab renders the final evaluation.html archive. If the run failed or was aborted and the user asks to export as-is, preserve that status in the wording instead of trying to heal first.
- Make ports injectable (so a feature can boot concurrently — benchmark arms / parallel runs): start_portify(feature) kicks off an async workflow that rewrites every network listener to read an injected port, proven by a concurrent double-boot. Poll get_portify(workflowId) until status is "ready-to-save", then save_portify(workflowId, confirm:true) — or cancel_portify(workflowId, confirm:true). To adjust the result before saving, revise_portify(workflowId, feedback) resumes the agent and re-verifies (status cycles back through editing → verifying → ready-to-save; poll again). Feedback rounds are unbounded. One workflow at a time. Use list_portify_status to see which features are already portified vs still need it.
- Saving captures the verified edits as an EPHEMERAL OVERLAY under features/<feature>/portify/ — nothing is committed or merged, so the product repo stays pristine. On every subsequent run Canary Lab applies the overlay into a fresh per-run worktree before boot (with disjoint injected ports) and reverse-applies it at teardown. There is no merge step and no branch to manage; the feature simply boots concurrently from then on. If the overlay later stops applying (the product repo moved under it), the run fails loudly asking you to re-run start_portify to refresh it.`

const INSTRUCTIONS_BY_PROFILE: Record<CanaryLabMcpProfile, string> = {
  repair: REPAIR_INSTRUCTIONS,
  verify: VERIFY_INSTRUCTIONS,
  author: AUTHOR_INSTRUCTIONS,
  full: `${REPAIR_INSTRUCTIONS}\n\n${AUTHOR_INSTRUCTIONS}\n\n${VERIFY_INSTRUCTIONS}`,
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRouteDeps,
): Promise<void> {
  // One McpServer + StreamableHTTPServerTransport pair per MCP session.
  // The transport sets an "initialized" flag on its first handshake and
  // rejects every later initialize with -32600 "Server already
  // initialized", so a singleton would cap us at one MCP client per
  // Fastify boot. Keyed by the session id the transport mints on init.
  const transports = new Map<string, StreamableHTTPServerTransport>()

  // Tool counts are static per profile — register tools on detached McpServer
  // instances (never connected to a transport) so /mcp/health can answer
  // without requiring an active MCP session.
  const toolCounts = {
    repair: countToolsForProfile(deps, 'repair'),
    verify: countToolsForProfile(deps, 'verify'),
    author: countToolsForProfile(deps, 'author'),
    full: countToolsForProfile(deps, 'full'),
  } satisfies Record<CanaryLabMcpProfile, number>

  const newSession = async (
    profile: CanaryLabMcpProfile,
    defaultClientKind: ExternalHealClientKind,
  ): Promise<StreamableHTTPServerTransport> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports.set(id, transport) },
      onsessionclosed: (id) => { transports.delete(id) },
    })
    transport.onclose = () => {
      const id = transport.sessionId
      if (id) transports.delete(id)
    }
    const mcp = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS_BY_PROFILE[profile] })
    registerCanaryLabTools(mcp, deps, { profile, defaultClientKind })
    await mcp.connect(transport)
    return transport
  }

  // Fastify pre-parses the JSON body, so we hand it to handleRequest as the
  // pre-parsed `parsedBody` argument. The transport handles GET (SSE stream),
  // POST (client→server message), and DELETE (close session).
  const handle = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const header = req.headers['mcp-session-id']
      const sessionId = Array.isArray(header) ? header[0] : header

      let transport: StreamableHTTPServerTransport
      if (sessionId) {
        const existing = transports.get(sessionId)
        if (!existing) {
          reply.code(404).send({
            jsonrpc: '2.0',
            error: { code: -32001, message: `Unknown MCP session: ${sessionId}` },
            id: null,
          })
          return
        }
        transport = existing
      } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
        const context = contextFromUrl(req.url)
        if (!context.ok) {
          reply.code(400).send({
            jsonrpc: '2.0',
            error: { code: -32602, message: context.error },
            id: null,
          })
          return
        }
        transport = await newSession(context.profile, context.clientKind)
      } else {
        reply.code(400).send({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Bad Request: missing mcp-session-id header (POST initialize is the only request that may omit it)',
          },
          id: null,
        })
        return
      }

      await transport.handleRequest(req.raw, reply.raw, req.body)
    } catch (err) {
      // The transport writes directly to res.raw, so if it threw before
      // sending, our Fastify layer needs to close the reply cleanly.
      app.log.error({ err }, 'MCP transport.handleRequest threw')
      if (!reply.sent) {
        reply.code(500).send({ error: (err as Error).message })
      }
    }
  }

  app.post('/mcp', handle)
  app.get('/mcp', handle)
  app.delete('/mcp', handle)

  // Lightweight health endpoint so smoke tests can confirm the MCP route is
  // mounted without speaking the protocol.
  app.get('/mcp/health', async (req, reply) => {
    const context = contextFromUrl(req.url)
    if (!context.ok) {
      reply.code(400)
      return { error: context.error }
    }
    return {
      ok: true,
      server: SERVER_INFO,
      profile: context.profile,
      clientKind: context.clientKind,
      toolCount: toolCounts[context.profile],
      tools: toolsForCanaryLabMcpProfile(context.profile),
      activeSessions: transports.size,
      projectRoot: deps.projectRoot,
    }
  })
}

function countToolsForProfile(deps: McpRouteDeps, profile: CanaryLabMcpProfile): number {
  const probe = new McpServer(SERVER_INFO)
  registerCanaryLabTools(probe, deps, { profile })
  return countTools(probe)
}

function contextFromUrl(url: string):
  | { ok: true; profile: CanaryLabMcpProfile; clientKind: ExternalHealClientKind }
  | { ok: false; error: string } {
  const params = new URL(url, 'http://localhost').searchParams
  const rawProfile = params.get('profile') ?? undefined
  const profile = normalizeCanaryLabMcpProfile(rawProfile)
  if (!profile) return { ok: false, error: `invalid MCP profile: ${rawProfile}` }
  const rawClientKind = params.get('client_kind') ?? 'other'
  if (!isExternalHealClientKind(rawClientKind)) {
    return { ok: false, error: `invalid MCP client_kind: ${rawClientKind}` }
  }
  return { ok: true, profile, clientKind: rawClientKind }
}

function countTools(mcp: McpServer): number {
  // The McpServer keeps registered tools on a private field; the public
  // surface doesn't expose a count. Best-effort introspection — we cast to
  // any only here so the rest of the file stays typed.
  const tools = (mcp as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
  return tools ? Object.keys(tools).length : 0
}

function isExternalHealClientKind(value: string): value is ExternalHealClientKind {
  return value === 'claude-cli' ||
    value === 'claude-desktop' ||
    value === 'codex-cli' ||
    value === 'codex-desktop' ||
    value === 'other'
}
