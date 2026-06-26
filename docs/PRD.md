# Canary Lab — Product Requirements (reverse-engineered)

> **Status**: reverse-engineered from the README, CHANGELOG, GUIDE, and code as of
> v1.4.0. This captures the product intent implied by what's shipped so agents and
> new contributors share the same picture. Correct anything that misreads the intent —
> this document is the tie-breaker when a change is technically possible but
> product-questionable.

## Problem

An AI agent asked to fix a failing test can report success it hasn't earned —
declaring a pass, rounding up a count, or quietly editing the test instead of the app.
Self-reported "it passes now" isn't really evidence. Canary Lab tries to make that
harder by keeping the outcome grounded in things the agent doesn't author: the harness
runs the tests, not the agent; pass counts come from the real result lines; the coverage
% is computed by canary from the tags, not asserted by the agent; and repairs are
expected to change the application, not the test. The rough shape is **requirement
coverage → test run → end-to-end verification** — enough that a human can check the
result independently, and so the same output can feed back to the agent as a signal to
fix against rather than just a pass/fail gate.

The repair loop leans on the same evidence. A failing Playwright test usually scatters
its context — service logs in one terminal, a trace somewhere, a screenshot you have
to go find — so diagnosis happens cold. Canary Lab tries to keep the whole run in one
place: it runs the tests locally, captures the context around each failure (logs,
screenshots, traces, videos, which services ran, which env applied), and hands that to
the agent as a reproducible evidence packet to fix the app and rerun **from the same
run**. Built for teams that use tests as the spec.

## Users

1. **App engineer** — drives runs from `canary-lab ui` or the CLI, reads run
   history, switches envsets, occasionally repairs by hand.
2. **AI agent as repair operator** — connects over MCP (Claude/Codex Desktop or CLI),
   starts or claims runs, reads heal context, edits app code, signals rerun/restart.
   The agent is a first-class user: tool results and `initialize` instructions are
   designed to steer agents that never read documentation.
3. **Eval author** — exports a terminal run (passed or failed) as a structured
   evaluation report; the external client writes the wording, Canary Lab renders and
   stores the archive.

## Capabilities by area

These broadly mirror the CHANGELOG area tags; requirement coverage and verification are
cross-cutting and not separately tagged in the CHANGELOG.

### [Test Runner]

- Run a feature's Playwright tests with services booted, health-checked, and
  PTY-captured per run; artifacts retained under `logs/runs/<runId>/`.
- Repair loop: auto-heal (local `claude`/`codex` agent) or external heal (MCP client
  claims the run, fixes, signals `rerun`/`restart`); the run continues until it
  passes or fails terminally.
- Concurrent runs with per-run port allocation, same-repo collision handling
  (worktree or queue), and resource-aware admission queueing.
- Boot-only sessions: start a feature's services without running tests, for manual
  exploration.
- Envset switching: run one feature against `local`/`staging`/`production` env files
  without hand-editing `.env`.

### [Test Generation]

- Feature scaffolding (`create_feature`, the Add Test wizard) with conventions:
  `feature.config.cjs`, envsets, specs importing
  `canary-lab/feature-support/log-marker-fixture`.
- External draft flow: an MCP client authors specs while Canary Lab tracks the draft
  stages and validates on apply.
- Env capture from a source repo with secret redaction.
- Portify: agent-driven rewrite of a feature's services to accept injected ports,
  verified by a concurrent double-boot and saved as an ephemeral overlay (applied
  per-run, reverse-applied at teardown) so the product repo is never modified.

### [Requirement coverage]

- Requirements traceability: a feature's `docs/` source is summarized into a PRD
  (requirements with stable ids); tests are tagged to requirements
  (`{ tag: ['@req-<id>', '@path-happy'] }`). Coverage is **semantic** — canary computes
  it from the tags (covered ÷ active total), math not opinion — and decoupled from runs:
  it asks whether a mapped test claims every path (and variant) a requirement implies,
  not whether a run passed.
- Gap typing — `covered` / `path-incomplete` / `variant-incomplete` / `untested` — plus a
  per-test strictness grade for *depth*: which layer each test really checks (app log →
  internal state → app API → browser) and the stronger assertion to write.
