---
name: Canary Lab Self-Fixing Loop
description: Diagnose and fix failing Canary Lab tests using pre-extracted log evidence. Triggered when the user says "self heal".
type: skill
---

# Self-Fixing Loop

**Trigger:** user types `self heal`.
**Preconditions:** `npx canary-lab run` is open in watch mode and `logs/e2e-summary.json` contains failures.

## Rules (apply throughout)

- Fix the implementation, not the test. Never weaken an assertion to make it pass.
- Stay in this session. Do not ask the user to open a new one.
- If logs don't prove your hypothesis, instrument the code and re-run — do not guess.
- **Never full-file Read an implementation file.** Always `grep` first, then narrow Read (±20 lines).
- Do not `ls logs/` or `ls features/…`, do not `cat` the test spec or `feature.config.cjs` — the bug is almost never in configs.
- Do not re-slugify test titles. `failed[].name` *is* the slug used in the log markers.

---

## Step 1 — Resume check

Read `logs/diagnosis-journal.json` and `logs/signal-history.json` if they exist. Summarize what was already tried and do not re-try a failed hypothesis. Then continue to Step 2.

## Step 2 — Fast path (≈15 seconds, the default)

The runner already extracted each failing test's service log chunk into `logs/e2e-summary.json` at `failed[].logs[<svc-log-file>]`. That chunk is your primary evidence.

1. `Read logs/e2e-summary.json`.
2. For each `failed` entry, look at `logs[<svc>]`. Chunks look like:

   ```
   <test-case-tax-rounds-to-2-decimal-places>
   [tricky_checkout_api] summary cart=3 items=1 subtotal=1.1 tax=0.09 total=1.1900000000000002
   </test-case-tax-rounds-to-2-decimal-places>
   ```

   Pick a distinctive substring — a log prefix, a numeric literal, or a variable name that also appears in `error.message`.
3. `grep -rn '<distinctive string>' features/<feature>/scripts`, then narrow Read ±20 lines around the match. Fix from there.

Only fall through to Step 3 if `failed[].logs` is empty (the test failed before emitting its opening marker) or the chunk doesn't localize the bug.

## Step 3 — Fallback path

1. **Raw log by slug.** Run `sed -n '/<test-case-SLUG>/,/<\/test-case-SLUG>/p' logs/svc-*.log` with `SLUG` = `failed[].name`. Svc logs are wiped on every signal, so the output is this iteration only.
2. **If `sed` is also empty — instrument first, fix second.** Read the failing test file + the handler path (narrow Reads guided by `grep`). Add `console.log` at decision points (inputs, branch taken, helper return values, object shapes near the failing line). Write `.restart` with a **gather-evidence** hypothesis. On the next iteration, re-run `sed` and decide the real fix from real evidence. Remove the diagnostic logs in the same iteration that lands the fix.

## Step 4 — Hypothesize + journal

Before any edit, append an entry to `logs/diagnosis-journal.json` (create if missing):

```json
{
  "feature": "<feature>",
  "iterations": [
    {
      "iteration": 1,
      "timestamp": "<ISO>",
      "failingTests": ["<slug>"],
      "hypothesis": "<what is wrong and why>",
      "filesExamined": ["path/to/file.js:lines"],
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
"fix": { "file": "path/to/file.js", "description": "<what changed>" }
```

Then write a signal file with JSON context:

```bash
echo '{"hypothesis":"…","filesChanged":["…"],"expectation":"<slug that should now pass>"}' > logs/.restart
```

Use `.restart` when service code changed, `.rerun` when only the test/config changed. Set the journal entry's `signal` to `"restart"` or `"rerun"`.

## Step 6 — Evaluate

After the runner re-runs, read the updated `logs/e2e-summary.json` and set the journal entry's `outcome`: `"all_passed"`, `"partial"` (+ notes), `"no_change"`, or `"regression"`.

- All passed → tell the user, stop.
- Still failing → back to Step 2 with the new evidence. Your prior hypothesis was wrong or incomplete — the journal prevents repeat attempts.
- 3 failed iterations → stop. Produce a diagnosis report (what you tried, what you learned, suspected root cause) and ask the user for guidance.
