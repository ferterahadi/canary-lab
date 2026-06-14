# Canary Lab — Product Requirements (reverse-engineered)

> **Status**: reverse-engineered from the README, CHANGELOG, GUIDE, and code as of
> v1.3.0. This captures the product intent implied by what's shipped so agents and
> new contributors share the same picture. Correct anything that misreads the intent —
> this document is the tie-breaker when a change is technically possible but
> product-questionable.

## Problem

A failing Playwright test scatters its evidence: service logs in one terminal, a
trace file somewhere, a screenshot you have to go find. Diagnosis happens cold, from
terminal scrollback, and the fix loop ("change something, rerun everything") loses
the context of the original failure.

Canary Lab keeps the whole run in one place. It runs Playwright tests locally,
captures the context around each failure — logs, screenshots, traces, videos, which
services were running, which env was applied — and hands that to an AI agent as a
reproducible evidence packet to fix the app and rerun **from the same run**. Built
for teams that use tests as the spec.

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

These mirror the CHANGELOG area tags.

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

### [Export evaluation]

- Export any terminal run as an evaluation archive (`evaluation.html`); the external
  client writes the report wording, Canary Lab stores and renders it. A failed or
  aborted run exports as-is — the status is preserved, not healed away.

### [General]

- One published CLI (`init`, `setup`, `ui`, `mcp`, `new feature`, `env`, `upgrade`),
  a local web UI, and an MCP server sharing one port.
- Profile-scoped MCP surface (`repair`/`verify`/`author`/`full`) so each client kind
  sees only the tools its workflow needs.

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

1. **Heal safety.** Only Desktop client kinds may own a heal claim (allowlist that
   fails safe on detection failure); destructive tools require an explicit
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
| **Evaluation export** | A rendered archive of a terminal run with client-authored report wording |
