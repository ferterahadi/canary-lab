# Canary Lab Product Requirements

> **Status:** reverse-engineered from the README, changelog, user guide, and
> current codebase (product scope through 2.1.0). This is the product-intent reference
> for contributors and agents. Update it with every behavior change.

## Positioning

Canary Lab coordinates Playwright and an AI agent; it replaces neither.
Playwright executes tests, agents propose or implement changes, and Canary Lab
owns service startup, run state, requirement accounting, captured evidence,
verdicts, and evaluation rendering.

The product loop is: implement, verify through Flight or an existing suite,
then review the evaluation. The evaluation is the human-facing proof.

## Problem

An agent can misread counts, declare a false pass, or weaken a test instead of
fixing the application. Canary Lab keeps the verdict outside the agent's
control: the harness runs the tests, Playwright supplies outcomes, tags define
coverage claims, and repairs target application or service code unless a test
is provably wrong.

The evidence chain is **requirement claim → test execution → observed result**.
Claimed coverage says a mapped test exists for every required path and variant;
proven coverage says those mapped tests passed in a specific run. A human can
review both, and the same evidence guides the next repair attempt.

Failed tests normally scatter context across terminals and artifacts. Canary Lab
keeps one run's results, logs, screenshots, traces, videos, services, applied
environment, repair notes, and fixes under one run ID. The agent receives this
evidence, fixes the app, and continues the same run.

Reading what a test actually does should not require mentally executing
Playwright JavaScript. Canary Lab derives a plain-English tree from the parsed
test source and shows it by default in the Test and Coverage ledgers. The tree
retains control flow and exact source ranges; syntax that cannot be described
safely stays visible as source instead of receiving a guessed meaning.

## Users

1. **App engineer** — runs existing suites from the UI or drives Flight from the CLI, reviews history, switches envsets, and sometimes repairs by hand.
2. **AI repair agent** — connects over MCP, claims runs, reads evidence, edits app code, and signals rerun or restart. Tool results and `initialize` instructions guide agents that never read the docs.
3. **Evaluation author** — exports any terminal run. Canary Lab renders and stores the archive; wording comes from evidence (`raw`), a local agent (`localized`), or an external MCP client.

## Capabilities by area

These areas broadly match changelog tags. Flight, coverage, and verification are
cross-cutting.

### [Flight]

- The front door: `canary-lab flight <repo…> "<what to test>"` or `start_flight` takes a bare repo from setup through evaluation export. Failed runs can export with their real verdict.
- **The server owns stage transitions and the harness computes every verdict.**
  An internal agent or external MCP client may produce candidate configs, docs,
  tests, mappings, repairs, and localized wording. A stage passes only after
  Canary Lab validates the resulting artifact: the config parses and boots, the
  ledger reaches its computed state, Playwright supplies the run verdict, or the
  archive exists.
- An MCP-started Flight can set `stage_producer: "external"` to hand its
  judgment-heavy stages to the connected client through `external-work`
  checkpoints. Mechanical stages and all validation remain server-owned.
- A user can take an external step back without creating two writers: Canary
  records a takeover request, rejects later external submits, and starts its
  local agent only after the client releases the step. A confirmed force path
  exists when that client is no longer reachable.
- A resumable background job with typed checkpoints. Autopilot handles routine choices but stops for existing suites, missing secrets, and failed automatic answers.
- **One flight record per suite.** Plain resume and stage re-entry keep repos
  and intent frozen. Only a full redo may replace them, after wiping the prior
  pipeline artifacts.
- CLI, web UI, and MCP use one store.

### [Test Runner]

- Run Playwright with booted, health-checked, PTY-captured services; retain artifacts under `logs/runs/<runId>/`.
- Repair through a local `claude`/`codex` agent or an MCP client that claims, fixes, and signals `rerun` or `restart`; continue until pass or terminal failure.
- Concurrent runs use resource admission, optional injected ports, and Git
  worktrees. Worktrees isolate file edits; only injected ports isolate network
  listeners. Queueing remains the safe choice for an un-portified same-app run.
- Regular runs attempt per-repository worktree isolation, hydrate work in
  progress, and save captured repair edits under `logs/runs/<runId>/fixes/`.
  A non-portified repository may fall back to running in place if worktree
  creation fails; that warning means checkout isolation and automatic fix
  capture are not guaranteed. Portified runs fail instead of falling back.
- A green captured repair can update a suite branch and open a draft pull
  request; opt out with `autoProposePr`.
- Boot-only sessions start services without tests.
- Envsets switch between environments without hand-editing `.env`.
- Tests open as deterministic plain-English actions, checks, authored steps,
  branches, and loops. Code remains one click away, and selecting an English
  node reveals the exact source range.
- Readable Tests are generated from the current source during test extraction.
  They do not call an LLM, persist a second translation file, or attach runner
  status to static child steps.

### [Test Generation]

- Suite scaffolding through `create_feature` or Flight, using `feature.config.cjs`, envsets, and specs that import `canary-lab/feature-support/log-marker-fixture`.
- External drafts let MCP clients author specs while Canary Lab tracks stages and validates on apply.
- Env capture from a source repo with secret redaction.
- Portify rewrites services to accept injected ports, verifies them with a concurrent double boot, and stores an overlay applied per run and reversed at teardown. The product repo stays unchanged.

