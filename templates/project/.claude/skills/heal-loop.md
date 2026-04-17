---
description: Self-heal the most recent Playwright failure
---

The canary-lab runner just observed failing Playwright tests and launched you
in auto-heal mode.

Follow `.claude/skills/self-fixing-loop.md` (Phases 0–3) exactly. Start by
reading `logs/e2e-summary.json` for the failure payload, along with
`logs/diagnosis-journal.json` and `logs/signal-history.json` if they exist —
do not repeat a hypothesis that already failed.

When you finish, write `logs/.rerun` (or `logs/.restart` if services need a
refresh) per the skill's signal protocol, then exit. Do not wait for further
user input — the runner is already waiting for the signal file.
