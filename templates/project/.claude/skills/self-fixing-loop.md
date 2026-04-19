---
name: Canary Lab Self-Fixing Loop
description: Phased Claude workflow for diagnosing and fixing failing Canary Lab tests. Triggered when the user says "self heal".
type: skill
---

# Self-Fixing Loop

## Trigger Phrase

If the user types:

```text
self heal
```

follow this workflow.

## Start State

- The user should already have run `npx canary-lab run`
- The runner should still be open in watch mode
- Tests have failed and `logs/e2e-summary.json` exists

## Rules (apply throughout)

- Fix the implementation, not the test
- Do not "solve" a failure by changing the assertion
- Stay in this session — do not tell the user to open a new session
- Prefer **adding logs** over guessing. If the existing logs don't prove your hypothesis, instrument the code first, re-run, and read the new output before editing a fix.

---

## Phase 0 — Resume or Start Fresh

Check if prior diagnostic context exists:

1. Read `logs/diagnosis-journal.json` (if it exists)
2. Read `logs/signal-history.json` (if it exists)

If either file exists, summarize what was already tried and what the outcomes were. **Do NOT re-try a hypothesis that already failed.** Build on prior work.

If neither file exists, this is a fresh start — proceed to Phase 1.

---

## Phase 1 — Explore (do NOT edit any files yet)

Build a mental model of why the tests fail before touching any code.

1. **Read `logs/e2e-summary.json`** — identify which tests failed and their error messages
2. **Read the test file** — understand what each failing test asserts (the expected behavior)
3. **Read relevant service logs** (`logs/svc-*.log`) — look for the log output between the test's XML markers (`<test-case-SLUG>...</test-case-SLUG>`). These usually pinpoint the function or branch that misbehaved and let you keep the next step surgical. The runner wipes each svc log at the start of every iteration (both `.restart` and `.rerun`), so what you read is only the current iteration's output — the XML markers still matter for scoping to a specific test case within that iteration.
4. **Read the implementation code** — open only the function/branch the logs implicate. Trace the full request path (test helper -> HTTP call -> handler -> response) only if the logs don't localize the failure.
5. **If logs don't reveal enough, add instrumentation first** — before writing a fix, add `console.log` statements in the implementation to expose:
   - Input values at suspected decision points
   - Which branch was taken in conditionals
   - Values returned from helpers, DB/HTTP calls, or parsers
   - The shape of objects just before the line you suspect

   Then signal a restart (see Phase 2) and read the new `logs/svc-*.log` output. Log first, hypothesize second. Record what you logged in the journal's `hypothesis` field so future iterations know what evidence you gathered.

   **Clean up diagnostic logs** in the same iteration that lands the real fix — do not leave them in the implementation.

After exploring (and instrumenting if needed), form a hypothesis: what specific line(s) of code cause each failure and why?

**Write your hypothesis to `logs/diagnosis-journal.json` BEFORE making any edit:**

```json
{
  "feature": "<feature-name>",
  "iterations": [
    {
      "iteration": 1,
      "timestamp": "<ISO timestamp>",
      "failingTests": ["test-case-slug-here"],
      "hypothesis": "<what you think is wrong and why>",
      "filesExamined": ["path/to/file.js:lines"],
      "fix": null,
      "signal": null,
      "outcome": null
    }
  ]
}
```

If the journal already exists, append a new entry to the `iterations` array.

---

## Phase 2 — Fix

Now edit the implementation code to address your hypothesis.

1. Make the minimal fix needed
2. Update the journal entry's `fix` field:

```json
"fix": {
  "file": "path/to/file.js",
  "description": "Brief description of what you changed"
}
```

3. Signal the runner with context — write JSON to the signal file:

If running service code changed:

```bash
echo '{"hypothesis":"<your hypothesis>","filesChanged":["path/to/file.js"],"expectation":"<which test should now pass>"}' > logs/.restart
```

If no restart is needed (e.g., only test config changed):

```bash
echo '{"hypothesis":"<your hypothesis>","filesChanged":["path/to/file.js"],"expectation":"<which test should now pass>"}' > logs/.rerun
```

4. Update the journal entry's `signal` field to `"restart"` or `"rerun"`

---

## Phase 3 — Evaluate

After the runner re-runs and new results appear:

1. Read the updated `logs/e2e-summary.json`
2. Update the journal entry's `outcome` field:
   - `"all_passed"` if everything passes
   - `"partial"` with notes on what still fails
   - `"no_change"` if the same tests still fail
   - `"regression"` if new tests broke

3. **If all tests pass** — done. Tell the user.
4. **If tests still fail** — return to Phase 1 with the new information. Your prior hypothesis was wrong or incomplete — the journal ensures you don't repeat it.
5. **After 3 failed iterations** — stop and produce a detailed diagnosis report explaining what you've tried, what you've learned, and what you think the root cause is. Ask the user for guidance.

---

## Copy-Paste Prompt

```text
Please read CLAUDE.md and .claude/skills/self-fixing-loop.md first.
The Canary Lab runner is already in watch mode.
Follow the phased workflow: explore the failure context, form a hypothesis, fix the implementation, and signal the runner. Check for prior diagnostic context in logs/diagnosis-journal.json before starting.
```
