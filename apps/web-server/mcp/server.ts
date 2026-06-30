import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../src/features/runs/logic/run-store'
import type { ExternalHealBroker } from '../src/features/runs/logic/heal/external-heal-broker'
import {
  CANARY_LAB_MCP_PROFILES,
  normalizeCanaryLabMcpProfile,
  registerCanaryLabTools,
  toolsForCanaryLabMcpProfile,
  type CanaryLabMcpDeps,
  type CanaryLabMcpProfile,
} from './tools'
import { isClientKind, type ClientKind } from '../../../shared/run-mode'

// Singleton MCP server mounted on the existing Fastify instance at `/mcp`.
// Uses the streamable HTTP transport so Claude / Codex clients (Desktop or
// CLI) and other MCP clients (mcp-inspector, custom scripts) can connect over
// plain HTTP at localhost:7421/mcp.
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

1. start_run with claim_heal:true, a stable session_id reused for the whole conversation, and conversation_name. Do NOT pass client_kind — the MCP bridge auto-detects it from the connection; passing it yourself can mis-set it and suppress heal claim. Heal claiming is open to interactive Claude/Codex clients (Desktop or CLI); it is suppressed only for runner-spawned PTY agents Canary Lab launches itself. For "rerun <id>" pass run_ref (e.g. "7cvh").
   - If start_run returns type:"repo_collision_requires_choice", another run is using the same app/repo. ASK THE USER whether to run isolated (a per-run git worktree, concurrent) or queue until the other run finishes, then re-call start_run with isolation:"worktree" or isolation:"queue". Do not guess.
   - If start_run returns queued:true, the run is parked (queueReason tells you why) and will start automatically when capacity frees; wait_for_heal_task still works — it blocks until the run starts and needs fixes.
   - If start_run (or wait_for_heal_task) returns type:"boot_session" (executionType:"boot"), the run is a held boot-only session: services are up, no tests run, and there is NO heal task. Do not wait for heal — report that services are ready and that abort_run (confirm:true) stops them. A service that fails its readiness probe is marked failed (its status shows "timeout") but the session stays held — boot never self-aborts on a health-check failure, so report which services came up and which failed; only abort_run tears it down.
