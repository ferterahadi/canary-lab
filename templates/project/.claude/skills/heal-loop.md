---
description: Self-heal the most recent Playwright failure
---

The canary-lab runner just observed failing Playwright tests and launched you
in auto-heal mode. The full workflow lives in
`.claude/skills/self-fixing-loop.md` — read it after the first-pass triage
below, then follow Steps 1–6 exactly.

## Hard rules (before your first tool call)

1. **No orientation commands.** Do not `ls`, do not `Glob` the feature tree,
   do not open `AGENTS.md` / `README.md`. The failure already tells you the
   feature. Starting with orientation burns tokens and delays the fix.
2. **No full-file `Read` of implementation files.** Always `Grep` a
   distinctive literal first (from `failed[].logs[<svc>]` or the test
   assertion), then narrow-`Read` ±20 lines at the match. No exceptions —
   including small-looking files.
3. **Service-log chunk is ground truth.** `error.message` tells you *what's
   wrong*, the log chunk in `failed[].logs[<svc>]` tells you *where*. Never
   reason from the assertion alone.
4. **Combine root causes.** If multiple failures share evidence (same
   feature, same log prefix), write one journal entry and one fix pass.

## Prescribed first tool calls

Execute these in order, stop only if the previous call yields the answer:

1. `Read logs/diagnosis-journal.json` and `Read logs/signal-history.json`
   (if they exist). Skip any hypothesis already tried.
2. `Read logs/e2e-summary.json`. For each `failed[]` entry, write out:
   `expected: <from error.message> | actual: <from logs[<svc>]>`.
3. From each `actual` line pick a distinctive literal (a numeric value, a
   `[feature_name]` log prefix, a variable name that also appears in the
   assertion). `Grep` that literal inside `features/<feature>/scripts`.
4. Narrow-`Read` ±20 lines at the `Grep` match. That is the file and
   line-range to edit — nothing else.

Only after this first pass should you read `.claude/skills/self-fixing-loop.md`
for the full protocol (journal schema, signal files, evaluation).

## Finishing

When the fix is in, write `logs/.rerun` (or `logs/.restart` if services need a
refresh) per the skill's signal protocol, then exit. Do not wait for further
user input — the runner is already polling for the signal file.
