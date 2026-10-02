# Standalone repair study

This contributor script compares a prepared three-service storefront repaired through Canary with the same application repaired through ordinary shell commands and Playwright. It does not change the Benchmark product feature. The demo is a controlled sample, not evidence of general superiority or onboarding value.

Published results, with their method and limits, are in [docs/BENCHMARK.md](../../docs/BENCHMARK.md).

## Run

Use an explicit `demo-project` directory created by `npm run demo`. Preparation copies its application, suite, and installed dependencies; it never repairs the interactive demo. The selected output parent must exist, and the output directory must not already exist or overlap the source checkout or demo workspace.

```sh
npm run benchmark:study -- prepare \
  --workspace '/absolute/path/to/demo-project' \
  --out '/absolute/path/to/new-study' \
  --codex-model '<exact-model-id>' --codex-effort medium \
  --claude-model '<exact-model-id>' --claude-effort high \
  --mode live --repetitions 10 --seed 42

npm run benchmark:study -- run --study '/absolute/path/to/new-study'
npm run benchmark:study -- run --study '/absolute/path/to/new-study' --resume
npm run benchmark:study -- report --study '/absolute/path/to/new-study'
```

For live studies, models and reasoning effort are required inputs. Avoid moving aliases such as `opus`; choose an explicit model identifier. Both CLIs must be installed. Preparation freezes their absolute executable paths, versions and the dependency/source fingerprints; execution refuses changed inputs. Every version check, sandbox probe, plain spawn and Canary heal spawn uses that frozen executable, regardless of PATH order. The worker clears `CANARY_LAB_HEAL_MODEL` so an interactive demo override cannot alter the experiment.

Both workflows use shell tools and the installed Playwright CLI. The optional browser MCP server and inherited connectors are disabled: Canary normally fetches that server at `@latest`, which would introduce an unfrozen dependency. The standard Canary heal template is retained with its unavailable browser-tool hint omitted. This API-only study does not measure the optional browser MCP integration.

Preparation inventories Codex MCP servers and freezes explicit per-server disable flags, with apps, plugins, memory and hooks disabled. An empty MCP configuration table is insufficient because Codex merges it with saved settings. Execution checks the effective inventory before each Codex attempt and refuses any enabled connector. Canary agent terminal output is retained in `agent-terminal.log`, including startup failures before a native session exists.

Real-agent execution currently requires macOS and each CLI's native sandbox. Codex uses a named permission profile and Claude uses invocation-local sandbox settings; nesting an outer `sandbox-exec` around either CLI prevents their own command sandboxes from starting. The policies deny access to reference/other-attempt contents and Canary source, and keep frozen inputs and shared dependencies unwritable. Codex's native sandbox is probed before each attempt for own-file access and denial of the study manifest (plus the Canary package for plain attempts). Claude uses strict sandbox settings with no unsandboxed fallback. Authentication and session logs use the CLI's existing configuration home.

New live campaigns default to 80 attempts: two fixed scenarios, two workflows, ten repetitions, and both agents. `--repetitions` accepts 2–100; `--seed` is a uint32 (default 1). The seed freezes a shuffled list of adjacent Canary/plain pairs, with balanced first-workflow order within each agent/scenario (within one for odd repetition counts). Reports retain the exact schedule. Older manifests retain their original 16-attempt alternating schedule. Before repair attempts, a native sandbox preflight exercises the exact generated runbook commands in both CLIs, starts all three services, runs all seven plain journeys, and checks private-file denial. Each pinned agent makes one short tool call, also checking model availability; its transcript and usage are retained as preparation evidence. A failed preflight prevents the repair campaign from starting.

Claude also runs a bounded interactive preflight through Canary's actual PTY launcher from a nested run directory. It must read local JSON through Python without approval while private reads and permission-file writes remain denied. The study disables `blockReadsOutsideWorkingDirectories` for this invocation because that static classifier can reject computed local paths before the OS sandbox runs; explicit private-path rules and the native sandbox remain enabled. This does not change global Claude settings or bypass sandbox enforcement.

Both workflows start services with the same absolute Node executable and installed TypeScript loader. The tsx CLI's optional IPC socket is unnecessary for these services and is blocked by Claude's sandbox. Child PATH values omit the inaccessible source checkout, including npm's injected bin directory. The runbook contains these executable commands without diagnosis hints.

