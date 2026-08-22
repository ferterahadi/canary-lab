# Canary Lab Architecture

Contributor reference for system boundaries, runtime mechanisms, and contracts
that must move together. `CLAUDE.md` owns commands and hard rules; repository
skills own procedures; this document explains how the shipped parts cooperate.
See the [PRD](PRD.md) for product intent and the [README](../README.md) or
[Guide](GUIDE.md) for usage.

At runtime, one local server composes the web UI, REST routes, WebSocket streams,
and Model Context Protocol (MCP) tools over shared stores. Thin CLI commands and
external agents call those same server-owned workflows. Playwright and the
coverage ledger compute verdicts; agents produce candidate artifacts and fixes.

**Contents**

- [Package Model](#package-model)
- [Module Map](#module-map)
- [Run Lifecycle](#run-lifecycle)
- [Flight Pipeline](#flight-pipeline)
- [Concurrency](#concurrency)
- [Heal System](#heal-system)
- [MCP Layer](#mcp-layer)
- [Portify and Benchmark](#portify-and-benchmark)
- [Requirement Coverage](#requirement-coverage)
- [Keep-in-Sync Invariants](#keep-in-sync-invariants)

## Package Model

- Canary Lab publishes one CLI. User-facing commands are `flight`, `init`,
  `setup`, `ui`, `mcp`, `new feature`, `env`, `boot`, and `upgrade`. `fly` is a
  deprecated alias for `flight`. `agent` and `install-browsers` support setup
  and generated workspaces rather than the normal product workflow.
- Package internals ship as compiled code in `dist/` (built by `npm run build`:
  `tools/gen-agents-md.mjs` → `tools/gen-codex-skills.mjs` → `tools/clean-dist.mjs`
  → `tsc -p tsconfig.build.json` → `tools/prepare-assets.mjs` → Vite build for the
  web UI). The two `gen-*` steps are generators: `AGENTS.md` and the Codex copies of
  the shipped skills are build outputs, not hand-edited files.
- Scaffold templates live in `templates/project/` and are **copied into
  `dist/templates/` during build** by `tools/prepare-assets.mjs`. Editing a template
  without rebuilding does nothing for consumers — `npm run smoke:pack` is the
  packaging-level check.
- The only public import surface for generated projects is
  `canary-lab/feature-support/...` (via `package.json` exports). Everything under
  `apps/` and `shared/` is internal.

### Import aliases are bundler-only

`apps/web` may import across boundaries by alias — `@/…` for `apps/web/src/…`,
`@shared/…` for repo-root `shared/…`. Vite resolves both at bundle time, so no
alias-shaped specifier survives into the output.

**Nothing else in the repo may use them.** The server, CLI, and `shared/` are
emitted by `tsc -p tsconfig.build.json`, and TypeScript does *not* rewrite path
aliases on emit — `package.json` declares no `imports` field, so an aliased
specifier there would ship to `dist/` as a literal `require("@server/…")` and fail
at runtime in the installed package. `tsc` pulls the whole server tree into the
build through `apps/cli/ui-command.ts`, so this covers all of `apps/web-server/`.

Lifting the restriction means adding a resolver (a post-build specifier rewrite, or
Node subpath `imports` plus a `moduleResolution` bump) — not just another `paths`
entry. The three places that must agree for the web aliases are
`apps/web/tsconfig.json`, `apps/web/vite.config.ts`, and `vitest.config.ts` (whose
`projects` entries are standalone configs and each need their own `resolve.alias`).

## Module Map

| Path | What lives there |
| --- | --- |
| `apps/cli/` | CLI entry, scaffold/setup/upgrade/env commands, MCP bridge (`apps/cli/mcp.ts` includes `inferMcpClientKind` client-kind detection) |
| `apps/web-server/src/server.ts` | Fastify app: UI assets, REST routes, WebSocket streams, the `startRun` factory, scheduler wiring |
| `apps/web-server/src/mcp/` | MCP HTTP server and tool registration. `server.ts` owns transports and profile instructions; `tools.ts` applies the profile gate and calls the `reads`, `authoring`, `run-lifecycle`, and `heal-flow` registrars. `authoring.ts` composes feature, envset, draft, coverage, export, Flight, and Portify tool groups. `tool-profiles.ts` is the source of truth for profile membership. |
| `apps/web-server/src/features/` | Server features. `runs` owns execution and repair; `coverage` owns the ledger and deployed verification; `flights` owns the conducted pipeline; `wizard` stores external test-authoring drafts; `evaluation` owns exports; `config` owns feature and project configuration; `portify` owns port overlays; `benchmark` owns the preview harness; `agent-sessions` owns process and transcript state; `version` owns update checks. |
| `apps/web-server/src/shared/` | Web-server-local shared infra: `git-repo`, `gh-cli`, `ring-buffer`, `simple-zip`, `toon`, `workspace-events`, `editor-launch`, `open-browser`, `prompts` (the `.md` template loader), `feature-loader`, `launcher-startup` (service startup + health probes), `config-ast`, `ast-extractor` (the Playwright tag/assertion parser the coverage ledger reads), and `ws/workspace-stream` |
| `apps/web-server/src/features/runs/logic/runtime/` | The run orchestrator and its modules (see [Run Lifecycle](#run-lifecycle) and below) |
| `apps/web/` | React UI (Vite, Tailwind) |
| `shared/e2e-runner/` | Playwright fixture support (`log-marker-fixture`, summary reporter) |
| `shared/configs/` | Base Playwright config and env loader |
| `shared/runtime/` | Shared project-root resolver |
| `templates/project/` | Files copied into initialized workspaces. The storefront sample exercises Run and Heal, `flight-app/` starts without a feature so Flight has real onboarding work, and `workflow-app/` plus `features/workflow-workbench/` exercises Coverage, Author, Portify, and Verify. |
| `tools/` | Build/publish utilities: `gen-agents-md`, `gen-codex-skills`, the demo PRD-summary generators, `clean-dist`, `prepare-assets`, `smoke-pack`, `smoke-demo`, `publish-package`, `generate-changelog`, `tag-release`, `fix-node-pty-permissions`, plus the repo gates. `tools/fixtures/` holds contributor-only fixtures; the storefront and workflow-workbench suites ship in the scaffold under `templates/project/features/`. |

**Web `cleanup` has no server twin, on purpose.** The `apps/web/src/features/cleanup`
feature consumes `/api/cleanup/*`, but those routes stay with the features that own
the data being deleted — `/api/cleanup/runs` and `/api/cleanup/worktrees` in
`features/runs/routes/runs-cleanup-routes.ts`, `/api/cleanup/portify` in
`features/portify/routes/portify.ts`. Do not go looking for a `cleanup` server
feature, and do not create one: it would pull run and portify deletion away from the
stores that back them, for nothing but symmetry. The web side is named after the API
surface it consumes so the two are greppable together. (In the UI this is the
**Cleanup** pill, with three tabs — Runs, Worktrees, Portify.)

Key `apps/web-server/src/features/runs/logic/runtime/` modules:

| Module | Role |
| --- | --- |
| `orchestrator.ts` | Single-run lifecycle: env apply, service boot, Playwright run, heal cycles, manifest/journal writes |
| `pty-spawner.ts` (+ `apps/web-server/src/shared/launcher-startup.ts`) | Service startup, health probes (HTTP/TCP), PTY capture |
| `launcher/interpolate.ts` | Token resolution — the reserved `${port.<slot>}` namespace |
| `port-allocator.ts` | Per-run free-TCP-port allocation per declared port slot |
| `admission.ts`, `run-scheduler.ts` | Resource-aware admission + FIFO queue promotion |
| `repo-collision.ts`, `repo-worktree.ts` | Same-repo collision detection + per-run git worktree isolation |
| `auto-heal.ts` | Local heal-agent binary resolution and spawn command building |
| `heal-cycle.ts`, `heal-prompt-builder.ts` | Heal-cycle state machine and prompt assembly |
| `manifest.ts`, `run-paths.ts`, `run-id.ts` | Run manifest schema and path/id conventions |
| `summary-reporter.ts`, `log-enrichment.ts`, `trace-enrichment.ts` | Evidence capture and enrichment |
| `apps/web-server/src/features/portify/logic/runtime/` | Agent-driven port-injection workflow; see [Portify](#portify-and-benchmark) |
| `apps/web-server/src/features/benchmark/logic/runtime/` | Multi-arm self-heal benchmark, exposed as a preview behind `?showBenchmark=true` |
| `apps/web-server/src/features/coverage/logic/coverage/` | PRD summary, semantic coverage, latest-run proof join, strictness grading, and the shared service used by REST and MCP |

### Feature boundaries and per-feature layout

The two apps share an **eight-feature spine** — `runs`, `coverage`, `flights`,
`wizard`, `evaluation`, `config`, `portify`, and `benchmark`. The server also has
`agent-sessions` and `version`; the web app also has `cleanup`. Shared agent
views and sockets live in `apps/web/src/shared/` because several web features
render the same agent-session data. The two sides enforce ownership differently.

**Server features are registrars, not re-export barrels.** Each
`apps/web-server/src/features/<name>/index.ts` exports `register(app, ctx)` and
returns a handle other features consume — `runs` returns
`{ scheduler, attachRunStreams, restartExternalRun }`, which `benchmark`,
`coverage` and the MCP mount all take. Don't turn one into a re-export barrel;
`server.ts` depends on the register/handle contract.

**Web features are re-export barrels.** Each
`apps/web/src/features/<name>/index.ts` names that feature's public surface. A
feature may import another only through its barrel, never a path inside it:

```
✔  import { RunRow } from '@/features/runs'
✘  import { RunRow } from '@/features/runs/components/RunRow'
```

`npm run check:boundaries` enforces this and fails on three things: a deep
cross-feature import, a feature that is consumed but has no barrel, and a stale
entry in its `ALLOWED_DEEP` allowlist. The allowlist exists because routing
**both** directions of a mutually-dependent pair through barrels is an ESM
module-init cycle; `coverage ⇄ flights` is the one surviving pair (the flight
page embeds coverage's docs rail, the coverage page renders flight stage chips).
Shrink that list, don't grow it.

**Two shared aliases, easily confused.** `@shared/` is the repo-root `shared/`
package (published types, shared with the CLI). `@/shared/` is the web app's own
`apps/web/src/shared/`. A lint or codemod written against the wrong one passes
while enforcing nothing.

**Which subdirs a feature has is deliberate, not uniform.** `logic/` is
universal on the server; `routes/` and `ws/` exist only where the feature serves
HTTP or streams. On the web, `components/` is universal while `state/`, `api/`,
`lib/` and `utils/` appear only where needed — web `config` is ~6,000 lines of
components with no state or api layer, and that is correct. A feature with no
realtime surface should **not** carry an empty `ws/`.

**When a module belongs in `shared/`, not a feature.** If several features use a module and it imports no feature code, treat it as shared infrastructure. Shared agent views, sockets, atoms, and client branding already follow this rule. Two recorded cross-feature exemptions remain; `npm run check:boundaries` is the source of truth. Moving code into `apps/web/src/shared/api/**` or `shared/lib/**` also brings it into the 100% coverage gate.

## Run Lifecycle

Code path for a run started from `canary-lab ui`:

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontFamily": "Inter, ui-sans-serif, system-ui, sans-serif", "primaryTextColor": "#0f172a", "lineColor": "#64748b", "clusterBkg": "#ffffff", "clusterBorder": "#cbd5e1"}}}%%
flowchart TD
    user(["Run button in canary-lab ui"])
    web["Web server + run store<br/>server.ts + run-store.ts"]
    runtime["Run orchestrator<br/>orchestrator.ts + run-paths.ts"]
    setup["Env + service startup<br/>env-switcher/switch.ts + pty-spawner.ts + shared/launcher-startup.ts"]
    playwright(["Playwright"])
    capture["Run capture<br/>log-marker-fixture.ts + summary-reporter.ts"]
    autoheal["Auto-heal command builder<br/>auto-heal.ts"]
    agent(["AI Agent"])

    subgraph runDir["logs/runs/{{runId}}/"]
        state[/"manifest.json + runner.log"/]
        logs[/"svc-*.log + playwright.log"/]
        evidence[/"playwright-events.jsonl + playwright-artifacts/ + e2e-summary.json"/]
        healctx[/"failed/{{slug}}/ + heal-index.md + diagnosis-journal.md"/]
        session[/"agent-session.json + agent-session-id.txt"/]
        signals[/"signals/.heal + .rerun + .restart"/]
    end

    user --> web --> runtime --> setup --> playwright
    runtime --> state
    setup --> logs
    playwright --> logs
    playwright --> capture
    capture --> evidence
    capture --> healctx
    evidence --> autoheal
    healctx -.-> autoheal
    autoheal --> agent
    agent --> session
    agent -.-> healctx
    agent --> signals
    signals --> runtime

    classDef entry fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e,stroke-width:2px
    classDef core fill:#eef2ff,stroke:#4f46e5,color:#312e81,stroke-width:2px
    classDef runtime fill:#f0fdf4,stroke:#16a34a,color:#14532d,stroke-width:2px
    classDef test fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px
    classDef heal fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px
    classDef artifact fill:#f8fafc,stroke:#64748b,color:#334155,stroke-width:1.5px

    class user entry
    class web core
    class runtime,setup runtime
    class playwright,capture test
    class autoheal,agent heal
    class state,logs,evidence,healctx,session,signals artifact
```

In prose: the run routes use `buildRunsRouteDeps` to admit or queue work, allocate
ports, apply the selected envset, and attempt per-repository worktree isolation.
The MCP `start_run` tool calls the same route through `app.inject()`, so it does not
own a second execution path. `orchestrator.ts` then boots services through the
launcher/PTY layer, runs Playwright, and captures evidence. Service output is
written directly to `svc-<name>.log`; it does not depend on a visible terminal.

On failure, the run either spawns a local heal agent or parks for an external
client. The agent fixes code and signals `rerun` or `restart`; the orchestrator
continues the same run until pass or terminal failure. At teardown, Canary Lab
captures repair diffs only for worktrees with a valid baseline. A captured repair
that heals the run green may then be proposed as a draft pull request.

### Logging and retention

Logs live under `<workspace>/logs/`. Per-run artifacts are in `logs/runs/<runId>/`:
`runner.log` (orchestrator narration), `svc-<name>.log`, `playwright.log`,
`external-commands.jsonl` (per-command audit for external heal), `fixes/` (captured
repair diffs), `playwright-artifacts-keep/` (latest per-test artifacts across repair
reruns), failure slices, and the manifest. There is no automatic retention/pruning:
runs persist on disk until removed manually via the Cleanup page's **Runs** tab
(`GET /api/cleanup/runs`, backed by `RunStore.delete` / `trimArtifacts`), which deletes
whole runs or trims Playwright artifacts while keeping the manifest and `runner.log`.

## Flight Pipeline

Flight is the server-owned onboarding pipeline behind the CLI, web UI, and MCP
surface. `shared/flights/types.ts` defines the ordered stage keys and wire model;
`apps/web-server/src/features/flights/logic/conductor.ts` persists transitions;
adapters under `apps/web-server/src/features/flights/logic/stages/` call the owning feature's routes rather than
reimplementing coverage, Portify, runs, or export.

| Stage | Server-owned result |
| --- | --- |
| `similarity` | Match an existing feature or establish a new one |
| `scout` | Candidate repository survey and feature config |
| `scaffold` | Valid feature skeleton on disk |
| `env-capture` | Envset files and unresolved-key checkpoint |
| `docs` | Requirement source collection |
| `prd-summary` | Stable structured requirements and readable summary |
| `specs-coverage` | Compiling Playwright specs plus deterministic coverage ledger |
| `portify` | Saved overlay backed by concurrent double-boot verification |
| `run` | Terminal Playwright run manifest |
| `heal` | Read-only mirror of the run manifest's heal mode and cycle count |
| `evaluation-export` | Existing evaluation archive |

One feature has one Flight manifest. The conductor persists stage evidence and
typed checkpoints, then resumes from the first unfinished stage. A plain resume
preserves artifacts. A stage jump resets that stage and all later stages after
checking declared prerequisites in `STAGE_DEPENDS_ON`; a full redo resets the
entire pipeline.

### Stage producers

`FlightOptions.stageProducer` selects who performs judgment-heavy work:

- `internal` is the default. Canary Lab spawns the CLI selected by `agent`.
- `external` is available to MCP-started Flights. Scout, docs, PRD summary,
  spec authoring and mapping, Portify, run repair, and localized export park on
  `external-work` checkpoints. The connected client performs the task and
  submits its result.

The producer does not own the verdict. Every adapter re-reads or recomputes its
artifact before settling: configs must parse and boot, requirement submissions
are reconciled and read back, specs must compile, every roster test must be
accounted for before Canary Lab writes tags, Portify must reach its verified
state, runs must have a terminal manifest, and exports must exist. A client can
hand one step back with `run-internally`.

`external-work` reuses checkpoint persistence so the conductor returns instead
of polling while another client works. Each handoff carries a `handOffId`; a late
submission is rejected if the Flight stopped, resumed, or issued a newer handoff.
Portify and run/heal park once per engagement while the client drives their
standalone workflows.

## Concurrency

Multiple runs can be active at once (since 1.2.0). The top-right **Runs** dialog in
`canary-lab ui` lists every run (running/healing/queued/finished).

### Per-run ports

A `startCommand` declares `ports: [{ name: 'api', env: 'PORT' }]` (env optional). The
orchestrator allocates a free TCP port per slot per run
(`apps/web-server/src/features/runs/logic/runtime/port-allocator.ts`), injects it as the service's `env`
var (`PORT`), exposes it to config via the reserved token `${port.api}`, and to the
Playwright process as `CANARY_PORT_<shell-safe-slot>`. Config tokens keep the slot
name verbatim, while Playwright's environment key replaces every character outside
letters, digits, and `_` with `_` (`checkout-service` →
`CANARY_PORT_checkout_service`) because interactive shells drop invalid environment
names. Slots that collide after normalization are rejected before Playwright starts.

`${port.<slot>}` resolves in **three places** (the `port` token namespace lives in
`apps/web-server/src/features/runs/logic/runtime/launcher/interpolate.ts`):

1. the **command** (`--port ${port.api}`),
2. the **`healthCheck`** URL,
3. at apply-time, inside **applied envset files** (`.env`/`.properties`/`.env.local`)
   via `applySet`'s resolver (`resolvePortTokens`).

So inter-service URLs and config-file listen ports (e.g. Spring
`server.port=${port.api}`, `dev.url=http://localhost:${port.web}`) follow the
run's allocation. Test helpers resolve the target as
`CANARY_PORT_api → GATEWAY_URL → hardcoded default` (see
`templates/project/features/storefront-journey/e2e/helpers/api.ts`). The CLI `env`
switching path passes no resolver, so it stays a verbatim copy.

### Run worktrees and fix capture

Every regular `executionType: 'run'` **attempts** to isolate each configured repo
in a per-run Git worktree under `<runDir>/worktrees/`. Each worktree starts from
`HEAD`, links the source repo's `node_modules`, and replays the user's tracked and
untracked work in progress through `hydrateWorkingTreeDiff`, so the run normally
tests the checkout's current state rather than committed state alone.

Isolation is best-effort for a non-portified repo. If `git worktree add` fails,
the run logs the failure and uses the source checkout in place. That fallback
keeps the run usable, but it also means the repair agent may edit the checkout
and no worktree baseline exists for automatic fix capture. A portified repo has
no such fallback: the run fails before boot because its overlay must be applied
in an isolated worktree.

The normal worktree path exists for fix capture. `captureFixBaseline` stores a baseline ref after
overlay + envset + WIP hydration, so the teardown diff is exactly the repair; `captureFixes`
writes it to `<runDir>/fixes/<repo>.patch` + `fixes.json` + `manifest.fixCapture` before the
worktree goes away. On this path, the heal agent does not mutate the source checkout;
its edits reach the user as a patch file and, on a green healed run, may become a draft
pull request (see [End-of-run pull request](#end-of-run-pull-request)). Non-portified
worktrees are removed at teardown; a portified run reverses
its overlay but *keeps* the worktree (it holds the repair, and the Cleanup page's Worktrees
tab owns its lifecycle). Boot, verify and benchmark sessions keep the older
portified/collision-only behaviour — they don't heal, so there is nothing to capture.

### Same-repo collision

Worktrees isolate files, not fixed network listeners. Starting a non-portified
run while another active run uses the same repo returns
`repo_collision_requires_choice` (REST 409 / MCP result). The user may choose
**worktree** to bypass the edit collision and run now, or **queue** to wait.
Choosing worktree does not rewrite fixed ports; the second boot can still fail
with an address-in-use error. Queue is the safe choice unless the feature's
services already accept distinct injected ports.

Different-repo runs do not trigger this collision check. A portified feature
registers no repo collision because its verified overlay gives each boot
distinct allocated ports and it always uses worktrees. See
`apps/web-server/src/features/runs/logic/runtime/repo-collision.ts` + `repo-worktree.ts`.

### Admission and queue

Runs beyond a CPU/free-RAM heuristic are parked as `queued` (status `queued`, with
`manifest.queueReason`) and promoted FIFO on run-end. Optional hard ceiling via env
`CANARY_MAX_CONCURRENT_RUNS`. The scheduler is
`apps/web-server/src/features/runs/logic/runtime/run-scheduler.ts` (decision logic in `admission.ts`);
it's wired into the `startRun` factory in `server.ts` and promotes on the RunStore
`finalized` event.

### Getting Started ownership

The two core Getting Started workflows add a narrower workspace-level guard above
normal run/Flight admission. `GettingStartedSessionStore` persists the current
owner in `<logs>/getting-started/session.json`; both REST starts and MCP starts
claim it before creating work, then attach the real run or Flight ID. A competing
internal or external start receives the same typed `getting_started_busy` 409.
Run/Flight store events reconcile the guard from persisted evidence, so closing
the dialog never stops work and terminal evidence releases the owner. A failed
Run gets a short settle grace because auto-heal records `failed` immediately
before changing the same run to `healing`; releasing in that transition would
allow two demos to overlap. Completed run and Flight targets remain in the file
as navigation references.

This guard does not serialize ordinary user runs. The smaller workflow demos use
their existing subsystem locks. The Verify demo composes two existing run records:
a held boot session supplies the allocated local URL to an observational verify
run, and that verify run owns server-side cleanup of the boot session when it
settles. The verification route permits that one named boot record beside the
verify run while continuing to reject unrelated active executions.

### Multi-service limits (what concurrency can't auto-fix)

Worktree isolation covers concurrent repair edits, not ports. Two runs of the
same fixed-port app should queue; an explicit worktree bypass may still fail at
boot. Apps that hardcode a port in source (ignoring `PORT`/`--port`/config) cannot be relocated until
[Portify](#portify-and-benchmark) fixes. OAuth issuer + redirect URIs are
pre-registered with the provider for a fixed host:port, so OAuth features (e.g.
`shop_oauth`) run one at a time regardless of any rewiring. The `${port}` envset
resolver and a verified source overlay unlock same-app concurrency; the envset
resolver alone cannot fix a listener that ignores its injected value.

## Heal System

### Local auto-heal

With `healAgent: 'claude'|'codex'|'auto'`, the orchestrator spawns a local agent CLI.
The agent's **absolute path** is resolved by `resolveAgentBinary`
(`apps/web-server/src/features/runs/logic/runtime/auto-heal.ts`): explicit override
(`CANARY_LAB_CLAUDE_BIN` / `CANARY_LAB_CODEX_BIN`) → `which` (PATH) → well-known
locations (`~/.local/bin`, homebrew, `/usr/local/bin`, npm-global, pnpm, nvm
`node/*/bin`). The resolved path is threaded into `buildAgentSpawnCommand` as
`binaryPath` so the agent spawns even when the UI server was launched with a minimal
PATH (e.g. by Claude Desktop, which omits `~/.local/bin`). Without this, `which claude`
fails under a Desktop-spawned server → `healMode: None` → run fails with no heal.
`binaryPath` is omitted in unit tests (they assert the bare `claude`/`codex` command).
`heal-cycle.ts` tracks cycle state; `heal-prompt-builder.ts` assembles each cycle's
prompt.

Before the spawn, `ensureHealWorkspaceTrusted` settles Claude Code's folder-trust
prompt for the project root — see the [invariants table](#keep-in-sync-invariants).
The repair agent is the only one canary spawns on an interactive TTY, so it is the
only one that prompt can stop, and under autopilot nobody is there to answer it.

The model is the agent's own default. `CANARY_LAB_HEAL_MODEL` pins it for one server
(`healModelsFromEnv`, `agent-sessions/logic/agent-models.ts`) — read once at boot.
That override exists to **demonstrate** the loop: on the strongest model the repair
agent reads the whole service and fixes every defect in one pass, which is a good
outcome that shows none of the try / rerun / try again the loop is for. The default
must stay agent-default — repair is the product.

### External heal

When `manifest.healMode === 'external'` the orchestrator parks at
`waiting-for-signal` and an MCP client drives `claim_heal` → `get_heal_context` →
edit code → `signal_run`. `ExternalHealBroker`
(`apps/web-server/src/features/runs/logic/heal/external-heal-broker.ts`) owns the single-claim
lock and reclaims a claim whose heartbeat has gone stale — `HEARTBEAT_STALE_MS` in
`shared/run-state.ts`, currently **10 minutes**. `wait_for_heal_task` heartbeats
while it waits; a client doing longer local work must refresh its claim before
the window expires. Every external command is audited at
`<runDir>/external-commands.jsonl`.

### Heal-claim policy (block runner PTYs)

Every **interactive** client kind may *own* a heal claim: `claude`, `codex` (Desktop
and CLI both collapse to these — we no longer distinguish), and even undetected
`other` (assumed to be a person at a terminal). The only kinds blocked are the
runner-spawned PTY agents — `claude-pty`, `codex-pty` — which Canary Lab itself spawns
(benchmark sabotage, portify, …); letting one claim heal would have it claim its own
run. It's a **denylist** (`apps/web-server/src/features/runs/logic/heal/heal-claim-policy.ts`,
`isHealClaimAllowed`), because the dangerous case is the one we fully control: the
runner tags its spawns `*-pty` deterministically via `CANARY_LAB_MCP_CLIENT_KIND`
(set in `runAgentProcess`), so we never rely on heuristic detection to block it —
everything else fails *open* so a person can always heal. Override via
`CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS` (comma-separated kinds). Enforced at two layers:

1. a hard backstop in `broker.claim()` (covers `claim_heal`, REST `/claim`, the
   reclaim helper → returns `client-kind-not-allowed`), and
2. the `start_run` handler / `POST /api/runs` (which build the session bypassing the
   broker → return `claimSuppressed: true` and omit the heal-wait next-step instead
   of claiming).

Client kind is heuristically detected from process lineage in `apps/cli/mcp.ts`
(`inferMcpClientKind`).

**Trigger source decides the heal mode** (not the claim). Any run started by an MCP
client is *external-origin* and uses External‑client heal **regardless of the project
`healAgent` setting** — that setting governs only **UI/REST‑triggered** runs. The
`server.ts` `startRun` closure splits two flags: `externalOrigin`
(`healAgentReq.kind === 'external'`) disables project auto‑heal and forces
`externalHeal` mode; `canClaim` (`externalOrigin && claimable !== false`, i.e. an
interactive client) is what actually creates the `externalHealSession` + broker claim. So a
non‑claiming MCP client (a runner PTY agent) passes `claimable: false`: the run enters
external mode with **no** session and **waits** for an interactive/UI drive — it does *not*
fall back to a locally‑spawned auto‑heal agent. A PTY restart of a failed run follows
the same path (`restartExternalRun` with `claimable: false`) rather than being refused.

### Handoff

`handoff_heal`: active runs can only hand off to `manual` (the orchestrator can't add
a local autoHeal mid-flight); `auto`/`claude`/`codex` require a failed/aborted run.

### End-of-run pull request

A run that healed green does not stop at the patch file. `autoProposeFixes`
(`apps/web-server/src/features/runs/logic/pr/auto-propose.ts`) runs right after
`captureFixes` in the orchestrator's teardown and opens a **draft** pull request per repo,
so an unattended overnight repair leaves a review thread rather than a patch nobody knows
about. `shouldAutoPropose` is deliberately narrow, because a push is the one step here that
leaves the machine and can't be taken back: `executionType: 'run'` only (boot, verify and
benchmark sessions never heal), `status === 'passed'` only (a loop that gave up produced a
fix that did *not* work), `healCycles > 0`, and a non-empty `fixCapture`. Consent is the
workspace setting `autoProposePr` in `canary-lab.config.json` — default **on**, defaulted
and parsed in
`apps/web-server/src/features/runs/logic/runtime/launcher/project-config.ts`, validated on
write in `apps/web-server/src/features/config/routes/project-config.ts`, toggled under
Settings → GitHub. A `RunContext` with no `projectRoot` has no config to read, so it never
pushes.

`proposeFixesForRun` (`apps/web-server/src/features/runs/logic/pr/propose-fixes.ts`) is the
single mechanism behind both the automatic trigger and the user's own **Propose PR** dialog
(`POST /api/runs/:runId/propose-pr`); only the `draft` flag differs. The working copy is
still never touched: the patch is applied in a throwaway worktree cut from the captured
`baseSha`, committed, force-pushed, and turned into a PR by `gh`, whose own credential does
the push — Canary Lab never handles a token. What the product repo *does* gain is the fix
branch ref and its remote-tracking ref. The branch is scoped to **feature + repo**
(`fixBranchName(feature, repoName)` → `canary-lab/fix-<feature>-<repo>`), not to the run, so
healing the same feature three times updates ONE pull request instead of opening three. That
makes the order load-bearing: the push happens FIRST and an existing PR is looked up only
afterwards, so a reviewer never opens a stale earlier attempt.

Failure is recorded, never raised — a run's verdict must not depend on GitHub being
reachable. Every outcome, success and failure, lands on `manifest.prAttempt` (`RunPrAttempt`
in `shared/run-state.ts`: `at`, `auto`, and a per-repo `{ ok, url?, reason? }`), written
through `stateSink.patchManifest` so the runs WebSocket pushes it live; successes also merge
into `manifest.proposedPrs`. The web **Changes** tab
(`apps/web/src/features/runs/components/ChangesTab.tsx`, a tab of `RunDetailColumn`, disabled
rather than hidden when a run changed nothing) renders the captured diff per repo — served as
text by `GET /api/runs/:runId/fixes/:repoName/patch`, which 404s when the run captured nothing
for that repo and 410s once the Cleanup page trimmed the run directory away — next to the PR
link, or the per-repo reason there is none.

## MCP Layer

- The MCP HTTP server mounts at `localhost:<port>/mcp` (streamable HTTP) inside
  `canary-lab ui`. Health: `GET /mcp/health?profile=<p>`. The port is configured in
  `canary-lab.config.json` (`port` field) in the workspace directory — read it
  dynamically rather than assuming a fixed value (default 7421 if unset).
- **Profiles** pick the tool subset via `?profile=`. There are seven workflow profiles and two composed profiles: `repair` (heal loop), `verify` (verification configs), `author`
  (feature/envset/draft authoring), `coverage` (docs → PRD summary → ledger), `export`
  (evaluation archives), `flight` (the conducted pipeline), `portify` (port-injection
  workflow), then `lifecycle` (**the default**: repair + verify + author + coverage +
  export + flight, no portify) and `full` (lifecycle + portify). `coverage`, `export`
  and `flight` were carved out of what used to be one oversized `author` array; the
  composed unions absorbed the split, so nothing had to move twice. Optional
  `?client_kind=claude|codex|other|...` (the `*-pty` kinds are set by the runner, not passed by clients).
- Tools live in `apps/web-server/src/mcp/tool-groups/` — one module per domain
  section (`reads`, `authoring`, `run-lifecycle`, `heal-flow`), each a thin wrapper
  over existing REST routes/helpers. `start_run`/`write_envset`/etc. reuse handlers
  via `app.inject()`; don't duplicate orchestrator logic. Author-profile tools call
  `apps/web-server/src/features/config/logic/feature-authoring.ts` directly.
  `tools.ts` itself only builds the profile gate and calls the four registrars.
  The grouping is **by domain, not by profile**. Tools may belong to several profiles, so `tool-profiles.ts` owns membership; file layout does not.
- Profile membership = the `REPAIR_TOOLS`/`VERIFY_TOOLS`/`AUTHOR_TOOLS`/`COVERAGE_TOOLS`/
  `EXPORT_TOOLS`/`FLIGHT_TOOLS`/`PORTIFY_TOOLS` arrays, which live in
  **`mcp/tool-profiles.ts`** and reach the rest of the layer re-exported through
  `tool-support.ts`. `LIFECYCLE_TOOLS` auto-dedupes the union of all six non-portify
  arrays + `FULL_ONLY_TOOLS` (`get_run_actions`, `claim_heal`, `release_heal`);
  `FULL_TOOLS` is `LIFECYCLE_TOOLS` + `PORTIFY_TOOLS`. Because both are computed
  unions, adding a tool to any workflow array surfaces it in the composed profiles
  with no second edit. Adding/moving a tool does still require updating the mirror
  arrays in `mcp/server.smoke.test.ts` — see the
  [invariants table](#keep-in-sync-invariants) and the `cl_add-mcp-tool` skill.
- Each MCP session gets its own transport (`mcp/server.ts`) — a singleton would
  reject the 2nd client with `-32600 Server already initialized`.
- Destructive tools gate on `confirm: z.literal(true)` in their input schema
  (e.g. `abort_run`, `write_envset`).
- **Steering skill-less clients**: external clients act on the `initialize`
  instructions + tool *results*, not the Canary Lab skill. The server sends
  profile-aware `instructions` (`INSTRUCTIONS_BY_PROFILE`, `mcp/server.ts`); `repair`
  carries the External Run Loop. `start_run`/`signal_run` results add
  `nextSteps: ['wait_for_heal_task']` (`healWaitNext`, `mcp/heal-task-wait.ts`) so a
  result-driven agent blocks on `wait_for_heal_task` instead of polling
  `get_run_snapshot`. Following or waiting on a **boot-only run**
  (`executionType: 'boot'`, started via `boot_services`) instead returns
  `type: 'boot_session'` (`bootSessionValue`/`isActiveBootRun`, `mcp/heal-task-wait.ts`) from
  `start_run` and `wait_for_heal_task` — no heal claim, no `healWaitNext`, and
  `wait_for_heal_task` returns immediately rather than dead-waiting until timeout. A
  `passed` result additionally carries a `fix` block (`healFixOutcome`,
  `mcp/heal-task-wait.ts`) — per repo: files changed, plus the draft-PR url or the
  `noPrReason` there is none — whose `note` tells the client not to open or push one of its
  own. It has to ride the *result*: `REPAIR_INSTRUCTIONS` never mentions the pull request at
  all, so a skill-less client would otherwise push a duplicate branch on top of the one the
  run just opened.
- **Feature docs convention**: feature-scoped prose (distilled sessions, plans,
  notes) lives at `features/<name>/docs/<slug>.md`. The `write_feature_doc` MCP tool
  (`coverage` / `flight` / `lifecycle` / `full` profiles — **not** `author`) is the only
  sanctioned writer — create-or-replace, markdown only, path-traversal hardened, with
  `link_path` to symlink a local file in place instead of copying it. The draft-apply
  path rejects non-spec files, so docs do NOT go through it.

## Portify and Benchmark

**Portify** (`apps/web-server/src/features/portify/logic/runtime/`, ~16 files) is an agent-driven
workflow that rewrites a feature's services so every network listener reads an
injected port, proven by a concurrent double-boot — making the feature eligible for
concurrent runs and benchmark arms. Two execution models, split by who initiates
(see "Internal vs external execution" under Requirement Coverage — the same rule):
the **GUI** spawns a local agent (`startPortify`/`revise`, REST only) that streams
through `AgentSessionView`; **MCP clients** drive it themselves
(`start_external_portify` → in-place edits → `submit_external_portify`, the
re-edit+re-submit loop replacing `revise`) and the GUI shows `ExternalPortifyPanel`.
Both converge on `get_portify` (`editing → verifying → ready-to-save`) →
`save_portify`/`cancel_portify`. The two prompts that carry the internal agent
through a second pass have external equivalents so the surfaces stay level: a
failed double-boot re-parks at `editing` and `get_portify` rides the rendered
`portify-retry.md` back as `prompt`; a human asking for a change after
verification calls `revise_external_portify(workflowId, feedback)`, which reopens
the same worktree (`orchestrator.reopenExternal`) and returns
`portify-feedback.md` — the point being that `cancel_portify` would discard a
verified worktree that the client would then have to rebuild from scratch. One workflow **per feature** (a second start on the
same feature is a 409); different features port-ify concurrently up to a global
resource cap — `portifyConcurrencyCap()` reuses the run loop's `computeSlotBudget`
heuristic, with an optional manual ceiling via env `CANARY_MAX_CONCURRENT_PORTIFY`
(mirrors `CANARY_MAX_CONCURRENT_RUNS`). Over the cap, a start returns 429 (no queue —
the caller waits/retries). `list_portify_status` shows which features have a saved overlay.

**Ephemeral overlay model** (the source edits never touch the product repo): the
agent edits source in a throwaway scratch worktree and the verified diff is captured
as a per-repo patch under `features/<feature>/portify/` (`overlay.ts`: `writeOverlay`/
`readOverlay`/`overlayExists`/`checkStaleness`). `save_portify` writes the overlay and
discards the scratch worktree — nothing is committed or merged. At RUN time every repo is
already worktree-isolated (see [Run worktrees and fix capture](#run-worktrees-and-fix-capture); for a
portified feature this is non-negotiable rather than best-effort — a repo that can't be
worktree'd fails the run). The orchestrator `applyOverlay`s the
patch (plain `git apply`, `--3way` fallback) before boot after a staleness check, and
`reverseOverlay`s it (atomic `git apply -R`) at teardown while KEEPING the worktree
(it holds heal edits). Apply/staleness failure aborts the run loudly ("re-run Portify")
— it never boots un-portified. The feature-config `ports` slots + envset tokenization
the agent also writes are PERMANENT (Canary Lab reads the slots in `allocateRunPorts`
before the overlay applies), so only the product-repo source is ephemeral.

**Cross-feature reuse** (the overlay is filed per feature but the patch belongs to a
git ROOT): at setup `buildSiblingOverlayIndex` (`portify-worktree-borrow.ts`) indexes
every OTHER feature's non-empty patches by resolved git toplevel, `pickBorrowable`
prefers an exact base-SHA match then the newest capture, and the winner is
`applyOverlay`-ed into the scratch worktree AFTER the diff baseline — so the borrowed
lines flow into THIS feature's own captured overlay (self-contained, no pointer back to
the source feature). A conflict resets the worktree and the agent starts from scratch;
borrowing is an optimization, never fatal. What does NOT travel is the config half: the
`ports` slots are per feature, so each overlay ALSO records the slots its feature
declared (`OverlayRepo.ports`) purely as a hint — `buildSeededNote` hands that list to
the borrowing agent/client, which confirms it against the start commands THIS feature
boots (a differently-booted stack can bind a listener the source feature never did)
instead of re-deriving it from the diff. When the borrowing feature already declares
every recorded slot there is nothing left to edit at all, and `start_external_portify`
begins the double-boot itself (`seededSlotsAlreadyDeclared`) rather than waiting for a
submit — the internal path has the equivalent attempt-0 gate in `orchestrator.run()`.
The concurrent double-boot stays the only proof on every path. Because a borrowed patch
lands in features that may not boot the same peers, `portify.md` requires every port
rewrite — listener AND inter-service client — to keep its original value as a fallback,
so an un-injected peer is dialled exactly where it always was.

**Benchmark** (`apps/web-server/src/features/benchmark/logic/runtime/`, ~10 files) runs multi-arm
self-heal benchmarking (race/sabotage verification) — measuring how the repair loop
performs vs running tests without Canary Lab. The product surface was retired in 1.0.0
and **revived in 1.3.0** as a preview (groundwork for pluggable harnesses), gated behind
`?showBenchmark=true`. UI: `BenchmarkWindow`/`BenchmarkPill` (`apps/web/src/features/benchmark/`);
internal-only (no MCP tools); the sabotage agent streams through `AgentSessionView`.

## Requirement Coverage

The coverage ledger (`apps/web-server/src/features/coverage/logic/coverage/`)
computes static coverage from requirements, tags, and test source. When a run
exists, it joins a separate latest-run proof axis. Neither result is an agent's
self-report:

- **Breadth** — which PRD requirements have a mapped test. Source docs in
  `features/<feature>/docs/` are summarized into a `_prd-summary.json` sidecar of
  `Requirement`s (`prd-summary.ts`; agent-proposed, deterministic heading-extraction
  fallback). Tests link to requirements via `@req-<id>` / `@path-*` / `@variant-*` tags on
  the `test()` (legacy `@requirement` / `@path` comments parse too), extracted by
  `apps/web-server/src/shared/ast-extractor.ts`. `ledger.ts` joins these into per-requirement gap types
  (`covered` / `path-incomplete` / `variant-incomplete` / `untested`) and the coverage %.
  This headline is claim-based: it asks whether mapped tests claim every path
  and applicable variant cell. A test result never changes its gap type or
  `coveragePct`.
- **Depth (strictness)** — how strict each covering test is. `strength.ts` classifies every
  assertion snippet (collected by `ast-extractor.ts`) into a stack-layer tier (log → 1,
  DB/state → 2, app API/UI → 3, browser-at-real-destination → 4) by structural heuristics
  (no agent), grades the test `shallow` / `basic` / `solid` / `strong`, and surfaces a
  `suggestedStrongerCheck`.
- **Latest-run proof** — `service.ts` reads the feature's latest run outcomes
  and joins them to tests by title. `ledger.ts` then adds per-path or
  path-by-variant `proven` flags, `totals.proven`, and `provenPct`. A test that
  failed or never ran may still claim coverage, but it proves nothing in that
  run. This axis is additive; it does not rewrite the semantic coverage result.

`service.ts` is the single computation layer; `routes/coverage.ts` (REST) and the
`get_feature_coverage` MCP tool both call it, so the returned ledger cannot
diverge by surface. `list_feature_docs` reads the related doc state. An agent may
generate requirements and propose mappings; Canary Lab writes validated tags and
computes coverage, proof, gaps, and strictness.

**Internal vs external execution.** Both PRD summarization and the annotate-pass
(mapping tests → requirements) have two execution models, split by who *initiates* the
work — the project-wide rule. **Internal / server-spawned** is the **GUI's REST route**
(`POST /api/features/:name/{prd-summary/regenerate,coverage/jobs}` → `startCoverageJob`/
`regeneratePrdSummary`): canary spawns its own `claude`/`codex` CLI
(`prd-summary.ts` / `annotate-engine.ts`) and streams it through `AgentSessionView`.
**External / offloaded** is the **entire MCP surface** — there is no server-spawned MCP
tool: `start_external_summary` → `submit_external_summary` and `start_external_coverage`
→ `submit_external_coverage` (`jobs/external.ts`) spawn **no** LLM, hand the calling
client the prompt/context (`buildSummaryAuthoringContext` / `buildCoverageMappingContext`,
reusing the internal prompts), and canary writes the result through the canonical writers
(`applyExternalSummary` via the shared `assembleSummary`; `applyExternalCoverageMappings`
via the tag-writer) and recomputes. Such jobs carry `producer: 'external'`, have no
`sessionRef`, and render monitor-only (`ExternalAgentCard`) in the Generating pane. Both
models feed the *same* deterministic ledger recompute, which is producer-agnostic (it
only reads on-disk tags). The single
highest-risk invariant is **requirement-id stability across PRD regeneration** —
`reconcileRequirementIds` (in `prd-summary.ts`) preserves a surviving requirement's id
(by echoed id or exact title match) and carries dropped ones as `deprecated`, because a
renumber would silently break every inline `@requirement` annotation.

## Keep-in-Sync Invariants

The canonical table. Each row is a set of files that must change together — nothing
enforces some of these except tests and discipline, so the owning skill encodes the
procedure.

| Invariant | Files involved | Enforced by | Owning skill |
| --- | --- | --- | --- |
| MCP tool ↔ profile membership | `apps/web-server/src/mcp/tool-profiles.ts` workflow arrays and composed unions ↔ mirror arrays in `apps/web-server/src/mcp/server.smoke.test.ts` | `npx vitest run apps/web-server/src/mcp/server.smoke.test.ts` | `cl_add-mcp-tool` |
| Run-loop semantics across agent surfaces | `INSTRUCTIONS_BY_PROFILE` (`apps/web-server/src/mcp/server.ts`) ↔ result steering (`healWaitNext`, `bootSessionValue` in `mcp/heal-task-wait.ts`) ↔ the shipped run-loop skills — **enumerate them, don't assume** (`find agent-integrations -name SKILL.md`; the loop lives in `canary-lab-run/`, not the umbrella `canary-lab/`) | nothing automated — discipline only | `cl_sync-agent-surfaces` |
| Boot-session / collision / queue / claim semantics | `start_run` + `wait_for_heal_task` result shapes (`mcp/tool-groups/`) ↔ instructions ↔ the same discovered skill set | partial: tool unit tests | `cl_sync-agent-surfaces` |
| **Repair rule + honest counts on every agent surface** | `MODE_COPY` (`runs/logic/runtime/auto-heal.ts`) ↔ `REPAIR_INSTRUCTIONS` (`mcp/server.ts`) ↔ `EXTERNAL_HEAL_NEXT_STEPS` (`runs/logic/heal/external-heal-surface.ts`) ↔ every shipped `canary-lab-run/SKILL.md` — "fix app/service code, not tests, unless provably wrong"; counts from `statusLine`, never `total - failed`. **Presence in `instructions` is not delivery**: the Claude Code CLI truncates a server's `instructions` at 2048 chars, so a rule must sit inside that window OR ride a tool result (results and tool descriptions are not truncated). The pass-count rule and the test-failure repair rule ride the heal result for exactly this reason. | `mcp/repair-guardrail.test.ts` (asserts POSITION, not just presence) + `auto-heal.test.ts` | `cl_run-evidence-invariants` |
| Auto-PR on a healed green run | `shouldAutoPropose` gate (`runs/logic/pr/auto-propose.ts`) ↔ `autoProposePr` default + parse (`runs/logic/runtime/launcher/project-config.ts`) + write validator (`config/routes/project-config.ts`) ↔ `RunPrAttempt` / `proposedPrs` on the manifest (`shared/run-state.ts`) ↔ the `fix` block on the `passed` result (`healFixOutcome`, `mcp/heal-task-wait.ts`) ↔ every shipped `canary-lab-run/SKILL.md` — "the run opens the draft PR; the agent reports it and opens none of its own". The rule is **not** in `REPAIR_INSTRUCTIONS`, so it reaches skill-less clients through the tool result alone: loosen the gate and the result text has to move with it, or an agent pushes a duplicate branch onto the one the run just opened. | `pr/auto-propose.test.ts` (gate + manifest writes) + `mcp/heal-fix-outcome.test.ts` (result shape); the skill prose is discipline only | `cl_sync-agent-surfaces` |
| Read-only agent spawns keep both arms in step | the codex arm's `--sandbox read-only` ↔ the claude arm's `readOnly: true` (`buildClaudeAgenticArgs` → `--tools Read,Glob,Grep`, `agent-sessions/logic/agent-process.ts`) at all three read-only spawns: `coverage/logic/coverage/prd-summary.ts`, `coverage/logic/coverage/annotate-engine.ts`, `evaluation/logic/test-review/rewrite-agent.ts`. Headless agents must bypass permission prompts — `-p` has nobody to answer one — so the bound has to be a capability allowlist, not an approval; `--tools` and `--disallowedTools` are both evaluated ahead of the bypass. The resolver prefers claude, so an unflagged claude arm is the one that actually runs. **Still open:** the write-capable unattended spawns (flight `scout`/`docs`/`specs-coverage`, portify, benchmark sabotage) hold full filesystem and network reach for their whole window. | `agent-sessions/logic/agent-read-only-parity.test.ts` (fails when either arm drops its flag) | `cl_reuse-shared-logic` |
| Heal workspace trust ↔ the folder-trust prompt | `healWorkspaceTrustRoot` + `ensureHealWorkspaceTrusted` (`runs/logic/runtime/run-heal-agent.ts`) ↔ Claude's persistent seed (`agent-sessions/logic/agent-workspace-trust.ts`) ↔ Codex's invocation-scoped whole-map `projects={...}` override plus `--disable hooks` (`runs/logic/runtime/heal-agent-spawn.ts`) ↔ the `trust-prompt` fingerprint (`runs/logic/runtime/heal-failure-classifier.ts`) ↔ `agentCause` (`shared/run-state.ts`) ↔ `healAgentCauseSuffix` + `HEAL_CAUSE_PHRASE` (`apps/web/.../StageStatusLines.tsx`). The heal REPL is the only agent spawned on an interactive TTY, so it is the only spawn either CLI's folder-trust prompt can stop. Claude trust inherits from the project root; Codex receives the same root only for that invocation, does not mutate `config.toml`, and cannot run unreviewed hooks. `CANARY_LAB_NO_WORKSPACE_TRUST=1` disables both paths. If trust setup ever stops running, the classifier keeps the stall from reading as "the agent tried and failed". | `agent-workspace-trust.test.ts` + `heal-workspace-trust.test.ts` + Codex command tests in `auto-heal.test.ts` + the real-tail cases in `heal-failure-classifier.test.ts` | `cl_locate-agent-session-logs` |
| Flight stage hand-off (`stage_producer: "external"`) | `externalizable.ts` (`flights/logic/stages/`) ↔ the seven wired adapters (`scout.ts`, `docs.ts`, `prd-summary.ts`, `specs-coverage.ts` — which parks twice per pass: authoring, then mapping — `portify.ts` and `run.ts`, which park ONCE per engagement while the client drives the standalone workflow/heal tools (`run.ts` starts the run external-heal UNCLAIMED via the runs route's `healAgent.claimable:false` hook), and `evaluation-export.ts`, whose localized mode is the external default) ↔ `'external-work'` in `FlightCheckpointKind` (`shared/flights/types.ts`) ↔ `flightNext` steering + the oversized-payload fallback (`mcp/tool-groups/flight.ts`) ↔ the umbrella `canary-lab/SKILL.md` in all three channels ↔ `CHECKPOINT_TITLE`/`CHECKPOINT_OPTION_LABEL` (`apps/web/.../stage-meta.tsx`) | `stages.external-producer.test.ts` + `externalizable.test.ts` | `cl_sync-agent-surfaces` |
| **An externally driven flight is read-only in the web UI** | `isExternallyDriven` + `flightAwaitsUser` + `EXTERNAL_DRIVE_COPY` (`apps/web/.../flights/lib/external-work.ts`) ↔ the controls that consult them (`FlightDetail.tsx` header + Pause, `FlightControls.tsx` Continue/Abort, `CheckpointControls.tsx`, `RequirementsFork.tsx`, `FlightSummaryStrip.tsx` autopilot) ↔ `flightNeedsAttention` (`state/flight-toasts.ts`) and the slim consumers (pill, picker, `FeaturesColumn`) ↔ `stageProducer` mirrored onto `FlightIndexEntry` (`shared/flights/types.ts`, written in `flights/logic/store.ts`) ↔ the SERVER half, `rejectForeignFlightDecision` + `MCP_ORIGIN_HEADER` (`flights/routes/flight-decision-origin.ts`, wired into `flights-lifecycle.ts` and stamped by the `flightsRequest` inject in `server.ts`) ↔ `FLIGHT_INSTRUCTIONS` + the umbrella `canary-lab/SKILL.md` in all three channels. Hiding buttons is not enough: MCP drives the flight through the SAME `/api/flights/:id/*` routes the browser posts to, so only the origin header separates the driver from a bystander. The line is decisions vs unblocking — respond, pause, resume, redo and autopilot are the agent's; Abort (a dead client's escape hatch) and the dirty-repo remedy (the user's own repos) stay. Live-only: once the flight settles the record is the UI's again. | `flight-decision-origin.test.ts` + the wiring cases in `flights-control.test.ts` + `external-work.test.ts` + `FlightPage.controls.test.tsx` | `cl_sync-agent-surfaces` |
| **A stage's work is stoppable — every stage, one contract** | `StageAdapter.teardown(ctx): StageJob \| null` (REQUIRED, `flights/logic/flight-stages.ts`) ↔ the four job factories (`flights/logic/stages/stage-jobs.ts`) ↔ `interruptStage` (awaited by `pauseFlight`/`abortFlight`) ↔ `stopAgentProcesses` scopes threaded through `stages/context.ts`, `coverage/.../feature-docs.ts` + `prd-summary.ts`, `coverage/.../coverage-engine.ts` + `annotate-engine.ts`. It replaced an OPTIONAL `interrupt?` hook that was silently skipped when absent, so ten of eleven adapters opted out with no compile error — a pause stopped the flight's *waiting* while the portify agent kept editing the user's repo. Required-ness is the invariant: a new stage cannot compile without answering. Portify's stop is deliberately state-aware (a verified `ready-to-save` review survives a pause, because resume re-adopts it). | `stage-jobs.test.ts` (incl. a table asserting all 11 adapters answer) + `conductor.pause.test.ts` (awaited order, live teardown ctx) | `cl_run-evidence-invariants` |
| Stop reaches every surface, and says the same thing | `pause_flight` / `abort_flight` / `stop_flight_agent` (`mcp/tool-groups/flight.ts`) ↔ the routes the web UI calls (`flights-lifecycle.ts`, `flights-plan.ts`, `agent-sessions/routes/agent-jobs.ts`) ↔ `flightNext` steering, split by `pauseReason` so a USER pause says stand down instead of offering the resume ↔ the umbrella `canary-lab/SKILL.md` in all three channels. An external client cannot be interrupted mid-turn (tools-only server, no `sampling`, work happens BETWEEN calls), so the guarantee is "nothing lands after a stop, and the agent learns within one tool call" — never "it stops instantly". A late `submit` is refused with a typed `flight_not_parked` body, and a superseded one is caught by the `handOffId` token (`externalizable.ts` `rejectStaleSubmit`, shared by every hand-off stage). | `flight.stand-down.test.ts` + `externalizable.test.ts` (the resume→stale-submit race) + `server.smoke.test.ts` mirrors | `cl_sync-agent-surfaces` |
| Spawned agents leave a durable record | `agent-jobs` store (`agent-sessions/logic/agent-jobs/`) ↔ the record written by the RUNNER itself (`runAgentProcess`, one lifecycle for every agent feature) ↔ boot reconcile in `server.ts` (`running` → `orphaned`, an honest tombstone: an in-process child cannot be re-attached, but its `sessionId` keeps the transcript readable) ↔ the feature-rename fan-out (`config/index.ts`) ↔ flight delete (`flight-queue.ts`) + the R78 restart wipe (`flight-stages.ts`, alongside the sidecar dir) ↔ `agentJob` on the MCP flight view. The standalone coverage job deliberately passes NO descriptor — its own manifest is already the durable, reconciled, surfaced record. | `agent-jobs/store.test.ts` + the record-lifecycle cases in `agent-process.test.ts` + `routes/agent-jobs.test.ts` | `cl_async-task-ux` |
| Heal-claim policy | `apps/web-server/src/features/runs/logic/heal/heal-claim-policy.ts` ↔ `broker.claim()` backstop ↔ `start_run`/`POST /api/runs` suppression ↔ skill prose | policy + broker unit tests | `cl_sync-agent-surfaces` |
| Templates ↔ shipped package | `templates/project/**` ↔ `dist/templates/` copy (`tools/prepare-assets.mjs`) ↔ consumer `canary-lab upgrade` | `npm run smoke:pack` | `cl_add-sample-feature` |
| Coverage ledger single computation layer | `apps/web-server/src/features/coverage/logic/coverage/service.ts` joins requirements + tags + `run-outcomes.ts` ↔ `ledger.ts` computes claim and proof axes ↔ `routes/coverage.ts` and `get_feature_coverage` return that result without recomputing it | service, ledger, route, and MCP tests | `cl_run-evidence-invariants` |
| Requirement-id stability | `reconcileRequirementIds` (`apps/web-server/src/features/coverage/logic/coverage/prd-summary.ts`) ↔ inline `@requirement` annotations (`ast-extractor.ts`) — regen must preserve surviving ids | `prd-summary.test.ts` before/after fixture | — |
| Contributor docs single-source | `CLAUDE.md` (commands + rules) ↔ generated `AGENTS.md` ↔ `docs/ARCHITECTURE.md` (mechanisms) ↔ `docs/PRD.md` (intent) ↔ `docs/GUIDE.md` / `docs/FEATURES.md` (user-facing operation) ↔ the skill index in `CLAUDE.md` | contributor-doc audit in `cl_verify-changes` | `cl_verify-changes` |
| **Web↔server wire contract** | Server response types ↔ hand-written mirrors in `apps/web/src/shared/api/**` ↔ the `WorkspaceEvent` union on both sides. The web app cannot import server code, so this contract needs a dedicated comparison gate. | `npm run check:wire` (`tools/check-wire-contracts.mjs`) | — |
| **Checkpoint option vocabulary** | `CHECKPOINT_OPTIONS` (`shared/flights/types.ts`) ↔ checkpoint emitters under `flights/logic/stages/` ↔ `respond_flight_checkpoint` ↔ `CHECKPOINT_TITLE`/`CHECKPOINT_OPTION_LABEL` (`apps/web/.../stage-meta.tsx`). Option keys are wire values. `prd-source` may offer a subset. `external-work` is the one kind with NO option labels and an explicit exemption in the test: it only ever parks an externally driven flight, which is read-only in the web UI, so its `submit`/`run-internally` answers are never rendered as buttons — labels for buttons nobody can press are labels that rot. | `stage-meta.checkpoints.test.ts` (every kind titled, every RENDERED option labelled, fallback intact) + `satisfies Record<FlightCheckpointKind, …>` | `cl_sync-agent-surfaces` |
| **Import-cycle ceiling** | `tools/check-import-cycles.mjs` records ceilings for cycle count and largest cycle across `apps/**` and `shared/**`. Lower a ceiling when refactoring removes cycles; review any increase instead of accepting it silently. | `npm run check:cycles` | — |
