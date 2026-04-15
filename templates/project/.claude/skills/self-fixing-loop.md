---
name: Canary Lab Self-Fixing Loop
description: Canonical Claude workflow for the broken Canary Lab demo. Triggered when the user says "self heal".
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
- The selected feature should be `broken_todo_api`
- The runner should still be open in watch mode

## Read First

- `logs/e2e-summary.json`
- `logs/svc-*.log`
- `features/broken_todo_api/scripts/server.js`

## Rules

- Fix the implementation, not the test
- Do not “solve” the demo by changing the failing assertion
- If running service code changed, run:

```bash
touch logs/.restart
```

- If no restart is needed, run:

```bash
touch logs/.rerun
```

## Copy-Paste Prompt

```text
Please read CLAUDE.md and .claude/skills/self-fixing-loop.md first.
The Canary Lab runner is already in watch mode.
Inspect logs/e2e-summary.json and the service logs, diagnose the failing broken_todo_api test, fix the implementation without changing the test, and then trigger the correct rerun signal.
```