Each attempt gets 15 minutes; preparation and independent verification are separate. Attempts run sequentially in their frozen randomized order on the same machine. Keep machine load and connection consistent throughout a campaign; randomization reduces timing bias but does not remove provider or network variation. Ctrl-C stops the current attempt. Resume preserves interrupted receipts and continues unattempted work; it never replaces a failed result. Cleanup also checks allocated listeners whose working directories establish attempt ownership, because CLI background jobs can leave their parent's process group. It preserves unrelated port owners and records the ownership check.

To repeat one comparison, add `--agent claude --scenario cross-service` to **prepare** with a new output directory. This creates twice the selected repetition count in attempts, preserves balanced randomized pairs, and runs the native preflight only for the selected agent. Add `--repetitions 2` for a four-attempt pilot. Both model pins remain required for manifest compatibility. The original campaign and its failures stay untouched; report the follow-up separately rather than replacing an earlier result.

## Evidence and limitations

Preparation verifies seven declared journeys on the repaired reference and both broken scenarios through both suite entrypoints. The plain suite differs only in its fixture import and resolved standard Playwright configuration. Independent evaluation reruns the original suite from fresh application state and tests additional names, quantities, and prices. Test/helper/configuration edits invalidate an attempt even if its agent claims success.

`study.json` records the protocol and results. `attempts/` retains working directories and transcripts; `receipts/` retains result records and patches; `evaluation/` contains independent verifier results. `report.json`, `report.md`, and `report.html` regenerate without running agents. Nothing is automatically pruned.

Finished study outputs, their per-campaign launch and stop notes, and handoffs stay in the selected Canary workspace under `benchmark-evidence/`; the notes are in `benchmark-evidence/study-notes/`. This checkout keeps only the result write-ups in `docs/`, which cite that evidence as `<workspace>/benchmark-evidence/…`.

Reports separate agents and scenarios. Paired time reductions require two verified successful repairs. All failures remain visible. Reports include all-attempt elapsed/token totals and a paired time reduction among verified successful pairs. With at least five successful pairs per agent/scenario they report a deterministic 95% percentile bootstrap interval (5,000 whole-pair resamples); otherwise the interval is unavailable. Failed and pending pairs are excluded from that estimate and its denominator is shown. The interval is exploratory and conditional on success, not a guarantee of generalization. The 20% improvement target is not statistical significance. Human intervention is zero for unattended runs; interrupted attempts remain labelled. Do not edit an active attempt manually.

Usage is derived from native parent and delegated-session evidence: Claude message IDs are deduplicated across logs, while each Codex session contributes its final cumulative usage. Session files and an index are retained under each attempt's `sessions/` directory. If observed delegation lacks corresponding session evidence, usage stays unknown. Delegated diagnosis is permitted in both workflows under the same pinned model and effort; Canary's normal prompt actively requests it. Cache fields stay separate because provider accounting differs. Missing usage is unknown, never zero. A silent observer counts plain Playwright launches using the supplied configuration; overriding reporters can make that count incomplete. Canary counts its observed Playwright launches. Dollar cost is unmeasured. Raw transcripts are retained for inspection; the script does not invent explanations for why one workflow wins.

Codex's native approval-review sessions are identified by their session metadata and retained separately from repair sessions. Their platform model is not a repair-model override; available usage is included in the total with a breakdown in `usage-breakdown.json`. An explicitly rejected diagnosis-agent launch does not imply a missing child session. Missing or ambiguous successful-launch evidence still makes usage unknown.

Preparation needs disk space for an independent copy of the installed dependencies. It records preparation time separately from repair time. The script leaves the existing Benchmark UI, routes, and manifest contract untouched. Product polish and independent-repository validation are subsequent work.

## Local overhead replay

Prepare a **separate** campaign for a fixed action sequence with no cloud model, authentication, model pins, or CLI version probes:

```sh
npm run benchmark:study -- prepare \
  --workspace '/absolute/path/to/demo-project' \
  --out '/absolute/path/to/new-replay-study' \
  --mode replay --repetitions 10 --seed 42
npm run benchmark:study -- run --study '/absolute/path/to/new-replay-study'
```

Replay defaults to 40 attempts: two scenarios, two workflows, ten repetitions, and one scripted actor. The manifest uses one existing agent slot for attempt identity; reports label it `scripted`, never a Codex/Claude repair result. `--agent` with `--scenario` selects one scenario using that structural slot. It does not invoke that agent.

