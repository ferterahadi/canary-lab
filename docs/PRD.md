# Canary Lab — Product Requirements (reverse-engineered)

> **Status:** reverse-engineered from the README, changelog, guide, and current 1.6.0 code. This is the product-intent reference for contributors and agents. Update it when shipped behavior changes.

## Positioning

Canary Lab augments Playwright and an AI agent; it replaces neither. Playwright runs tests, the agent writes code, and Canary Lab owns service startup, isolation, requirement coverage, evidence, verdicts, and the rendered evaluation.

The loop is: implement, verify with `canary-lab flight` or an existing suite, then review the evaluation. The report is the human-facing proof.

## Problem

An agent can misread counts, declare a false pass, or weaken a test instead of fixing the application. Canary Lab keeps results outside its control: the harness runs tests, Playwright supplies pass counts, tags determine coverage, and repairs target application or service code unless a test is provably wrong.

The evidence chain is **requirement coverage → test run → end-to-end verification**. A human can review it, and the same evidence guides the next repair attempt.

Failed tests scatter context across terminals and artifacts. Canary Lab keeps each run together: local test results, logs, screenshots, traces, videos, services, and the applied env. The agent receives this evidence, fixes the app, and reruns **the same run**. Built for teams that use tests as the specification.

## Users

1. **App engineer** — runs tests from the UI or CLI, reviews history, switches envsets, and sometimes repairs by hand.
2. **AI repair agent** — connects over MCP, claims runs, reads evidence, edits app code, and signals rerun or restart. Tool results and `initialize` instructions guide agents that never read the docs.
3. **Evaluation author** — exports any terminal run. Canary Lab renders and stores the archive; wording comes from evidence (`raw`), a local agent (`localized`), or an external MCP client.

## Capabilities by area

These areas broadly match the changelog tags. Flight, coverage, and verification are cross-cutting; Flight appears under `[General]`.

### [Flight]

- The front door: `canary-lab flight <repo…> "<what to test>"` or `start_flight` takes a bare repo from setup through evaluation export. Failed runs can export with their real verdict.
- **The server conducts and the harness computes every verdict; the agent only proposes.**
  A stage passes only when the config parses and boots, the ledger proves coverage, Playwright supplies the verdict, and the archive exists.
- A resumable background job with typed checkpoints. Autopilot handles routine choices but stops for existing features, missing secrets, and failed automatic answers.
- **One flight record per feature.** Repos and intent freeze at startup; re-entry resumes or redoes without duplicating or swapping inputs.
- CLI, web UI, and MCP use one store.

### [Test Runner]

- Run Playwright with booted, health-checked, PTY-captured services; retain artifacts under `logs/runs/<runId>/`.
- Repair through a local `claude`/`codex` agent or an MCP client that claims, fixes, and signals `rerun` or `restart`; continue until pass or terminal failure.
- Concurrent runs with per-run ports and worktrees. Fixed-port conflicts and resource limits place runs in a queue.
- **Repairs never land in the user's checkout.** Runs use per-run Git worktrees hydrated with work in progress, then save heal edits under `logs/runs/<runId>/fixes/`. A green repair can force-push to a feature branch and open a draft pull request; opt out with `autoProposePr`.
- Boot-only sessions start services without tests.
- Envsets switch between environments without hand-editing `.env`.

### [Test Generation]

- Feature scaffolding through `create_feature` or Flight, using `feature.config.cjs`, envsets, and specs that import `canary-lab/feature-support/log-marker-fixture`.
- External drafts let MCP clients author specs while Canary Lab tracks stages and validates on apply.
- Env capture from a source repo with secret redaction.
- Portify rewrites services to accept injected ports, verifies them with a concurrent double boot, and stores an overlay applied per run and reversed at teardown. The product repo stays unchanged.

### [Requirement coverage]

- Canary Lab turns `docs/` into requirements with stable IDs, then maps tagged tests to them. Coverage is **semantic**: tags determine covered ÷ active requirements, independent of run results, including every required path and variant.
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
- Profile-scoped MCP surface with seven workflow profiles (`repair`, `verify`, `author`, `coverage`, `export`, `flight`, and `portify`) plus two composed profiles (`lifecycle` and `full`). `lifecycle` is the default.

## Non-goals

- **Not a CI runner or hosted dashboard.** Evidence and repair stay on the engineer's machine.
- **Not a test framework.** Playwright owns the language, assertions, and browser runner; Canary Lab owns the surrounding context.
- **No self-healing locators.** Repairs fix the application or a provably wrong test; they do not hide selector failures.
- **No same-app concurrent isolation.** Worktrees isolate edits, not ports. Runs of the same multi-service app queue; OAuth features with registered redirect URIs run one at a time.
- **External exports are client-authored.** Canary Lab only stores and renders their content.

## Quality bars

These expectations shape reviews; several are code invariants (see [ARCHITECTURE.md](ARCHITECTURE.md#keep-in-sync-invariants)).

1. **Heal safety.** Interactive clients may own heal claims; runner-spawned PTY agents are denied. Destructive tools require `confirm: true`, external commands are audited, and repairs fix app or service code unless a test is provably wrong.
2. **Honest counts.** Pass counts come from `result.counts.statusLine` or `counts.passed`, never `total - failed`. Tests missing from every result list are *not run*.
3. **Durable evidence.** Logs, traces, summaries, and journals remain under `logs/runs/<runId>/` until manual cleanup. Service output is captured programmatically.
4. **Result-driven guidance.** `initialize` instructions and tool results (`nextSteps`, `boot_session`, collision choices) must guide an agent without installed skills, including blocking on `wait_for_heal_task` instead of polling.
5. **Narrow ownership.** New capabilities own run context—services, envs, artifacts, and signals—without taking over Playwright's role.

## Glossary

| Term | Meaning |
| --- | --- |
| **Feature** | A folder under `features/<name>/` with `feature.config.cjs`, envsets, and Playwright specs — the unit a run executes |
| **Run** | One execution of a feature's tests with booted services; identified by `runId`, artifacts under `logs/runs/<runId>/` |
| **Envset** | A named set of env files per environment (`local`/`production`/…) applied before a run and reverted after |
| **Heal claim** | The single-owner lock an external client takes to drive a run's repair loop |
| **Boot session** | A run with `executionType: 'boot'` — services up, no tests, no heal task |
| **Worktree isolation** | Running every test run in a per-run `git worktree` per repo, so heal edits are captured as a diff instead of mutating the product repo (and a colliding same-repo run can't corrupt the other one) |
| **Portify** | The workflow that rewrites a feature's services to read injected ports, unlocking concurrent boots |
| **Draft** | An externally authored set of spec files tracked through staged validation before apply |
| **Requirement coverage** | Whether a mapped test claims every path (and variant) a requirement implies; the ledger maps requirements ↔ tests with a coverage % canary computes from the tags — semantic, decoupled from run history |
| **Verification (Verify)** | Running a feature's tests against a deployed environment to confirm it works end-to-end — no local boot, no heal |
| **Evaluation export** | A rendered archive of a terminal run. Wording may come directly from evidence, a local rewrite agent, or an external MCP client. |
