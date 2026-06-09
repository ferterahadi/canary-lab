# Canary Lab - Internal Notes

## Current Package Model

- Publish one CLI: `canary-lab`
- Main subcommands: `init`, `setup`, `ui`, `mcp`, `new feature`, `env`, `upgrade`
- Package internals ship as compiled code in `dist/`
- Scaffold templates live in `templates/project/` and are copied into `dist/templates/` during build

## Repository Workflow

- Build with `npm run build`
- Smoke-test the tarball with `npm run smoke:pack`
- Publish with `npm run publish:package`
- Run tests with `npx vitest run` (vitest; tests co-located as `*.test.ts`, component tests use happy-dom)
- Typecheck with `npx tsc -p tsconfig.build.json --noEmit`

## Feature Notes

- Repo sample features now use `feature.config.cjs` and JS-based Playwright/test files
- Generated features import package helpers from `canary-lab/feature-support/...`
- The scaffold includes `example_todo_api` and `broken_todo_api`

## Logging & Retention

Logs live under `<workspace>/logs/`:

- **Per-run artifacts** — `logs/runs/<runId>/` holds `runner.log` (orchestrator narration), `svc-<name>.log` (each booted service's PTY output, captured programmatically — never echoed to the server's stdout), `playwright.log`, `external-commands.jsonl`, etc. Retention is count-based: keep the most recent `CANARY_LAB_RUN_RETENTION` runs (default 20) via `pruneRuns` (`lib/runtime/retention.ts`), called on `createServer` bootstrap and on every RunStore `finalized` event (`server.ts`). Status-agnostic + lexicographic by runId; concurrency caps keep active runs well under the limit.

## Testing Against a Remote URL

To run a feature's tests against a deployed environment without booting the local server:

1. Add the env to `feature.config.cjs` → `envs: ['local', 'production']`.
2. Gate each `startCommand` (or whole `repo`) with `envs: ['local']` so it only boots locally.
3. Add a matching envset under `envsets/<env>/<feature>.env` with the remote target — e.g. `GATEWAY_URL=https://api.example.com`. Tests read this via `process.env.GATEWAY_URL` (see `e2e/helpers/api.ts`).
4. Pick the env at the runner prompt (`canary-lab run`) or from the env dropdown in the web UI (`canary-lab ui`). Both flows apply/revert the envset and skip booting filtered services.

## Concurrent Runs (1.2.0)

Multiple runs can be active at once. The top-right **Runs** dialog in `canary-lab ui` lists every run (running/healing/queued/finished) and navigates to any of them.

