---
description: Self-heal the most recent Playwright failure
---

The canary-lab runner just observed failing Playwright tests and launched you
in auto-heal mode. The full workflow lives in `.codex/self-fixing-loop.md` —
read it after the first-pass triage below, then follow Steps 1–6 exactly. If
you need project context beyond the skill, consult `AGENTS.md` only when the
first-pass triage stalls.

## Hard rules (before your first tool call)

1. **No orientation commands.** Do not `ls`, do not glob the feature tree,
   do not open `AGENTS.md` or `README.md` up front. The failure already
   names the feature. Orientation burns tokens and delays the fix.
2. **No full-file reads of implementation files.** Always `rg` a distinctive
   literal first (from `failed[].logs[<svc>]` or the test assertion), then
   narrow-read ±20 lines at the match. No exceptions — including
   small-looking files.
3. **Service-log chunk is ground truth.** `error.message` tells you *what's
   wrong*, the log chunk in `failed[].logs[<svc>]` tells you *where*. Never
   reason from the assertion alone.
4. **Combine root causes.** If multiple failures share evidence (same
   feature, same log prefix), write one journal entry and one fix pass.

## Prescribed first steps

Execute these in order, stop only if the previous step yields the answer:

1. Read `logs/diagnosis-journal.json` and `logs/signal-history.json` (if
   they exist). Skip any hypothesis already tried.
2. Read `logs/e2e-summary.json`. For each `failed[]` entry, write out:
   `expected: <from error.message> | actual: <from logs[<svc>]>`.
3. From each `actual` line pick a distinctive literal (a numeric value, a
   `[feature_name]` log prefix, a variable name that also appears in the
   assertion). `rg` that literal inside `features/<feature>/scripts`.
4. Narrow-read ±20 lines at the `rg` match. That is the file and
   line-range to edit — nothing else.

Only after this first pass should you open `.codex/self-fixing-loop.md` for
the full protocol (journal schema, signal files, evaluation).

## Finishing

When the fix is in, write `logs/.rerun` (or `logs/.restart` if services need a
refresh) per the skill's signal protocol, then exit. Do not wait for further
user input — the runner is already polling for the signal file.