2. wait_for_heal_task with the same runId + session_id. This BLOCKS for a short bounded window (and heartbeats for you) until the run needs fixes, passes, or fails. If it returns type:"still_waiting" the run is still active and the window simply elapsed — this is NOT terminal: immediately call wait_for_heal_task again with the same runId + session_id. Loop on still_waiting until you get needs_heal / passed / failed. Always wait this way — never poll get_run_snapshot or get_run in a loop.
3. On needs_heal the result is self-describing: follow context.nextSteps (read context.healPrompt.startHere first), apply all the fixes YOURSELF, then signal_run ONCE per cycle with hypothesis + fixDescription, and wait_for_heal_task again. Repeat until passed or terminal failure. context.nextSteps also covers fanning out per-failure sub-agents to investigate AND draft patches in parallel (you apply them serially and signal once), rerun-vs-restart, and reusing a run instead of aborting it. A needs_heal task can also be a service that failed to boot — then context.failedTests is empty and context.bootFailure is set (service name + log path) because no tests ran; Read bootFailure.logPath to find why the service won't serve, fix the service/app code, then signal_run kind:"restart" (context.nextSteps already reflects this). context.healPrompt + context.nextSteps ship on the FIRST needs_heal only; later cycles carry context.guidance instead (same loop — call get_heal_context if you need the map back). If the SAME tests fail 3+ cycles running, context.escalation appears: you're stuck — read context.escalation.readFirst and follow context.escalation.tactics (change tactic — revert/build on the prior diff, don't fire a fresh hypothesis) rather than repeating the last fix.

get_run_snapshot is for verbose debugging only, not for waiting. Read pass counts from result.counts.statusLine / result.counts.passed, never total - failed.`

const VERIFY_INSTRUCTIONS = `Canary Lab — verification profile. Manage saved Verify configs and run them: list_verification_configs, get/create/update_verification_config, then execute_verification and get_verification_result.`

const AUTHOR_INSTRUCTIONS = `Canary Lab — authoring profile. Create or extend features and export evaluations; Canary Lab is the control plane, this client writes the test/report content.

- New feature: create_feature returns the skeleton + nextSteps. Choose a unique slug and call create_feature directly; do not call list_features just to avoid collisions (retry with a different name if it exists). Author specs under features/<feature>/e2e importing from 'canary-lab/feature-support/log-marker-fixture'. capture_feature_env_files preserves repo env/config (secret values are never returned).
- Docs: write_feature_doc puts markdown into features/<feature>/docs/ (create-or-replace, .md/.markdown only) — the home for feature-scoped prose, and where "add this plan/distillation to feature <name>" goes (use a descriptive relPath). list_feature_docs(feature) lists the docs feeding the PRD; delete_feature_doc(feature, relPath) removes a source doc. After any doc change refresh the summary YOURSELF with start_external_summary(feature) → submit_external_summary (requirement ids are preserved).
- Semantic coverage: get_feature_coverage(feature) returns the ledger — PRD requirements → covering tests → gap type (untested / path-incomplete / covered), a coverage % (covered ÷ total — every declared path claimed by a mapped test), a mapped % (requirements with ≥1 test), per-test strength (strong/solid/basic/shallow from each test's assertion tiers), orphanTestNames (tests with no requirement), a derived state view, and docs-drift. Coverage is DECOUPLED from test runs — it measures whether a test maps to each requirement+path, never whether a run passed. Link a test to a requirement with Playwright tags ON the test: test('…', { tag: ['@req-R3', '@path-happy'] }, …) (greppable, rename-proof; legacy @requirement/@path comments still parse as a fallback). Use the ledger to find untested/path-incomplete requirements and shallow tests, then write the stronger/missing test yourself (canary maps the tag; it never writes the test body). When the ledger is BLOCKED it carries a next: field with the recovery step — follow it instead of presenting options. If it reports no source doc ("Setup needed", sourceDocCount 0), ASK THE USER to attach or paste the PRD/spec in the chat (never invent one or pull an external file); once they provide it, write_feature_doc then start_external_summary(feature).
- Coverage is something YOU do (no local agent) in two handed-off steps, single-flight per feature, and it shows live in the GUI as an "external session" while you work. ① start_external_summary(feature) returns the source-doc paths, the previous requirement ids to PRESERVE, and a prompt; read the docs, extract requirements, submit_external_summary(jobId, requirements). If the feature has ONE cross-cutting dimension a requirement must hold across (channel/tenant/region/...), also pass variantDimension {name, values} and set each spanning requirement's variants — a requirement that claims "all 4 channels" but is tested on one is variant-incomplete, not covered. ② start_external_coverage(feature) returns the requirements + the tests (with file paths) + a prompt; read each test, decide its requirement id(s) and which variant(s) it actually exercises, submit_external_coverage(jobId, mappings) — Canary writes the @req-*/@variant-* tags through its canonical tag-writer and recomputes the ledger (unknown ids/test names/variants dropped). start_external_coverage needs a summary first (else status:"needs-summary" — run step ①). For a large PRD or many tests, OFFLOAD the reading/extraction to a background task or FAN IT OUT across docs/tests with subagents, then submit once. clear_prd_summary(feature) resets to a blank slate — removes the summary (+ coverage sidecars) and strips @req-*/@path-*/@variant-* tags from the specs (other tags kept).
- Draft flow: start_external_draft → update_external_draft_stage (scaffolding → authoring-tests → validating → ready → applied) → apply_external_draft. start_external_draft only creates a visible task (no internal wizard agent); keep writing the specs in this client and call apply_external_draft when the files are ready.
- Evaluation export (run must be terminal, not necessarily passing): start_external_evaluation_export returns editable textSlots/rewrite; submit through submit_external_evaluation_export, then get/list/download_evaluation_export (Canary renders the final evaluation.html). If you submit a rewrite, rewrite.cases must keep the EXACT count and order of the provided template — one case per run entry; never merge/dedupe/drop skipped or duplicate runs (textSlots[] keeps the count correct automatically). submit returns an \`evaluation\` digest (featureTitle, summary, per-case verdicts) — RELAY it to the user in chat; don't just say it's in the UI. If the run failed/aborted and the user wants it exported as-is, preserve that status in the wording — don't heal first.`

const PORTIFY_INSTRUCTIONS = `Canary Lab — portify profile. Make a feature's ports injectable so it can boot concurrently (benchmark arms / parallel runs).

- Port-ify it YOURSELF (no local agent): start_external_portify(feature) sets up scratch worktree(s) and returns targets[] (edit paths) + configPath + instructions; edit the listeners IN PLACE to read an injected port, declare the matching \`ports\` slots in the config, then submit_external_portify(workflowId) — Canary boots the stack twice concurrently to verify. On "ready-to-save" call save_portify(workflowId, confirm:true); if it returns to "editing", read verification.failureDetail, fix the worktree, and submit_external_portify again (re-edit + re-submit is the revision loop — unbounded). cancel_portify(workflowId, confirm:true) discards it. One workflow PER FEATURE (a second start on the same feature is a 409); DIFFERENT features port-ify concurrently up to a resource cap, so to portify several features at once fan out a subagent per feature — at capacity start_external_portify returns a 429, so wait for one to finish (or save/cancel it) and retry. The GUI shows each live as an external session; list_portify_status shows which features are portified. Within ONE feature that has multiple repos, FAN OUT the per-repo edits across subagents, then submit once.
- Already env-driven? If the repo ALREADY reads injected ports (e.g. it was portified for another feature, or the listeners are committed env-driven), no source edit is needed — just declare the matching \`ports\` slots in the config and submit_external_portify. The double-boot still verifies the concurrent boot, and save records an EMPTY overlay (a no-op at run time). An empty diff is only rejected when the boot also fails (the listeners genuinely don't read the injected ports yet).
- Borrowed start: if ANOTHER feature already saved an overlay for the same app, Canary pre-applies that patch into your scratch worktree at setup (the returned instructions say so). Review the existing edits rather than rewriting from scratch — usually you only add this feature's \`ports\` slots — then submit. The borrowed lines are captured into THIS feature's own overlay, so it stays self-contained.
- Saving captures the verified edits as an EPHEMERAL OVERLAY under features/<feature>/portify/ — nothing committed or merged, so the product repo stays pristine; each run applies the overlay into a fresh per-run worktree (disjoint ports) before boot and reverse-applies at teardown. If the overlay later stops applying (the repo moved under it), the run fails loudly asking you to re-portify (start_external_portify, or the GUI).
- Undo it: remove_portification(feature, confirm:true) reverts the feature config (the declared \`ports\` slots + \`\${port.x}\` health-check rewrites, restored from the snapshot saved with the overlay) and deletes the overlay, so the feature is no longer portified. Re-run start_external_portify (or the GUI) to redo.`

// `lifecycle` carries the everyday one-session loop (repair + author + verify);
// `full` adds the portify instructions on top. Keep these compositions in step
// with TOOLS_BY_PROFILE in tools.ts.
const LIFECYCLE_INSTRUCTIONS = `${REPAIR_INSTRUCTIONS}\n\n${AUTHOR_INSTRUCTIONS}\n\n${VERIFY_INSTRUCTIONS}`

const INSTRUCTIONS_BY_PROFILE: Record<CanaryLabMcpProfile, string> = {
  repair: REPAIR_INSTRUCTIONS,
  verify: VERIFY_INSTRUCTIONS,
  author: AUTHOR_INSTRUCTIONS,
  portify: PORTIFY_INSTRUCTIONS,
  lifecycle: LIFECYCLE_INSTRUCTIONS,
  full: `${LIFECYCLE_INSTRUCTIONS}\n\n${PORTIFY_INSTRUCTIONS}`,
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
  const toolCounts = Object.fromEntries(
    CANARY_LAB_MCP_PROFILES.map((profile) => [profile, countToolsForProfile(deps, profile)]),
  ) as Record<CanaryLabMcpProfile, number>

  const newSession = async (
    profile: CanaryLabMcpProfile,
    defaultClientKind: ClientKind,
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
  | { ok: true; profile: CanaryLabMcpProfile; clientKind: ClientKind }
  | { ok: false; error: string } {
  const params = new URL(url, 'http://localhost').searchParams
  const rawProfile = params.get('profile') ?? undefined
  const profile = normalizeCanaryLabMcpProfile(rawProfile)
  if (!profile) return { ok: false, error: `invalid MCP profile: ${rawProfile}` }
  const rawClientKind = params.get('client_kind') ?? 'other'
  if (!isClientKind(rawClientKind)) {
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