- **Per-run ports**: a `startCommand` declares `ports: [{ name: 'api', env: 'PORT' }]` (env optional). The orchestrator allocates a free TCP port per slot per run, injects it as the service's `env` var (`PORT`), exposes it to config via the reserved token `${port.api}`, and to the Playwright process as `CANARY_PORT_<slot>`. `${port.<slot>}` resolves in three places: the **command** (`--port ${port.api}`), the **`healthCheck`** URL, and — at apply-time — inside **applied envset files** (`.env`/`.properties`/`.env.local`) via `applySet`'s resolver (`resolvePortTokens`, `interpolate.ts`). So inter-service URLs and config-file listen ports (e.g. Spring `server.port=${port.mpass}`, `oddle.oms.url=http://localhost:${port.oms}`) follow the run's allocation. Test helpers resolve the target as `CANARY_PORT_api → GATEWAY_URL → hardcoded default` (see any sample `e2e/helpers/api.ts`). Allocation lives in `lib/runtime/port-allocator.ts`; the `port` token namespace in `lib/runtime/launcher/interpolate.ts`. The CLI `env` switching path passes no resolver, so it stays a verbatim copy.
- **Same-repo collision**: the heal loop edits repo code in place, so two runs on the *same* repo would corrupt each other. Starting a second run on an active repo returns `repo_collision_requires_choice` (REST 409 / MCP result). The user chooses **worktree** (isolate the run in a per-run `git worktree` under `<runDir>/worktrees/` and run now) or **queue** (wait until the conflicting run finishes). Different-repo runs never collide. See `lib/runtime/repo-collision.ts` + `lib/runtime/repo-worktree.ts`.
- **Admission + queue**: runs beyond a CPU/free-RAM heuristic are parked as `queued` (status `queued`, with `manifest.queueReason`) and promoted FIFO on run-end. Optional hard ceiling via env `CANARY_MAX_CONCURRENT_RUNS`. The scheduler is `lib/runtime/run-scheduler.ts` (decision logic in `lib/runtime/admission.ts`); it's wired into the `startRun` factory in `server.ts` and promotes on the RunStore `finalized` event.
- **MCP**: `start_run` gains an `isolation: 'worktree'|'queue'` input and surfaces `repo_collision_requires_choice` / `queued` results; the `active_heal_blocks_start` hard block was relaxed (a healing run is continued by default; `force_new`/`run_ref` start a concurrent run). Keep the `repair`-profile instructions (`mcp/server.ts`) and all three `SKILL.md` run loops in sync.
- **Multi-service limits** (what concurrency can't auto-fix): worktree isolation covers concurrent heal *edits*, not *ports* — two runs of the same multi-service app still can't both boot, so they queue. Apps that hardcode a port in source (ignoring `PORT`/`--port`/config) can't be relocated. OAuth issuer + redirect URIs are pre-registered with the provider for a fixed host:port, so OAuth features (e.g. `mpass_oauth`) run one at a time regardless of any rewiring. The `${port}` envset resolver unlocks *different* multi-service features running concurrently (each gets distinct ports) and cleaner single multi-service runs — not same-app concurrent isolation.

## External AI Clients (MCP)

- MCP HTTP server mounts at `localhost:<port>/mcp` (streamable HTTP) inside `canary-lab ui`. Health: `GET /mcp/health?profile=<p>`. The port is configured in `canary-lab.config.json` (`port` field) in the workspace directory — read it dynamically rather than assuming a fixed value (default is 7421 if unset).
- **Profiles** pick the tool subset via `?profile=`: `repair` (heal loop, default), `verify` (verification configs), `author` (feature/envset/draft/eval authoring), `full` (union). Optional `?client_kind=claude-desktop|codex-cli|...`.
- Tools live in `apps/web-server/mcp/tools.ts` — thin wrappers over existing REST routes/helpers. `start_run`/`write_envset`/etc. reuse handlers via `app.inject()`; don't duplicate orchestrator logic. Author-profile tools call `lib/feature-authoring.ts` directly.
- **Feature docs convention**: feature-scoped prose (distilled sessions, plans, notes) lives at `features/<name>/docs/<slug>.md`. The `write_feature_doc` MCP tool (author/full profiles) is the only sanctioned writer — create-or-replace, markdown only, path-traversal hardened. The draft-apply path rejects non-spec files, so docs do NOT go through it.
- Profile membership = the `REPAIR_TOOLS`/`VERIFY_TOOLS`/`AUTHOR_TOOLS` arrays. `FULL_TOOLS` auto-dedupes their union + `FULL_ONLY_TOOLS`. Adding/moving a tool also requires updating the mirror arrays in `mcp/server.smoke.test.ts`.
- Each MCP session gets its own transport (`mcp/server.ts`) — a singleton rejects the 2nd client with `-32600 Server already initialized`.
- Destructive tools gate on `confirm: z.literal(true)` in their input schema (e.g. `abort_run`, `write_envset`).
- **External heal**: when `manifest.healMode === 'external'` the orchestrator parks at `waiting-for-signal` and the client drives `claim_heal` → `get_heal_context` → edit code → `signal_run`. `ExternalHealBroker` (`lib/external-heal-broker.ts`) owns the single-claim lock + 15s heartbeat staleness. Per-command audit log at `<runDir>/external-commands.jsonl`.
- **Heal-claim policy (desktop-only)**: only **Desktop** client kinds (`claude-desktop`, `codex-desktop`) may *own* a heal claim. CLI clients (`claude-cli`, `codex-cli`) — and undetected `other` — can run/verify but never claim, so a stray CLI session can't silently grab a run and edit repo code. It's an **allowlist** (`lib/heal-claim-policy.ts`, `isHealClaimAllowed`), so detection failures (`other`) fail safe. Override via `CANARY_LAB_HEAL_CLAIM_CLIENTS` (comma-separated kinds). Enforced at two layers: a hard backstop in `broker.claim()` (covers `claim_heal`, REST `/claim`, reclaim helper → returns `client-kind-not-allowed`) and the `start_run` handler / `POST /api/runs` (which build the session bypassing the broker → return `claimSuppressed: true` and omit the heal-wait next-step instead of claiming). Client kind is heuristically detected from process lineage in `scripts/mcp.ts` (`inferMcpClientKind`).
- **Steering skill-less clients**: external clients act on the `initialize` instructions + tool *results*, not the Canary Lab skill. The server sends profile-aware `instructions` (`INSTRUCTIONS_BY_PROFILE`, `mcp/server.ts`); `repair` carries the External Run Loop. `start_run`/`signal_run` results add `nextSteps: ['wait_for_heal_task']` (`healWaitNext`, `mcp/tools.ts`) so a result-driven agent blocks on `wait_for_heal_task` instead of polling `get_run_snapshot`. Following or waiting on a **boot-only run** (`executionType: 'boot'`, started via `boot_services`) instead returns `type: 'boot_session'` (`bootSessionValue`/`isActiveBootRun`, `mcp/tools.ts`) from `start_run` and `wait_for_heal_task` — no heal claim, no `healWaitNext`, and `wait_for_heal_task` returns immediately rather than dead-waiting until timeout. Keep both in sync with the skill's run loop.
- Handoff (`handoff_heal`): active runs can only hand off to `manual` (orchestrator can't add a local autoHeal mid-flight); `auto`/`claude`/`codex` require a failed/aborted run.
- End-to-end smoke for the heal loop: `tools/verify-external-heal.sh` (auto-picks a failing feature, runs the 7-step REST loop; `KEEP_RUN=1`, `FEATURE=`, `WAIT_FOR_HEALING_SECONDS=` overrides).
