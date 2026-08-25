---
name: canary-lab-export
description: Use when exporting a Canary Lab run as an evaluation — "export the evaluation", "produce the report for run 7cvh", "give me the evaluation archive", "review what the run proved" — through the export MCP tools (start/submit_external_evaluation_export, get/list/download_evaluation_export). The run must be terminal (passed, failed, or aborted).
type: skill
---

# Canary Lab — Evaluation Export

## MCP Invocation

Setup and the plugin expose one public Canary Lab MCP tool: `exec` (usually
rendered as `mcp__Canary_Lab__exec`). Every
Canary Lab tool name below is the exact `command` value, not a separate public
tool. For a feature-scoped command, replace both placeholders in this shape:

```json
{"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}}
```

This is the envelope shape, not every command's complete schema. Add the
fields that command declares inside `arguments`; call `describe_tool` when a
field is uncertain.

Never invent a wrapper verb such as `learn` or `call`, embed JSON in a command
string, or turn arguments into flags. Keep fields such as `confirm: true` inside
`arguments`. Use `list_tools`, `search_tools`, or `describe_tool` as the
`command` when discovery is needed. A deliberately selected focused or `full`
profile still exposes atomic tools for debugging; the setup-installed path is
`compact` + `exec`.

This client writes the reasoning; Canary Lab renders the final
`evaluation.html` + archive. These tools arrive via the Canary Lab MCP
server. If this client is already connected (the plugin connects with
`compact`), skip this step. To configure the same connection manually: `npx
canary-lab mcp --profile compact`. The evaluation export is the deliverable of a run: a
self-contained archive (per-test reasoning, verdicts, Playwright artifacts —
video playback where the tests drive a browser) the user reviews from
`evaluation.html` without any Canary Lab UI running.

## Workspace Bootstrap

1. Find the LIVE server first: read `~/.canary-lab/active-servers.json`, which records `projectRoot`, `port` and `pid` for every UI that registered. A stopped server's entry LINGERS — the file is only rewritten when the next server registers — so an entry is a candidate, not proof: the health check below is what confirms it. One entry → that is your server and its `port`. Several → take the one whose `projectRoot` is the workspace the user means. None → fall back to `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`): one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`. Do NOT start from a guessed port.
2. Then CONFIRM it is the right server: `curl -s http://127.0.0.1:<port>/mcp/health` and check that `projectRoot` is the workspace you intended. A healthy response does **not** settle the question on its own — a stale UI left behind by a demo or a tarball smoke test answers a port just as convincingly as the right one, and that is how a flight ends up running in someone's throwaway workspace. `projectRoot` matches what you intended → continue and tell the user which workspace. It names a DIFFERENT workspace → this is the wrong server; go back to step 1 rather than adopting it. It is under a temp directory (`/tmp`, `/private/var/folders`, `%TEMP%`) → never auto-select it; those are throwaway demo workspaces, so use one only when the user names it explicitly. Only when no live server serves the workspace you want does one need starting.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.
4. A healthy `/mcp/health` means the server is live. On the setup-installed `compact` profile, atomic names such as `get_feature_coverage` are deliberately absent from `tools/list`; only `exec` is public. Call `exec` with `{"command":"list_tools","arguments":{}}` before concluding the connection is missing. Only an unknown-tool error for `exec` means this session is not connected — ask the user to run `npx canary-lab setup --force` and reconnect/restart the client, then retry. Never drive `/mcp` with a hand-written HTTP/JSON-RPC client (curl included; the health check above is the only direct HTTP use): a custom client bypasses client detection and reconnect handling.

## Arguments

An invocation argument (`/canary-lab-export <suite-or-run-id>`) is either a suite
(feature) name or an exact run ID. The Getting Started guide supplies a suite;
`canary-lab-run` hands off the terminal run's ID. Try `get_run(argument)` first:
if it finds a run, export that exact run. Only a `run not found` result means the
argument should be treated as a suite and resolved with `list_runs(feature)`.

## Export Loop

1. After resolving a terminal run (passed, failed, or aborted), call `start_external_evaluation_export` with its exact run ID and the requested language. If the user asks to export a failed or aborted run as-is, preserve that status in the report instead of trying to heal first. When the argument is a feature instead of a run, `list_runs(feature)` finds the candidates: pick the **newest terminal run that actually ran tests** — `executionType` `run` (or `verify`), never `boot` or `benchmark` (a fresh workspace ships one aborted boot session, which has no test results; the server rejects exporting it). If the feature has no such run yet, do NOT export anything — tell the user the suite has to run first (`canary-lab-run` / `start_run`), or offer to run it.
2. `start_external_evaluation_export` does not embed the run snapshot — call `get_run(runId)` for the summary/failures while authoring. Use the returned `reportSchema` to write the evaluation report/archive wording in this client. If it returns `type: "getting_started_busy"`, a Getting Started demo already owns the workspace — follow the active target it returns; do not start another workflow. While you author, the user can watch the export live in the Canary Lab UI on the suite's Flight page (Evaluation export stage) — that view is read-only while this client drives.
3. Call `submit_external_evaluation_export` with the `taskId` returned by `start_external_evaluation_export` (`task.taskId`), plus either `textSlots[]` or `rewrite`. If you submit a `rewrite`, `rewrite.cases` must keep the **exact count and order** of the template's `cases[]` — one case per run entry; **never merge, dedupe, or drop** skipped or duplicate run entries (prefer editing `textSlots[]`, which keeps the count correct automatically). The result includes an `evaluation` digest (featureTitle, summary, per-case title + confidence) — **relay it to the user in chat**; don't just say it's available in the UI.
4. A completed `submit_external_evaluation_export` returns `archivePath`, the exact absolute path of the zip Canary Lab already wrote. Relay that path directly. Use `get_evaluation_export` or `list_evaluation_exports` to recover status and the same path. Do **not** end with `npx canary-lab export download` or ask the user to fetch the file when `archivePath` is present. Call `download_evaluation_export` only when the client cannot access the server filesystem and the user explicitly needs the archive bytes. Canary Lab stores the artifact, but it does not rewrite, translate, or generate the report with an internal agent for external exports.
5. End with the exact `archivePath` and say that `evaluation.html` is inside it — opening that report (and the video playback for browser-driven tests) is the review step the export exists for.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Never heal or re-run just to make an export look better — export the run the user named, status preserved.
