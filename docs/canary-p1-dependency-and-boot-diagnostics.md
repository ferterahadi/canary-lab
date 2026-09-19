# Canary Lab P1 — Dependency Coherence and Startup Evidence

**Status:** Proposed  
**Date:** 2026-09-19  
**Scope:** P1 follow-up to the completed runtime-input and terminal-test-review work.

## Context

A Claude-driven run of `cns-wa-bot-signup` exposed two failures that P0 does not
solve:

1. A Canary checkout on an older source revision resolved `node_modules` through
   another checkout. Its generated Prisma client no longer matched the old source,
   so seed code and gateway compilation failed before the suite could run.
2. The target startup wrapper caught and discarded the rejected error. Canary could
   report that boot did not complete, but the first heal cycle did not contain the
   cause needed to repair it.

P0 deliberately fixed run-owned suite inputs and terminal review resolution. It
does not make arbitrary repositories' generated dependencies coherent, and it
cannot reconstruct an exception a target process suppresses.

## Decision

Add a pre-boot dependency-provenance check and a richer, bounded boot-failure
record. Preserve the current cheap shared-dependency path when compatibility is
unknown, but block a **confirmed** mismatch before services start. Require
repositories that have generated artifacts to supply their own preparation and
validation command rather than adding Prisma-specific rules to Canary.

Canary will distinguish an exited service process from a health timeout, retain
the available evidence, and explicitly report when the wrapper did not preserve a
root cause.

## Non-goals

- Do not automatically advance pinned checkouts to a newer branch.
- Do not add Prisma-model compatibility guards to Canary.
- Do not regenerate dependencies through a symlink into another checkout.
- Do not invent a root cause from a generic startup message.
- Do not expose secrets in provenance, log excerpts, run artifacts, or exports.

## P1A — Dependency coherence

### Before → after

| Current behavior | Proposed behavior |
| --- | --- |
| A worktree may reuse linked `node_modules` without a compatibility record. | Canary records dependency provenance and classifies it as `compatible`, `incompatible`, or `unknown`. |
| A source/client mismatch first appears as seed, compile, or readiness failure. | A confirmed mismatch stops before boot with the source revision, dependency location, and remediation. |
| Generated-client compatibility is implicitly treated as a package-install concern. | The target repository may define a preparation/validation command and generator-input fingerprints. |

### Provenance record

For each prepared repository checkout, record non-secret metadata:

- source revision and real path;
- dependency real path and lockfile fingerprint;
- Node/runtime and package-manager identity;
- optional target-defined generator-input fingerprints;
- preparation mode (`shared` or `isolated`) and a `compatible`, `unknown` or
  `incompatible` verdict.

Lockfile equality alone is insufficient proof for a generated client. A target
repository's validation command owns ecosystem-specific checks such as a Prisma
schema/client relationship.

### Implementation path

1. Extend worktree preparation around `runtime/repo-worktree.ts` to return a
   provenance result instead of silently linking dependencies.
2. Add repository configuration for an optional prepare/validate command and
   generator-input paths/fingerprints.
3. Persist the sanitized result on the run manifest before service startup.
4. Refuse `incompatible` preparation with an actionable preflight failure.
5. Keep `unknown` backward-compatible initially, but show a visible warning and
   support a strict mode after pilot migration.
6. Add an isolated dependency/generated-output mode for repositories whose shared
   dependencies cannot be verified.

### Acceptance criteria

- Two revisions with different generator inputs cannot silently run against one
  shared generated client.
- Nested dependency symlinks and concurrent revisions report a truthful
  verdict.
- Regenerating the source checkout while a worktree run is active does not make a
  claimed-compatible run incoherent.
- An unknown legacy setup remains runnable with an explicit warning; it is never
  represented as compatible.
- A confirmed mismatch fails before service startup and names the remediation.

## P1B — Startup evidence

### Before → after

| Current behavior | Proposed behavior |
| --- | --- |
| A failed readiness probe can be the only surfaced evidence. | The run records whether the service exited, timed out, or failed another boot phase. |
| The agent may need to edit a run worktree merely to expose a swallowed error. | Canary exposes a bounded, sanitized excerpt and full log reference; a suppressed error is reported as missing evidence, not guessed. |

### Failure record

Extend `RunBootFailure` and the external-heal surface with:

- service name, command, and working directory;
- failed phase (`spawn`, `process-exit`, `readiness`, or `configuration`);
- process exit code or signal when available;
- bounded, redacted log excerpt and full log path;
- remediation/next-action text that distinguishes evidence from inference.

The same record must reach run details, service panels, MCP waits, and external
heal context through the existing store/event bridge. Already-open views and
connected workflows must refresh or recover missed changes without a manual
reload.

### Target repository responsibility

Target startup wrappers must preserve the original rejected error and child-process
failure evidence. For the observed CNS case, this is a change to
`scripts/whatsapp-ext/start-stack.cjs`; it is not a Canary framework change.

### Acceptance criteria

- A rejected startup promise, compiler failure, seed failure, empty output,
  abrupt signal, and health timeout receive distinct classifications.
- UI and MCP describe the same failure, log path, and bounded excerpt.
- Sensitive values are redacted from excerpts and never leak into exports.
- If a wrapper emits only a generic message, Canary says that the underlying
  exception was suppressed rather than claiming a cause.

## Rollout and verification

1. Implement P1A and P1B in separate changes; neither should alter P0's evidence
   or review semantics.
2. Add real-filesystem tests for provenance classification and boot evidence,
   alongside MCP, UI, event-delivery, and missed-event recovery tests.
3. Run scoped Vitest suites, typecheck, conventions, boundaries, and package smoke.
4. Synchronize MCP instructions and all shipped agent skills for changed run-loop
   semantics.
5. After the user-owned `canary-apply` cycle, run an isolated pilot with
   `cns-wa-bot-signup` and representative suites sharing a checkout. Record
   actual preparation time, disk cost, provenance verdicts, and startup evidence.

## Risks and decisions still open

- Isolated dependency preparation has unmeasured disk and startup cost.
- Legacy envs/repositories without generator fingerprints must remain `unknown`,
  not be misclassified as compatible.
- A repository-specific validation command is required for correct generated-code
  checks; Canary cannot infer every build system.
- Historical runs without provenance remain readable as `unknown`; do not
  retroactively fabricate their metadata.
