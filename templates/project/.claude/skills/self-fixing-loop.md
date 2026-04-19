---
name: Canary Lab Self-Fixing Loop
description: Diagnose and fix failing Canary Lab tests using pre-extracted log evidence. Triggered when the user says "self heal".
type: skill
---

# Self-Fixing Loop

**Trigger:** user types `self heal`.
**Preconditions:** `npx canary-lab run` is open in watch mode and `logs/e2e-summary.json` contains failures.

## Principle

**The service-log chunk between `<test-case-SLUG>` markers is ground truth.** Your job is to explain the delta between what the test **expected** (`error.message`) and what the service **actually logged** (`failed[].logs[<svc>]`), then fix the code that produced the delta. Triangulate three sources — expected ↔ actual ↔ code — before any edit.

## Hard rules (non-negotiable)

- **`Read` on implementation files is banned without a prior `grep` match.** Always `grep -rn` first, then narrow Read ±20 lines at the matching line. No exceptions — not for "small" files, not for "quick look". If you catch yourself about to open a whole `server.ts`, stop and grep a literal from the log chunk instead.
- **Never reason from `error.message` alone.** Pair it with `logs[<svc>]`. The assertion tells you *what's wrong*; the log chunk tells you *where*.
- **Combine root causes.** One journal entry + one signal per iteration, covering every failure that shares an evidence chain. If four failures point at the same handler, that's one fix, not four.
- Fix the implementation, not the test. Never weaken an assertion.
- Stay in this session. Do not ask the user to open a new one.
- Do not `ls logs/` or `ls features/…`, do not `cat` the test spec or `feature.config.cjs` — the bug is almost never in configs.
- Do not re-slugify test titles. `failed[].name` *is* the slug used in the log markers.

---

## Step 1 — Resume check

Read `logs/diagnosis-journal.json` and `logs/signal-history.json` if they exist. Summarize what was already tried and do not re-try a failed hypothesis. Then continue.

## Step 2 — Triangulate (the default path)

The runner already extracted each failing test's service-log chunk into `logs/e2e-summary.json` at `failed[].logs[<svc-log-file>]`. That chunk is your primary evidence.

1. `Read logs/e2e-summary.json`.
2. For each `failed[]` entry, write down one line: `expected: <from error.message> | actual: <from logs[<svc>]>`. Chunks look like:

   ```
   <test-case-tax-rounds-to-2-decimal-places>
   [tricky_checkout_api] summary cart=3 items=1 subtotal=1.1 tax=0.09 total=1.1900000000000002
   </test-case-tax-rounds-to-2-decimal-places>
   ```

3. From each `actual`, pick a **distinctive literal** — a numeric value (`1.1900000000000002`), a log prefix (`[tricky_checkout_api] summary`), or a variable name that also appears in the assertion (`subtotal`, `cartId`). Prefer literals that are unlikely to occur elsewhere.
4. `grep -rn '<distinctive literal>' features/<feature>/scripts` → narrow Read ±20 lines at the match. That is where the bug lives.
5. **Group findings.** Which failures share a root cause (same handler, same helper, same data shape)? Combine them into one hypothesis. Codex-style discipline: four bugs → one hypothesis → one edit → one signal.

Only fall through to Step 3 if `failed[].logs` is empty (the test failed before emitting its opening marker) or the chunk genuinely doesn't localize the bug after you've tried more than one literal from it.

## Step 3 — Fallback path

1. **Raw log by slug.** Run `sed -n '/<test-case-SLUG>/,/<\/test-case-SLUG>/p' logs/svc-*.log` with `SLUG` = `failed[].name`. Svc logs are wiped on every signal, so the output is this iteration only.
2. **If `sed` is also empty — instrument first, fix second.** Read the failing test file + the handler path (narrow Reads guided by `grep`). Add `console.log` at decision points (inputs, branch taken, helper return values, object shapes near the failing line). Write `.restart` with a **gather-evidence** hypothesis. On the next iteration, re-run `sed` and decide the real fix from real evidence. Remove the diagnostic logs in the same iteration that lands the fix.

## Step 4 — Hypothesize + journal

Before any edit, append a **single** entry to `logs/diagnosis-journal.json` (create if missing). The entry covers *all* grouped failures from Step 2:

```json
{
  "feature": "<feature>",
  "iterations": [
    {
      "iteration": 1,
      "timestamp": "<ISO>",
      "failingTests": ["<slug-a>", "<slug-b>", "<slug-c>"],
      "hypothesis": "<what is wrong and why, across all grouped failures>",
      "filesExamined": ["path/to/file.ts:lines"],
      "fix": null,
      "signal": null,
      "outcome": null
    }
  ]
}
```

## Step 5 — Fix + signal

Make the minimal edit. Update the journal entry's `fix` field:

```json
"fix": { "file": "path/to/file.ts", "description": "<what changed, covering all grouped failures>" }
```

Then write a signal file with JSON context:

```bash
echo '{"hypothesis":"…","filesChanged":["…"],"expectation":"<comma-separated slugs that should now pass>"}' > logs/.restart
```

Use `.restart` when service code changed, `.rerun` when only the test/config changed. Set the journal entry's `signal` to `"restart"` or `"rerun"`.

## Step 6 — Evaluate

After the runner re-runs, read the updated `logs/e2e-summary.json` and set the journal entry's `outcome`: `"all_passed"`, `"partial"` (+ notes), `"no_change"`, or `"regression"`.

- All passed → tell the user, stop.
- Still failing → back to Step 2 with the new evidence. Your prior hypothesis was wrong or incomplete — the journal prevents repeat attempts.
- 3 failed iterations → stop. Produce a diagnosis report (what you tried, what you learned, suspected root cause) and ask the user for guidance.

---

## Anti-patterns (don't do these)

- **Full-file read.** `Read features/<feature>/scripts/server.ts` with no line range. You'll miss the per-test delta, burn tokens, and spot bugs by luck instead of evidence. Grep a literal from the log chunk instead.
- **Glob-and-eyeball.** `Glob features/**/scripts/**/*` to "see what's there". You don't need the file tree; the failure already points at the feature.
- **Assertion-only reasoning.** Reading `error.message` and jumping to code. `error.message` tells you *what's wrong*, not *where* — the log chunk is what localizes the bug.
- **One fix per iteration.** Splitting four related bugs into four iterations when one grouped hypothesis covers them. Burns iterations, tokens, and journal entries.
- **Weakening the test.** If the assertion is right and the service output is wrong, fix the service.