Both arms run the failing suite, apply the identical known application patch frozen during preparation, restart services, and verify the repair. Canary retains its normal targeted reruns; plain reruns the suite. The independent evaluator runs all seven journeys plus extra checks in both cases. Canary uses its actual orchestrator, artifact generation and heal launcher; plain uses a deterministic shell/Node script and standard Playwright. The existing independent evaluator and protected-file integrity checks still decide success. Scripted processes allow only loopback outbound networking; dependencies are already installed. macOS sandbox support remains required.

This measures the elapsed cost of a fixed workflow, including service startup/restart, local tests, artifact processing and a small scripted process. It does not reproduce real agent reasoning, measure intelligence, or produce a network-free live-agent score. It still varies with CPU, disk and local scheduling. Model tokens are zero by construction. Keep replay and live reports separate; never subtract replay time from live time as a causal estimate.

## Live request measurements

Each repair worker starts an attempt-scoped loopback OpenTelemetry HTTP/JSON receiver and configures its CLI to export there. Only numeric measurements, event kinds and timestamps are retained in `telemetry-events.jsonl`; prompts, commands, account identifiers and response bodies are discarded. No cloud proxy or global CLI configuration is installed. Configuration follows the [Codex observability documentation](https://developers.openai.com/codex/config-advanced/) and [Claude monitoring documentation](https://code.claude.com/docs/en/monitoring-usage).

`telemetry-summary.json` and reports expose observed request events, request errors, retry-marked events, and separate request, stream and tool duration sums. Retransmitted timestamped records are deduplicated. Missing duration fields or absent exporters produce unknown values, never zero. Rejected batches are reported. Export delivery can be incomplete, especially on interruption or if managed settings override export configuration; an observed status does not certify full coverage. Native session evidence remains the source of token totals, including delegated and approval-review usage where available.

Request time includes network transport, provider queuing and model computation. Codex request durations may cover connection/headers, with stream events measured separately. Concurrent child requests and parent tool calls can overlap, so duration sums are not exclusive wall-clock buckets and must not be subtracted from elapsed repair time. Retry-marked events are observations, not a count of every retry. Provider event semantics differ; compare the two workflows within an agent, not across providers.

Total tokens include input/output and cached traffic: Claude cache reads/writes are added to its input/output fields; Codex cached input is already included in input. Keep the cache columns when estimating costs; this script does not calculate dollars. Optional artificial-latency experiments are not included: adding a proxy would change the transport and requires a separate protocol.

## Validate without paid agents

```sh
npx vitest run tools/benchmark-study
npx tsc -p tools/benchmark-study/tsconfig.json --noEmit
```

Integration tests use shipped repository fixtures, local service ports, and scripted repair subprocesses. They do not read a contributor's live workspace or invoke paid coding agents. A source build must exist for the published fixture export used in the integration tests.

## Experimental diagnosis policies

The production policy remains `per-failure`. Experimental runs record their policy in the run manifest and use the same prompt loader, runner verification and MCP recovery paths. `parent-only` asks the parent to diagnose every failure. `adaptive` asks the parent to read the index, group evidence-supported causes, and delegate distinct unresolved investigations to at most two concurrent children initially. Both preserve one editing/signalling owner, a complete failure-ID ledger, read-only children, and explicit escalation after contradictory evidence or failed verification. An explicit run policy takes precedence over the default in shipped skills. Existing runs keep their recorded policy on resume.

Prepare a separate screening campaign after reviewing its source, destinations, pins and exposure:

```sh
npm run benchmark:study -- prepare \
  --workspace '/absolute/path/to/demo-project' \
  --out '/absolute/path/to/new-screening-study' \
  --codex-model '<exact-model-id>' --codex-effort high \
  --claude-model '<exact-model-id>' --claude-effort high \
  --agent codex --repetitions 5 --seed 29 \
  --diagnosis-policies per-failure,parent-only,adaptive \
  --max-tokens 35000000
```

This prepares 30 attempts: two scenarios × five adjacent serial blocks × three Canary variants. `--agent` alone selects both scenarios; `--scenario` still narrows it. Arm IDs are explicit in receipts; variant results never masquerade as plain/Canary pairs. The seeded schedule balances every arm's position within one observation. Existing pair schedules and historical manifests retain their meaning.

Preparation freezes a configuration digest covering schedule, policies, source/dependency fingerprints, model/effort/CLI pins, tool restrictions, deadline and token dispatch ceiling. It also hashes each composed prompt template. Each actual cycle retains its rendered prompt, bytes and hash under `attempts/<id>/prompts/`. The worker records monotonic stage boundaries and non-overlapping intervals, while the controller records dispatch → independent evaluator completion separately from historical repair time. Agent request durations and child spans can overlap; never add them to exclusive elapsed stages. Parent waiting time and semantic adherence remain unknown unless independently reviewed.

Native attribution records primary repair sessions, diagnosis children, approval reviewers and unknown sessions in `usage-breakdown.json`. Parentage comes from native metadata or Claude launch metadata, never directory order. Session copies and Claude message IDs are deduplicated. Missing required usage or ambiguous parentage makes the aggregate unknown. Policy adherence reports the assigned policy, observed children and required transcript review; counts alone never certify grouping, read-only behavior or justified escalation. All assigned outcomes stay in reports. Intervals resample complete successful multi-arm blocks separately by agent/scenario; unsuccessful blocks remain in totals.

## Unfamiliar-repository diagnosis context

Repository campaign preparation freezes a `heal-index.md`, stable failure IDs, one diagnostic JSON slice and one read-only child handoff per failure, and an initial parent-owned `diagnosis-ledger.json`. Both diagnosis policies receive the same generated inputs. The index reuses Canary's existing renderer; slices contain only the already released diagnostic excerpts, with no protected oracle or held-out patch content. Application source remains available for investigation rather than being labelled with a known repair location.

The repository-specific repair prompt requires Codex diagnosis children to use `fork_turns: "none"` with the frozen model and effort, passing only the assigned handoff. The child handoff forbids edits, check submissions, other failure packets and further delegation. The parent retains serial edits and check submission, and records evidence, unresolved failures, children and any escalation in its ledger. Parent-only still requires parent diagnosis and explicit justification before escalation. Production diagnosis guidance is unchanged.

`child-context-review.json` records native Codex spawn settings. A known fork or child-pin violation stops later repository dispatch, including resume, while preserving a successful independent repair verdict and all native usage. This structural check does not certify semantic assignment coverage, read-only behavior or escalation justification: the first attempt, first pair and final evidence still require transcript/ledger review. Generated indexes and failure packets are protected against edits; the parent ledger is mutable. A new prompt/context fingerprint needs a newly frozen campaign and separate live approval; never rerun a prior attempt under changed inputs.

For variant campaigns, any unsuccessful attempt stops further dispatch. Unknown usage or reaching `--max-tokens` also stops dispatch; successful native runtime preflight usage counts toward this threshold. **This is a dispatch ceiling, not a hard billing/token cap:** an in-flight attempt or preflight can overshoot it, and the CLI does not stream a reliable account-wide spend limit. Select and approve that exposure before running. A failed campaign cannot be resumed past the failure; investigate and prepare a newly fingerprinted campaign. No default policy is promoted automatically.

Audit saved campaigns without models or modifying historical receipts:

```sh
npm run benchmark:study -- audit \
  --study '/absolute/path/to/historical-study' \
  --out '/absolute/path/to/new-audit'
```

The audit copies captured native logs into its output, reconciles receipt totals, and lists every included/missing session. Raw logs remain workspace artifacts; repository tests use synthetic fixtures. Missing historical stage boundaries are not reconstructed from request-duration sums. The later child-context, effort and direct-launch experiments remain outside this implementation.

Repository Codex campaigns now use a private native tool-input audit. A fresh, isolated Codex home references the existing ChatGPT auth file without copying credentials; only the vetted capture hook is enabled there. Protected Pre/PostToolUse receipts retain actual spawn and follow-up messages, compare each launch to one frozen failure handoff (exact or trailing-whitespace-only), and stop later dispatch when capture or comparison fails. Hooks do not certify read-only conduct or follow-up semantics; review retained tool calls and plaintext messages at each checkpoint. The ordinary benchmark tool policy still disables inherited hooks. Worker usage recovery preserves specific context violations rather than replacing them with a session-count assessment.

Native Codex V2 marks collaboration messages encrypted in its tool schema, so protected hooks cannot certify their plaintext contents. Audited repository campaigns therefore freeze the native local V1 delegation backend for both arms. A custom native catalog retains the pinned model's full original metadata, changes only `multi_agent_version` to `v1`, and preserves the actual model/effort pins. Explicit `fork_context:false` replaces V2's `fork_turns:"none"`; exact task and follow-up inputs are retained by native hooks. Original and selected catalog bytes are sealed, and source catalog metadata drift stops dispatch. Results from this changed backend are not pooled with V2 attempts. Live payload and read-only behavior still require checkpoint review.
