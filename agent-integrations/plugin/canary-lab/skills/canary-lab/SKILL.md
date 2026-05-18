---
name: Canary Lab
description: Use when running, verifying, debugging, or healing Canary Lab features through Canary Lab MCP tools.
type: skill
---

# Canary Lab

Use the Canary Lab MCP tools in this order:

1. `list_features`
2. `start_run` with `claim_heal: true` and a stable `session_id`
3. `wait_for_heal_task`
4. fix application code when `needs_heal` is returned
5. `write_journal`
6. `signal_run` with `rerun` or `restart`
7. repeat from `wait_for_heal_task` until passed or terminal failure

Fix app/service code, not tests, unless the test is provably wrong. Keep the same `session_id` for the whole conversation.
