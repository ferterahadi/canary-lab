---
name: cl_code-conventions
description: Use when writing or reviewing any canary-lab code — the conventions this repo actually follows for comments, error handling, types, tests, and coverage. Covers only what a linter cannot express; the mechanical half is enforced by `npm run check:conventions`, so read this when deciding HOW to write something, not to look up formatting.
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Canary Lab — Code Conventions

Every rule below was derived by measuring this codebase, not from a style guide.
The mechanical half — filename case, bare `catch {}`, `console.*` outside the
CLI, alias scope, `v8 ignore`, test placement, coverage scope — is enforced by
`npm run check:conventions` and is deliberately **not** repeated here. If a tool
can catch it, it isn't your job to remember it.

What's left is judgement. That's this file.

## Comments carry the why, never the what

Comment density is an outcome (16% of lines repo-wide), not a target. A comment
earns its place by holding something the code cannot:

- **Why**, when the code's shape looks arbitrary without it.
- **An invariant**, when correctness depends on something out of frame.
- **A decision not taken**, so the next reader doesn't redo the analysis.

Never restate the code. `// increment the counter` is worse than no comment.

**When code is unreachable, the comment names the invariant that makes it so —
and then you narrow the type so a regression is a compile error, not a surprise:**

```ts
// Always returns a usable selector: `knownTestsFromSummary` is the only source
// of a KnownSummaryTest and it drops any entry without a non-empty `title`, and
// the sole caller has already returned early on an empty selection. The return
// type says `string` so a future edit that breaks either invariant is a compile
// error rather than a silently-widened full-suite rerun.
function grepForKnownTests(tests: KnownSummaryTest[]): string {
```

**When a test fixture's shape is load-bearing, say so in the test.** A fixture
that looks incidental will be "simplified" later and the test will keep passing
while proving nothing:

```ts
// The direct `toBeVisible` is load-bearing: with no assertion of its own the
// test gets a placeholder whose empty snippet substring-matches every statement,
// so `outer(page)` would render as an assertion step instead of a helper one and
// the nested walk would never run.
```

## Errors

- **HTTP-facing failures** are `Object.assign(new Error(msg), { statusCode: N })`
  — 64 sites. Not a custom error class; the route layer reads `statusCode`.
- **Fire-and-forget async gets an explicit `.catch()`.** Never a bare
  `void promise`. An orchestrator that handles its own phase failures can still
  reject from a `finally`, and an unhandled rejection is not a strategy.
- **Best-effort I/O swallows; it never rethrows to a caller who can't act.**
  Swallowing is fine. Silence is not — the reason goes inline (enforced).

## Types: make bad states unrepresentable

Prefer encoding an impossible combination out of existence over guarding it at
runtime. Two moves that keep recurring:

- **A discriminated union instead of two loose optional params.** `agent: 'claude'
  | 'codex'` plus `sessionId?: string` admits "claude with no session id", which
  no caller can produce. Pairing them removes the state *and* the dead branch.
- **Required over optional when the only caller always supplies it.** An optional
  param that is never actually absent is a fallback path you can neither test nor
  delete.

Both replace a runtime check with a compile error. That is the whole point.

## Tests

- **Real filesystem, real git, in a `mkdtempSync` tmpdir** — 131 of 307 test
  files. Mock only the genuinely un-unit-testable edge: the agent subprocess, a
  PTY, the network. A mocked filesystem proves your mock works.
- **A second suite for different module-level mocks** is `<module>.<variant>.test.ts`
  (`git-repo.mock.test.ts`, `coverage.mocked.test.ts`). `vi.mock` is per-file, so
  this is a real constraint, not a preference. Tests otherwise sit beside the code
  they test — and a suite may legitimately cover a subsystem rather than one
  module (`repair-guardrail.test.ts`).
- **Poll a condition; don't sleep a fixed time**, when the trigger is OS-timed.
- **When timing decides whether the code under test runs at all, capture the
  callback and drive it synchronously.** Two file writes inside a debounce window
  may arrive as *one* `fs.watch` event, so the coalescing branch never executes
  and the test passes having proven nothing. This is how a branch stays
  intermittently uncovered.
- **Assert the observable consequence, not that a branch ran.** "Exactly one
  recompute after a further full window" pins the behaviour; reaching the line
  does not.
- **Never weaken, skip, or delete a test to make something pass.** Repo-wide hard
  rule, pinned by `mcp/repair-guardrail.test.ts`. Mechanical edits to test files
  (import paths, `__dirname` depth) when files move are expected; changing what a
  test *asserts* is not.

## Coverage

The gate is 100% over a floor of gated files. Both halves matter — a file lifted
out of the gate keeps the percentage at 100% while covering less.

- **An unreachable arm gets deleted, or made unrepresentable in the type. Never
  tested around, never pragma'd.** `/* v8 ignore */` is banned repo-wide.
- **A file-level exclude is the last resort, and carries a per-arm rationale.**
- **That rationale is a hypothesis, not a fact.** Re-measure before trusting it.
  Both files closed in `0e3d9bf` had *more* uncovered than their comment listed —
  one claimed 5 arms and had 12 arms + 6 statements + 2 functions, most of them
  reachable.
- **Measure from `coverage-final.json`'s `statementMap`, not lcov `DA:`/`BRDA:`.**
  An uncovered *statement* does not appear in an lcov branch read; that gap cost a
  red gate at 99.98% with zero uncovered lines reported.
- **Moving already-covered code out of an excluded file still adds it to the
  gate.** A low-coupling extraction is a win even when its tests already existed.

## Before you claim it works

`cl_verify-changes` owns the ladder. Two things specific to conventions:

1. `npm run check:conventions` and `npm run check:boundaries` are fast — run them.
2. **A check that cannot fail is worse than no check.** If you add a rule to
   `tools/check-conventions.mjs`, inject a violation and confirm it exits 1,
   including a negative control that the legal form does *not* trip it. The first
   draft of that script produced 66 false positives by stripping comments before
   looking for a missing comment.

## Related

`cl_reuse-shared-logic` (before adding a second anything) · `cl_verify-the-premise`
(before acting on a claim you didn't confirm) · `cl_run-evidence-invariants`
(anything producing a verdict) · `cl_verify-changes` (which checks a change needs)