- One computation layer behind both the UI (the 🎯 Coverage view) and MCP
  (`get_feature_coverage`), so the two can never diverge.

### [Verification]

- Run a feature's tests against a **deployed** environment (`execute_verification` with
  per-target URLs and a Playwright envset) — never boots local services, never starts
  healing — to confirm the real thing works end-to-end. Saved as reusable Verify
  configs and scoped to the `verify` MCP profile.

### [Export evaluation]

- Export any terminal run as an evaluation archive (`evaluation.html`); the external
  client writes the report wording, Canary Lab stores and renders it. A failed or
  aborted run exports as-is — the status is preserved, not healed away.

### [General]

- One published CLI (`init`, `setup`, `ui`, `mcp`, `new feature`, `env`, `upgrade`),
  a local web UI, and an MCP server sharing one port.
- Profile-scoped MCP surface (`repair`/`verify`/`author`/`portify`/`lifecycle`/`full`) so
  each client kind sees only the tools its workflow needs.

## Non-goals

- **Not a CI runner or hosted dashboard.** Canary Lab is a local run monitor; the
  evidence and the repair loop live on the engineer's machine.
- **Not a test framework.** No test language, assertion model, or browser runner —
  plain Playwright runs the tests; Canary Lab owns the context around them.
- **No self-healing locators.** Repairs edit the application (or a provably wrong
  test); they don't paper over selectors.
- **No same-app concurrent isolation.** Worktrees isolate heal *edits*, not ports;
  two runs of the same multi-service app queue. OAuth features with
  provider-registered redirect URIs run one at a time.
- **External exports are client-authored.** Canary Lab never rewrites, translates, or
  agent-generates the report content for an external export.

## Quality bars

These are the expectations that shape review decisions; several are encoded as code
invariants (see [ARCHITECTURE.md](ARCHITECTURE.md#keep-in-sync-invariants)).

1. **Heal safety.** Every interactive client may own a heal claim; only the
   runner-spawned PTY agents are blocked (denylist, since the runner tags its own
   spawns deterministically); destructive tools require an explicit
   `confirm: true`; the repair rule is "fix app/service code, not tests, unless a
   test is provably wrong"; every external command is audited per run.
2. **Honest counts.** Pass counts come from `result.counts.statusLine` /
   `counts.passed` — never computed as `total - failed`; tests absent from all
   result lists are *not run*, not passed.
3. **Evidence durability.** Each run's logs, traces, summaries, and journal survive
   under `logs/runs/<runId>/` and are never auto-pruned — removed only via manual Log
   Cleanup; service output is captured programmatically, never lost to a terminal.
4. **Result-driven agent steering.** An agent with no skill installed must still
   converge on the correct loop from `initialize` instructions and tool results
   (`nextSteps`, `boot_session`, collision choices) — blocking on
   `wait_for_heal_task`, never inventing a poll loop.
5. **Narrow ownership boundary.** New capabilities should own run context (services,
   envs, artifacts, signals), not creep into Playwright's territory.

## Glossary

| Term | Meaning |
| --- | --- |
| **Feature** | A folder under `features/<name>/` with `feature.config.cjs`, envsets, and Playwright specs — the unit a run executes |
| **Run** | One execution of a feature's tests with booted services; identified by `runId`, artifacts under `logs/runs/<runId>/` |
| **Envset** | A named set of env files per environment (`local`/`production`/…) applied before a run and reverted after |
| **Heal claim** | The single-owner lock an external client takes to drive a run's repair loop |
| **Boot session** | A run with `executionType: 'boot'` — services up, no tests, no heal task |
| **Worktree isolation** | Running a colliding same-repo run in a per-run `git worktree` so heal edits can't corrupt the other run |
| **Portify** | The workflow that rewrites a feature's services to read injected ports, unlocking concurrent boots |
| **Draft** | An externally authored set of spec files tracked through staged validation before apply |
| **Requirement coverage** | Whether a mapped test claims every path (and variant) a requirement implies; the ledger maps requirements ↔ tests with a coverage % canary computes from the tags — semantic, decoupled from run history |
| **Verification (Verify)** | Running a feature's tests against a deployed environment to confirm it works end-to-end — no local boot, no heal |
| **Evaluation export** | A rendered archive of a terminal run with client-authored report wording |