### [Requirement coverage]

- Canary Lab turns `docs/` into requirements with stable IDs, then maps tagged
  tests to them. The headline semantic coverage is claim-based: tags determine
  covered ÷ active requirements, including every required path and applicable
  variant cell.
- The latest run adds a separate proven axis. A requirement may stay claimed as
  covered while remaining unproven because its mapped test failed or did not run.
- Gap types are `covered`, `path-incomplete`, `variant-incomplete`, and `untested`. A strictness grade measures assertion depth from app log to browser and suggests stronger checks.
- The UI and MCP tool `get_feature_coverage` share one computation.

### [Verification]

- Run tests against a **deployed** environment with `execute_verification`, target URLs, and a Playwright envset. Verification never boots local services or heals; configs are reusable and scoped to the `verify` MCP profile.

### [Export evaluation]

- Export any terminal run as `evaluation.html`. Failed or aborted runs preserve their status.
- **Raw** uses run evidence; **localized** asks a local agent to improve per-test wording. External MCP clients supply their own wording. Tests and verdicts stay the same.

### [General]

- One published CLI (`flight`, `init`, `setup`, `ui`, `mcp`, `new feature`, `env`,
  `boot`, `upgrade`), a local web UI, and an MCP server sharing one port.
- Profile-scoped MCP surface with seven workflow profiles (`repair`, `verify`, `author`, `coverage`, `export`, `flight`, and `portify`), two composed direct-tool profiles (`lifecycle` and `full`), and the default `compact` profile. `compact` exposes one `exec` tool that dispatches the same 63 atomic handlers by exact command name; bare and setup-installed connections both use it, while `lifecycle` and `full` remain opt-in direct-tool rollback surfaces.

## Non-goals

- **Not a CI runner or hosted dashboard.** Evidence and repair stay on the
  engineer's machine.
- **Not a test framework.** Playwright owns the language, assertions, and browser runner; Canary Lab owns the surrounding context.
- **No self-healing locators.** Repairs fix the application or a provably wrong test; they do not hide selector failures.
- **No automatic fixed-port isolation.** Worktrees isolate edits, not listeners.
  A user can explicitly bypass a same-repo collision in a worktree, but safe
  same-app concurrency requires successful Portify or manual port injection.
  OAuth flows with registered redirect URIs may still need serial execution.
- **External exports are client-authored.** Canary Lab only stores and renders their content.

## Quality bars

These expectations shape reviews; several are code invariants (see [ARCHITECTURE.md](ARCHITECTURE.md#keep-in-sync-invariants)).

1. **Heal safety.** Interactive clients may own heal claims; runner-spawned PTY agents are denied. Destructive tools require `confirm: true`, external commands are audited, and repairs fix app or service code unless a test is provably wrong.
2. **Honest counts.** Pass counts come from `result.counts.statusLine` or `counts.passed`, never `total - failed`. Tests missing from every result list are *not run*.
3. **Durable evidence.** Logs, traces, summaries, and journals remain under
   `logs/runs/<runId>/` until manual cleanup. Service output is captured
   programmatically.
4. **Result-driven guidance.** `initialize` instructions and tool results (`nextSteps`, `boot_session`, collision choices) must guide an agent without installed skills, including blocking on `wait_for_heal_task` instead of polling.
5. **Narrow ownership.** New capabilities own run context—services, envs, artifacts, and signals—without taking over Playwright's role.
6. **Readable without invention.** English test descriptions come only from
   authored labels and deterministic syntax rules. Unsupported syntax remains
   exact source, and every readable node links back to its source range.

## Glossary

| Term | Meaning |
| --- | --- |
| **Suite** | A folder under `features/<name>/` with `feature.config.cjs`, envsets, and Playwright specs — the unit a run executes. Compatibility paths, fields, and commands still use `feature`. |
| **Run** | One execution of a suite's tests with booted services; identified by `runId`, artifacts under `logs/runs/<runId>/` |
| **Envset** | A named set of env files per environment (`local`/`production`/…) applied before a run and reverted after |
| **Heal claim** | The single-owner lock an external client takes to drive a run's repair loop |
| **Boot session** | A run with `executionType: 'boot'` — services up, no tests, no heal task |
| **Worktree isolation** | Running a repository from a per-run `git worktree` so repair edits can be captured without changing the source checkout. Regular runs attempt this for every repo; non-portified failures may fall back in place. |
| **Portify** | The workflow that rewrites a suite's services to read injected ports, unlocking concurrent boots |
| **Draft** | An externally authored set of spec files tracked through staged validation before apply |
| **Requirement coverage** | Claim-based mapping of requirements to tests, paths, and variants. Latest-run proof is a separate additive axis and does not change the semantic gap type. |
| **Verification (Verify)** | Running a suite's tests against a deployed environment to confirm it works end-to-end — no local boot, no heal |
| **Evaluation export** | A rendered archive of a terminal run. Wording may come directly from evidence, a local rewrite agent, or an external MCP client. |
| **Readable Test** | A deterministic English tree derived from one Playwright test's source, with nested control flow, fidelity labels, and exact source ranges. |
