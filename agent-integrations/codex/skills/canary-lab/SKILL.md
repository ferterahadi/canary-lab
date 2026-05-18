---
name: canary-lab
description: Use when the user asks Codex to run, verify, debug, heal, or iterate on Canary Lab features through the Canary Lab MCP tools. Guides Codex through list_features, start_run, wait_for_heal_task, code fixes, write_journal, signal_run, and repeat-until-passing workflows.
---

# Canary Lab

Use Canary Lab MCP tools for Canary Lab runs instead of ad hoc shell commands when available.

## External Run Loop

1. Call `list_features` and choose the requested feature.
2. Call `start_run` with `claim_heal: true`, a stable `session_id`, `client_kind: "codex-cli"` or `"codex-desktop"`, and a useful `conversation_name`.
3. Call `wait_for_heal_task` with the same `session_id`.
4. If it returns `passed`, summarize the result and stop.
5. If it returns `failed`, report the terminal status and relevant failure summary.
6. If it returns `needs_heal`, inspect the returned heal context and the checked-out source code.
7. Fix app/service code, not tests, unless the test is provably wrong.
8. Call `write_journal` with what was diagnosed and changed.
9. Call `signal_run` with `kind: "rerun"` for test-only/app-code fixes that do not need service restart, or `kind: "restart"` when services or env need restarting. Include `files_changed`.
10. Repeat from `wait_for_heal_task` until the run passes or reaches terminal failure.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Do not call `abort_run` unless the user asks or the run is clearly unrecoverable.
- Prefer `get_heal_context` when you need to refresh failure artifacts outside the wait loop.
- Record concise, factual journal notes. Do not paste raw transcripts.
- When the run is waiting for external heal, Canary Lab is the source of truth for status, artifacts, and rerun/restart signals.
