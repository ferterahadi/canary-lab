---
name: canary-lab-portify
description: Use when making a Canary Lab feature concurrency-ready — "portify <feature>", "make the ports injectable", "why can't these run concurrently", "undo the portification" — through the portify MCP tools (start/submit_external_portify, get_portify, save_portify, cancel_portify, remove_portification, list_portify_status). This client edits the listeners in a scratch worktree; Canary Lab verifies with a concurrent double-boot and owns the verdict.
type: skill
---

# Canary Lab — Portify (Concurrency-Readiness)

Connect with the `portify` MCP profile (`npx canary-lab mcp --profile
portify`); the composite `full` profile carries the same tools. Portify makes
a feature's ports injectable so it can boot concurrently (benchmark arms /
parallel runs). The double-boot verify is the success predicate — Canary Lab
owns the verdict.

## Workspace Bootstrap

1. Read `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`); one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`.
2. Check `/mcp/health` on the UI's port (default `7421`; a project may pin its own in `canary-lab.config.json` — `npx canary-lab mcp doctor` discovers the active URL). Confirm `projectRoot` matches the selected workspace.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal.

## Portify Loop

1. Port-ify it YOURSELF (no local agent): `start_external_portify(feature)` sets up scratch worktree(s) and returns `targets[]` (edit paths) + `configPath` + instructions; edit the listeners IN PLACE to read an injected port, declare the matching `ports` slots in the config, then `submit_external_portify(workflowId)` — Canary boots the stack twice concurrently to verify. On `ready-to-save` call `save_portify(workflowId, confirm: true)`; if it returns to `editing`, read `verification.failureDetail`, fix the worktree, and `submit_external_portify` again (re-edit + re-submit is the revision loop — unbounded). `get_portify(workflowId)` re-reads status + the verification result at any time (diff omitted by default; `includeDiff: true` inlines it). `cancel_portify(workflowId, confirm: true)` discards it.
2. One workflow PER FEATURE (a second start on the same feature is a 409); DIFFERENT features port-ify concurrently up to a resource cap, so to portify several features at once fan out a subagent per feature — at capacity `start_external_portify` returns a 429, so wait for one to finish (or save/cancel it) and retry. The GUI shows each live as an external session; `list_portify_status` shows which features are portified. Within ONE feature that has multiple repos, FAN OUT the per-repo edits across subagents, then submit once.
3. Already env-driven? If the repo ALREADY reads injected ports (e.g. it was portified for another feature, or the listeners are committed env-driven), no source edit is needed — just declare the matching `ports` slots in the config and `submit_external_portify`. The double-boot still verifies the concurrent boot, and save records an EMPTY overlay (a no-op at run time). An empty diff is only rejected when the boot also fails (the listeners genuinely don't read the injected ports yet).
4. Borrowed start: if ANOTHER feature already saved an overlay for the same app, Canary pre-applies that patch into your scratch worktree at setup (the returned instructions say so). Review the existing edits rather than rewriting from scratch — usually you only add this feature's `ports` slots — then submit. The borrowed lines are captured into THIS feature's own overlay, so it stays self-contained.
5. Saving captures the verified edits as an EPHEMERAL OVERLAY under `features/<feature>/portify/` — nothing committed or merged, so the product repo stays pristine; each run applies the overlay into a fresh per-run worktree (disjoint ports) before boot and reverse-applies at teardown. If the overlay later stops applying (the repo moved under it), the run fails loudly asking you to re-portify (`start_external_portify`, or the GUI).
6. Undo it: `remove_portification(feature, confirm: true)` reverts the feature config (the declared `ports` slots + `${port.x}` health-check rewrites, restored from the snapshot saved with the overlay) and deletes the overlay, so the feature is no longer portified. Re-run `start_external_portify` (or the GUI) to redo.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Edit only inside the returned scratch worktree paths — never the user's checked-out product repo.
- Save/cancel/remove are confirm-gated; pass the confirmation only when the user asked for that action.
