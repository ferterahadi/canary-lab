---
name: cl_verify-changes
description: Use before claiming any canary-lab change works, when deciding which checks a change needs, or when tests/coverage behave strangely (coverage .tmp ENOENT, template edits not showing up, UI server running stale code).
---

# Verifying Canary Lab Changes

Pick the lowest tier that actually exercises the change, then run every tier at or
below it. "Tests pass" at the wrong tier proves nothing — template and server changes
have failure modes unit tests can't see.

## The ladder

### Tier 1 — always: unit tests + typecheck

```bash
npx vitest run
npx tsc -p tsconfig.build.json --noEmit
```

- Tests are co-located `*.test.ts`; component tests use happy-dom.
- **Never add `/* v8 ignore */` pragmas** — write a real test or use a config-level
  exclude.
- Coverage (`npm run test:coverage`) has a known race: intermittent ENOENT on
  `coverage/.tmp`. Recover with `rm -rf coverage && npx vitest run --coverage --no-file-parallelism`.

### Tier 2 — templates, packaging, exports: smoke the tarball

Changes under `templates/`, `tools/*.mjs`, or `package.json` exports only reach
consumers through the build (`templates/project/` → `dist/templates/`). Run:

```bash
npm run smoke:pack
```

### Tier 3 — live confirmation of `apps/web-server/**` or `apps/web/**`

Source edits only take effect in a real workspace after the rebuild + reinstall +
server-restart cycle (`canary-apply`).

**HARD RULE: never run the canary-apply cycle yourself — the user runs it.** Stop and
ask the user to run `canary-apply` and restart the UI. After they confirm, verify the
server picked up the change: read the port from
`~/Documents/canary-lab-workspace/canary-lab.config.json` (default 7421) and hit
`GET /mcp/health`, then exercise the changed surface.

### Tier 4 — heal-loop semantics

Changes to the external run loop (claim, wait, signal, collision, boot sessions) need
an end-to-end pass: drive the MCP loop against the `broken_todo_api` sample
(`start_run` with `claim_heal` → `wait_for_heal_task` → fix → `signal_run` → wait).
The old `tools/verify-external-heal.sh` REST smoke was removed — the MCP loop is the
current path.

## Quick reference

| Change touches | Run tiers |
| --- | --- |
| `shared/`, `apps/web-server/lib/**` logic | 1 |
| `templates/`, `tools/`, packaging | 1 + 2 |
| `apps/web-server/**` / `apps/web/**` needing live proof | 1 (+2 if templates) + 3 |
| MCP run-loop semantics | 1 + 3 + 4, plus `cl_sync-agent-surfaces` |

## Common mistakes

| Mistake | Reality |
| --- | --- |
| Running `canary-apply` / killing the workspace server yourself | The user controls that cycle — always hand off |
| Verifying a template edit with unit tests only | Consumers get `dist/templates/`; only `smoke:pack` proves the copy |
| Adding v8 ignore pragmas to make coverage pass | Forbidden in this repo; write the test |
| Retrying flaky coverage as-is | Known `.tmp` race — use `--no-file-parallelism` |
