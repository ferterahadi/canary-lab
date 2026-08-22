import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../features/runs/logic/run-store'
import type { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import {
  CANARY_LAB_MCP_PROFILES,
  normalizeCanaryLabMcpProfile,
  registerCanaryLabTools,
  toolsForCanaryLabMcpProfile,
  type CanaryLabMcpDeps,
  type CanaryLabMcpProfile,
} from './tools'
import { classifyMcpClient } from './client-surface'
import { isClientKind, type ClientKind } from '../../../../shared/run-mode'

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
   - If start_run returns type:"getting_started_busy", a Getting Started demo already owns the workspace. Follow the active target it returns; do not start another run or Flight.
   - If start_run returns queued:true, the run is parked (queueReason tells you why) and will start automatically when capacity frees; wait_for_heal_task still works — it blocks until the run starts and needs fixes.
   - If start_run (or wait_for_heal_task) returns type:"boot_session" (executionType:"boot"), the run is a held boot-only session: services are up, no tests run, and there is NO heal task. Do not wait for heal — report that services are ready and that abort_run (confirm:true) stops them. A service that fails its readiness probe is marked failed (its status shows "timeout") but the session stays held — boot never self-aborts on a health-check failure, so report which services came up and which failed; only abort_run tears it down.
2. wait_for_heal_task with the same runId + session_id. This BLOCKS for a short bounded window (and heartbeats for you) until the run needs fixes, passes, or fails. If it returns type:"still_waiting" the run is still active and the window simply elapsed — this is NOT terminal: immediately call wait_for_heal_task again with the same runId + session_id. Loop on still_waiting until you get needs_heal / passed / failed. Always wait this way — never poll get_run_snapshot or get_run in a loop.
3. On needs_heal the result is self-describing: follow context.nextSteps (read context.healPrompt.startHere first), apply all the fixes YOURSELF, then signal_run ONCE per cycle with hypothesis + fixDescription, and wait_for_heal_task again. Repeat until passed or terminal failure. context.nextSteps also covers fanning out per-failure sub-agents to investigate AND draft patches in parallel (you apply them serially and signal once), rerun-vs-restart, and reusing a run instead of aborting it. A needs_heal task can also be a service that failed to boot — then context.failedTests is empty and context.bootFailure is set (service name + log path) because no tests ran; Read bootFailure.logPath to find why the service won't serve, fix the service/app code, then signal_run kind:"restart" (context.nextSteps already reflects this). context.healPrompt + context.nextSteps ship on the FIRST needs_heal only; later cycles carry context.guidance instead (same loop — call get_heal_context if you need the map back). If the SAME tests fail 3+ cycles running, context.escalation appears: you're stuck — read context.escalation.readFirst and follow context.escalation.tactics (change tactic — revert/build on the prior diff, don't fire a fresh hypothesis) rather than repeating the last fix.

get_run_snapshot is for verbose debugging only, not for waiting. Read pass counts from result.counts.statusLine / result.counts.passed, never total - failed.

If a run result carries a dirtyTests field (a test spec changed since the last green run), relay its message to the user VERBATIM (e.g. "⚠️ Tests have been modified, please review.⚠️") — once, alongside the pass/fail outcome. Do NOT block, gate, re-run, or revert on it, and never edit the test files to "fix" it: this is an awareness signal so the user can review or commit the change, not an error to act on.`

const VERIFY_INSTRUCTIONS = `Canary Lab — verification profile. Manage saved Verify configs and run them: list_verification_configs, get/create/update_verification_config, then execute_verification and get_verification_result.

- Local app ("verify a running app", the Getting Started demo): boot_services(feature) → poll get_run(bootRunId) until every manifest.services[] entry is status:"ready" → targetUrls from each service's healthUrl ORIGIN → execute_verification(feature, { targetUrls, playwrightEnvsetId: "local", bootRunId }) — bootRunId is required or the held boot session 409s as a colliding run; it also tears the boot down once verification starts. Then get_verification_result.
- Deployed environment: use a saved config or ask the user for the target URLs. A config whose URLs contain "replace.invalid" is a shipped placeholder — never execute it; fill in real URLs (or use the local flow above) first.`

const AUTHOR_INSTRUCTIONS = `Canary Lab — authoring profile. Create or extend features and write specs; Canary Lab is the control plane, this client writes the test content.

- Existing feature (the request names one — e.g. "author tests for <feature>", the Getting Started demo): do NOT create_feature and never invent a variant name. Author the new specs straight into features/<feature>/e2e. To choose WHAT to test, get_feature_coverage(feature) names the untested/path-incomplete requirements (list_feature_docs points at the source docs); tag the new test with the requirement it covers — test('…', { tag: ['@req-R2'] }, …) — so the gap actually closes in the ledger. Running the new test needs the run tools (start_run): hand off to the repair loop (reconnect with the default lifecycle profile if this connection lacks start_run).
- New feature: create_feature returns the skeleton + nextSteps. Choose a unique slug and call create_feature directly; do not call list_features just to avoid collisions (retry with a different name ONLY for a name you invented — never rename away from a feature the user asked for; that is the existing-feature flow above). Author specs under features/<feature>/e2e importing from 'canary-lab/feature-support/log-marker-fixture'. capture_feature_env_files preserves repo env/config (secret values are never returned).
- Draft flow: start_external_draft → update_external_draft_stage (scaffolding → authoring-tests → validating → ready → applied) → apply_external_draft. start_external_draft only creates a visible task (no internal wizard agent); keep writing the specs in this client and call apply_external_draft when the files are ready.`

const COVERAGE_INSTRUCTIONS = `Canary Lab — coverage profile. Feature docs → PRD summary → semantic coverage ledger; Canary Lab is the control plane, this client reads the docs/tests and submits the mapping.

- Docs: write_feature_doc puts markdown into features/<feature>/docs/ (create-or-replace, .md/.markdown only), or links a LOCAL file in place via link_path (symlink — the user's original stays the live source; .txt allowed for links) — the home for feature-scoped prose, and where "add this plan/distillation to feature <name>" or "use ~/…/prd.md as the requirements" goes (use a descriptive relPath). list_feature_docs(feature) lists the docs feeding the PRD; delete_feature_doc(feature, relPath) removes a source doc. After any doc change refresh the summary YOURSELF with start_external_summary(feature) → submit_external_summary (requirement ids are preserved).
- Semantic coverage: get_feature_coverage(feature) returns the ledger — PRD requirements → covering tests → gap type (untested / path-incomplete / covered), a coverage % (covered ÷ total — every declared path claimed by a mapped test), a mapped % (requirements with ≥1 test), per-test strength (strong/solid/basic/shallow from each test's assertion tiers), orphanTestNames (tests with no requirement), a derived state view, and docs-drift. The coverage % is claim-based — a tag claims a test maps to each requirement+path, regardless of run results; when the feature has a recorded run the ledger ALSO carries an additive proven axis (provenPct, totals.proven, per-requirement/path proven, provenRunId): covered = a tag claims it; proven = the covering test actually passed in the latest run (omitted when no run is recorded). Link a test to a requirement with Playwright tags ON the test: test('…', { tag: ['@req-R3', '@path-happy'] }, …) (greppable, rename-proof; legacy @requirement/@path comments still parse as a fallback). Use the ledger to find untested/path-incomplete requirements and shallow tests, then write the stronger/missing test yourself (canary maps the tag; it never writes the test body). When the ledger is BLOCKED it carries a next: field with the recovery step — follow it instead of presenting options. If it reports no source doc ("Setup needed", sourceDocCount 0), ASK THE USER to attach or paste the PRD/spec in the chat (never invent one or pull an external file); once they provide it, write_feature_doc then start_external_summary(feature).
- Coverage is something YOU do (no local agent) in two handed-off steps, single-flight per feature, and it shows live in the GUI as an "external session" while you work. ① start_external_summary(feature) returns the source-doc paths, the previous requirement ids to PRESERVE, and a prompt; read the docs, extract requirements, submit_external_summary(jobId, requirements). If the feature has ONE cross-cutting dimension a requirement must hold across (channel/tenant/region/...), also pass variantDimension {name, values} and set each spanning requirement's variants — a requirement that claims "all 4 channels" but is tested on one is variant-incomplete, not covered. ② start_external_coverage(feature) returns the requirements + the tests (each with the spec file to read) + a prompt; FAN OUT the reading — group the tests by their file (never split one spec file across two readers), and when that leaves more than one group and more than a handful of tests dispatch ONE read-only subagent per group in a single parallel round (up to 5 at once), each reading only its own files, every subagent getting the FULL requirement list unchanged (the tests divide, the requirements do not), then merge their answers; below that read the tests yourself; decide each test's requirement id(s) and which variant(s) it actually exercises, submit_external_coverage(jobId, mappings, unmappable) — EVERY test must come back in mappings[] or unmappable[] ({testName, reason}), or the submit is REJECTED with the missing names: a dropped test is indistinguishable from one you read and found no requirement for, and would be scored uncovered on your silence rather than on evidence. Canary writes the @req-*/@variant-* tags through its canonical tag-writer and recomputes the ledger (unknown ids/test names/variants dropped). start_external_coverage needs a summary first (else status:"needs-summary" — run step ①). For a large PRD, OFFLOAD the doc reading to a background task or fan it out across docs with subagents, then submit once. clear_prd_summary(feature) resets to a blank slate — removes the summary (+ coverage sidecars) and strips @req-*/@path-*/@variant-* tags from the specs (other tags kept).`

const FLIGHT_INSTRUCTIONS = `Canary Lab — flight profile. One conducted background pipeline takes bare product repo(s) to a green, covered, healed run ending in an evaluation export; the server owns every stage verdict, this client only answers checkpoints.

YOU are the only driver of a flight you start. stage_producer defaults to "external" for an MCP caller, and the web UI is READ-ONLY for such a flight: its Respond, Pause, Continue and autopilot controls are disabled and say to act here instead. Never tell the user to answer a checkpoint, pause, or resume from the UI — they cannot, and a flight you stop driving just sits parked. Aborting is the only flight control the UI keeps, for when this session dies. (Positioned early deliberately: the CLI truncates these instructions at 2048 characters.)

- Flight: start_flight(repoPaths, description) runs ONE background pipeline from bare repo(s) to a green, covered, healed run ending in an evaluation export (similarity → scout → scaffold → env → docs → PRD → specs↔coverage → portify → run → heal → export). The server conducts every stage and computes every verdict — you only approve checkpoints. Follow with get_flight and do what its next: field says: on waiting-for-approval call respond_flight_checkpoint(flightId) with choice (from checkpoint.options), values (missing-env KEY→value map), or data ({ configSource } for config-approval — the feature is already scaffolded, so this writes through to its REAL on-disk feature.config.cjs; "redraft" re-runs the repo scan). Autopilot is ON by default: checkpoints with a safe default answer themselves (config-approval→approve, prd-source→continue when requirement docs exist and collect-repo-docs when they do not, coverage-stuck→accept-partial, portify-gate→run, portify-apply→apply, run-failed→export-as-is, export-mode→raw — localized when stage_producer is external), each logged [autopilot] on its stage; the flight still parks on similarity-choice, missing-env, and any re-parked checkpoint — including a prd-source whose collector came back empty (data.lastAttempt present). A stage you explicitly RE-ENTER (from_stage / redo) always parks its FIRST checkpoint even under autopilot — choosing to re-run a step IS the intent to answer it differently. Start with autopilot:false to be asked at every checkpoint — do that when you plan to distill THIS conversation into requirement docs at the prd-source stop. A prd-source park is a two-path fork: supply docs yourself (write_feature_doc with content, or link_path for a local file, THEN respond "continue" — that option only appears in checkpoint.options once docs exist on disk), or have Canary's agent gather them guided by the flight's frozen intent — respond "collect-repo-docs" (copies in repo docs relevant to the intent) or "infer-from-diff" (derives requirements from the branch diff vs base); optional feedback on the respond rides a retry into the agent's prompt. A portify-apply park is a verified-diff review: "apply" saves the overlay (nothing lands in the product repos — runs apply it into throwaway per-run worktrees), "revise" REQUIRES feedback:"<what to change>" and re-runs the agent + double-boot re-verify (the checkpoint re-parks with the new diff), "cancel" discards the edits and SKIPS the stage — the flight continues without parallel readiness (the feature stays serial; a later flight can retry). If the checkpoint's data.lastAttempt is present, a previous gather already came back EMPTY (outcome: empty|no-output|no-diff, with the agent's own reason) — do NOT simply repeat that same choice; the material is not in these repos. Supply the docs yourself, or re-run the agent only with feedback naming what it missed, or after the user points the flight at different repos. ONE flight record per feature: re-calling start_flight follows an active one and resumes a paused one from its first open stage; a settled one requires redo:true (restart from stage 1) or from_stage:"<stage>" (jump to a chosen stage — prerequisites are checked and a rejection names the missing artifact). A restart WIPES: the entry step and every later step are rewound to zero on disk — requirement docs (user-added files and links included), authored specs, captured envsets, the portify overlay, the run record, the evaluation export — as if those steps never ran; warn the user before a redo/from_stage on a flight whose artifacts they still want, and use plain resume (no flag) to continue WITHOUT wiping. A flight's repos and intent are FROZEN against MID-PIPELINE re-entry: on from_stage / resume OMIT repoPaths/description (the stored values are reused) — passing DIFFERENT ones is rejected with type:"flight_frozen". A full restart (redo:true) discards every stage's evidence and artifacts, so THERE new repoPaths/description are accepted and replace the stored ones (omit to reuse); deleting the flight (web UI only) remains for removing the record, not for changing inputs. Whenever you re-enter a stage BECAUSE something was wrong, pass feedback:"<what went wrong>" alongside redo/from_stage — it is appended to the entry stage's agent prompt, and without it the re-run has no idea the last attempt was rejected and repeats it. A flight with status:"paused", pauseReason:"queued" is waiting its turn behind another flight on the same repo(s) and auto-starts when that repo frees — narrate it as queued, not stuck, and do NOT ask the user to resume it (re-calling start_flight does start it early if they want). agent:"claude"|"codex" picks which CLI conducts the flight's stage agents — sticky per record (jump/continue reuse the stored one; only redo:true may change it; the run stage's auto-heal follows the workspace heal setting instead). yolo:true skips every checkpoint except missing env secrets (export defaults to raw; localized under an external stage producer); on done, links.evaluationZip is the deliverable. When get_flight returns a remedy field (a stage failed on uncommitted repo changes), help the user clean each listed repo — git stash push -u (undoable) or commit — then start_flight resumes and the stage retries.`

const EXPORT_INSTRUCTIONS = `Canary Lab — export profile. Produce the evaluation archive for a terminal run; Canary Lab renders the final report, this client writes the reasoning.

- Evaluation export (run must be terminal, not necessarily passing): start_external_evaluation_export returns editable textSlots/rewrite; submit through submit_external_evaluation_export, then get/list/download_evaluation_export (Canary renders the final evaluation.html). If you submit a rewrite, rewrite.cases must keep the EXACT count and order of the provided template — one case per run entry; never merge/dedupe/drop skipped or duplicate runs (textSlots[] keeps the count correct automatically). submit returns an \`evaluation\` digest (featureTitle, summary, per-case verdicts) — RELAY it to the user in chat; don't just say it's in the UI. If the run failed/aborted and the user wants it exported as-is, preserve that status in the wording — don't heal first.`

const PORTIFY_INSTRUCTIONS = `Canary Lab — portify profile. Make a feature's ports injectable so it can boot concurrently (benchmark arms / parallel runs).

- Port-ify it YOURSELF (no local agent): start_external_portify(feature) sets up scratch worktree(s) and returns targets[] (edit paths) + configPath + instructions; edit the listeners IN PLACE to read an injected port, declare the matching \`ports\` slots in the config, then submit_external_portify(workflowId) — Canary boots the stack twice concurrently to verify. On "ready-to-save" call save_portify(workflowId, confirm:true). If it returns to "editing" the double-boot FAILED: get_portify then carries a \`prompt\` — the retry playbook — alongside verification.failureDetail; follow it (a \`baseline-boot-failed\` verdict means the app's own solo boot is broken and ports are NOT the blocker; \`concurrency-failure\` means a listener still binds a hardcoded port, very often a NON-HTTP one — gRPC, WebSocket, raw TCP, a metrics/admin port — or the two boots race on a shared build dir), fix the worktree, and submit_external_portify again (re-edit + re-submit is unbounded). If the human asks for a CHANGE after verification passed, call revise_external_portify(workflowId, feedback) — it reopens the same verified worktree at "editing" and returns a \`prompt\` restating the constraints; do NOT cancel_portify to make a change, that discards verified work and you start over. get_portify(workflowId) re-reads status + the verification result at any time (diff omitted by default; includeDiff:true inlines it). cancel_portify(workflowId, confirm:true) discards it. One workflow PER FEATURE (a second start on the same feature is a 409); DIFFERENT features port-ify concurrently up to a resource cap, so to portify several features at once fan out a subagent per feature — at capacity start_external_portify returns a 429, so wait for one to finish (or save/cancel it) and retry. The GUI shows each live as an external session; list_portify_status shows which features are portified. Within ONE feature that has multiple repos, FAN OUT the per-repo edits: one subagent per repo in a single parallel round (up to 5 at once), each editing only its own worktree path — then do the SHARED files yourself, once (the feature config and the envsets are single files every repo's slots land in, so concurrent writers clobber each other), and submit once. Treat a subagent that reports nothing as unfinished, not as a repo with no listeners: the double-boot catches a missed listener only when it binds eagerly and dies loudly on the clash.
- Already env-driven? If the repo ALREADY reads injected ports (e.g. it was portified for another feature, or the listeners are committed env-driven), no source edit is needed — just declare the matching \`ports\` slots in the config and submit_external_portify. The double-boot still verifies the concurrent boot, and save records an EMPTY overlay (a no-op at run time). An empty diff is only rejected when the boot also fails (the listeners genuinely don't read the injected ports yet).
- Borrowed start: if ANOTHER feature already saved an overlay for the same app, Canary pre-applies that patch into your scratch worktree at setup, and the returned \`instructions\` list the exact \`ports\` slots that feature declared. START from that list rather than re-deriving it from the diff — then check it against the start command(s) THIS feature boots and add a slot for any listener they expose that the list misses (a differently-booted stack can bind a port the other feature never did). If this feature ALREADY declares every listed slot there is nothing to edit at all: Canary starts the double-boot itself, the instructions say so, and you POLL \`get_portify\` instead of submitting (submit 409s while that boot is in flight). Otherwise review the edits, declare the slots, then submit. The borrowed lines are captured into THIS feature's own overlay, so it stays self-contained.
- Saving captures the verified edits as an EPHEMERAL OVERLAY under features/<feature>/portify/ — nothing committed or merged, so the product repo stays pristine; each run applies the overlay into a fresh per-run worktree (disjoint ports) before boot and reverse-applies at teardown. If the overlay later stops applying (the repo moved under it), the run fails loudly asking you to re-portify (start_external_portify, or the GUI).
- Undo it: remove_portification(feature, confirm:true) reverts the feature config (the declared \`ports\` slots + \`\${port.x}\` health-check rewrites, restored from the snapshot saved with the overlay) and deletes the overlay, so the feature is no longer portified. Re-run start_external_portify (or the GUI) to redo.`

// `lifecycle` carries the everyday one-session loop (repair + author +
// coverage + flight + export + verify); `full` adds the portify instructions
// on top. Keep these compositions in step with TOOLS_BY_PROFILE in tools.ts.
const LIFECYCLE_INSTRUCTIONS = `${REPAIR_INSTRUCTIONS}\n\n${AUTHOR_INSTRUCTIONS}\n\n${COVERAGE_INSTRUCTIONS}\n\n${FLIGHT_INSTRUCTIONS}\n\n${EXPORT_INSTRUCTIONS}\n\n${VERIFY_INSTRUCTIONS}`

// Exported so `repair-guardrail.test.ts` can pin the repair rule ("fix
// app/service code, not tests") on every profile that can drive a heal loop.
export const INSTRUCTIONS_BY_PROFILE: Record<CanaryLabMcpProfile, string> = {
  repair: REPAIR_INSTRUCTIONS,
  verify: VERIFY_INSTRUCTIONS,
  author: AUTHOR_INSTRUCTIONS,
  coverage: COVERAGE_INSTRUCTIONS,
  export: EXPORT_INSTRUCTIONS,
  flight: FLIGHT_INSTRUCTIONS,
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

  // The session's McpServer, kept alongside its transport. Previously it was
  // constructed in newSession and dropped on the floor, so nothing could reach
  // `.server.getClientVersion()` / `.getClientCapabilities()` — which is why
  // Canary never knew WHICH client was connected and instructed a subagent-less
  // Desktop chat client exactly like the CLI. Read-only bookkeeping: the
  // transport still owns the session lifecycle.
  const sessionServers = new Map<string, McpServer>()

  // Tool counts are static per profile — register tools on detached McpServer
  // instances (never connected to a transport) so /mcp/health can answer
  // without requiring an active MCP session.
  const toolCounts = Object.fromEntries(
    CANARY_LAB_MCP_PROFILES.map((profile) => [profile, countToolsForProfile(deps, profile)]),
  ) as Record<CanaryLabMcpProfile, number>

  const newSession = async (
    profile: CanaryLabMcpProfile,
    // undefined = the connect URL carried no client_kind; the session then
    // brands itself from the initialize handshake (see registerCanaryLabTools).
    defaultClientKind: ClientKind | undefined,
  ): Promise<StreamableHTTPServerTransport> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport)
        sessionServers.set(id, mcp)
      },
    })
    // One cleanup path for every way a session can end. The transport's
    // `onsessionclosed` hook fires only for a client DELETE, while `onclose`
    // covers that *and* any close the transport initiates itself — so wiring
    // both meant the second one always ran against maps the first had already
    // emptied. The entry is found by identity rather than by reading
    // `transport.sessionId`, which is typed nullable and would need a guard no
    // reachable close can take (a transport only closes after its handshake).
    //
    // ORDERING IS LOAD-BEARING: this assignment must stay ABOVE `mcp.connect`
    // below. The SDK's `Protocol.connect` CHAINS whatever `onclose` it finds
    // rather than replacing it, so assigning first means both handlers run.
    // Moving this after the connect would silently drop the SDK's own cleanup.
    transport.onclose = () => {
      for (const [id, live] of transports) {
        if (live !== transport) continue
        transports.delete(id)
        sessionServers.delete(id)
      }
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
      // Fastify types every header as `string | string[]`, but Node's parser
      // only hands back an array for `set-cookie`: a repeated Mcp-Session-Id
      // arrives already comma-joined, and that joined value simply matches no
      // session and 404s below. `toString()` keeps the type in step with that
      // instead of leaving an array arm no request can reach.
      const sessionId = req.headers['mcp-session-id']?.toString()

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
      // sending, our Fastify layer needs to close the reply cleanly. No
      // `reply.sent` guard: every refusal above sends and returns in the same
      // breath, so nothing inside the try can throw after a reply went out —
      // and a reply the transport already wrote to res.raw leaves `sent` false
      // anyway, so the guard never protected that case either.
      app.log.error({ err }, 'MCP transport.handleRequest threw')
      reply.code(500).send({ error: (err as Error).message })
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
      // A bare health probe has no initialize handshake to brand itself from,
      // so an absent param reports the same 'other' a kind-less session used
      // to get; real sessions resolve the fallback per call instead.
      clientKind: context.clientKind ?? 'other',
      toolCount: toolCounts[context.profile],
      tools: toolsForCanaryLabMcpProfile(context.profile),
      activeSessions: transports.size,
      // What is actually on the other end of each live session. Exposed as a
      // PROBE: it answers "does any real client declare sampling?" and "which
      // Claude surface is this?" from live handshakes instead of from a guess,
      // and it is the cheapest way to confirm a capability landed before any
      // feature is built on it.
      clients: [...sessionServers.entries()].map(([sessionId, mcp]) => ({
        sessionId,
        ...classifyMcpClient(mcp.server.getClientVersion(), mcp.server.getClientCapabilities()),
      })),
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
  | { ok: true; profile: CanaryLabMcpProfile; clientKind: ClientKind | undefined }
  | { ok: false; error: string } {
  const params = new URL(url, 'http://localhost').searchParams
  const rawProfile = params.get('profile') ?? undefined
  const profile = normalizeCanaryLabMcpProfile(rawProfile)
  if (!profile) return { ok: false, error: `invalid MCP profile: ${rawProfile}` }
  // An absent param means "not stated", not "other": the session falls back to
  // the initialize handshake identity (clientKindFromFacts), so the bridge's
  // explicit param stays authoritative — including the runner's `*-pty` kinds
  // that suppress heal claiming — while a raw HTTP client is still branded by
  // who its handshake says it is instead of as a generic "AI Agent".
  const rawClientKind = params.get('client_kind')
  if (rawClientKind === null) return { ok: true, profile, clientKind: undefined }
  if (!isClientKind(rawClientKind)) {
    return { ok: false, error: `invalid MCP client_kind: ${rawClientKind}` }
  }
  return { ok: true, profile, clientKind: rawClientKind }
}

function countTools(mcp: McpServer): number {
  // The McpServer keeps registered tools on a private field; the public
  // surface doesn't expose a count. Introspection — we cast to any only here so
  // the rest of the file stays typed. The field is initialized in the SDK's
  // constructor, so it is always an object; an SDK rename would throw here
  // rather than silently report every profile as having zero tools, which the
  // smoke test's tool-count mirror would then have to catch on its own.
  const tools = (mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
  return Object.keys(tools).length
}
