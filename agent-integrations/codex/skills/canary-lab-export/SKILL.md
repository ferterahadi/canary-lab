---
name: canary-lab-export
description: Use when exporting a Canary Lab run as an evaluation — "export the evaluation", "produce the report for run 7cvh", "give me the evaluation archive", "review what the run proved" — through the export MCP tools (start/submit_external_evaluation_export, get/list/download_evaluation_export). The run must be terminal (passed, failed, or aborted).
type: skill
---

# Canary Lab — Evaluation Export

This client writes the reasoning; Canary Lab renders the final
`evaluation.html` + archive. These tools arrive via the Canary Lab MCP
server. If this client is already connected (the plugin connects with
`full`), skip this step. To configure a connection manually: `npx canary-lab
mcp --profile export` (the composite `lifecycle`/`full` profiles carry the
same tools). The evaluation export is the deliverable of a run: a
self-contained archive (per-test reasoning, verdicts, Playwright artifacts —
video playback where the tests drive a browser) the user reviews from
`evaluation.html` without any Canary Lab UI running.

## Workspace Bootstrap

1. Find the LIVE server first: read `~/.canary-lab/active-servers.json`, which records `projectRoot`, `port` and `pid` for every UI that registered. A stopped server's entry LINGERS — the file is only rewritten when the next server registers — so an entry is a candidate, not proof: the health check below is what confirms it. One entry → that is your server and its `port`. Several → take the one whose `projectRoot` is the workspace the user means. None → fall back to `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`): one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`. Do NOT start from a guessed port.
2. Then CONFIRM it is the right server: `curl -s http://127.0.0.1:<port>/mcp/health` and check that `projectRoot` is the workspace you intended. A healthy response does **not** settle the question on its own — a stale UI left behind by a demo or a tarball smoke test answers a port just as convincingly as the right one, and that is how a flight ends up running in someone's throwaway workspace. `projectRoot` matches what you intended → continue and tell the user which workspace. It names a DIFFERENT workspace → this is the wrong server; go back to step 1 rather than adopting it. It is under a temp directory (`/tmp`, `/private/var/folders`, `%TEMP%`) → never auto-select it; those are throwaway demo workspaces, so use one only when the user names it explicitly. Only when no live server serves the workspace you want does one need starting.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.
4. A healthy `/mcp/health` means these tools are live even when they look absent from this session. If the Canary Lab MCP tools seem missing — e.g. a tool search returns no `start_external_evaluation_export` match — they are usually **already loaded**: searches that index only deferred tools say nothing about loaded ones. Call `list_features` directly before concluding anything. Only if that call errors as an unknown tool is the server really not connected — ask the user to connect it (`npx canary-lab mcp`, or reconnect this client's MCP integration), then retry. Never drive `/mcp` with a hand-written HTTP/JSON-RPC client (curl included; the health check above is the only direct HTTP use): a hand-rolled client bypasses the connection's client detection, so the Canary Lab UI mis-brands the session, and it loses the session and reconnect handling these tools rely on.

## Arguments

An invocation argument (`/canary-lab-export <suite>` — the Getting Started
guide emits exactly this shape) is a suite (feature) name in the connected
workspace: export that suite's most recent completed test run, per step 1.

## Export Loop

1. After the relevant run is terminal (passed, failed, or aborted), call `start_external_evaluation_export` with the run id and requested language. If the user asks to export a failed or aborted run as-is, preserve that status in the report instead of trying to heal first. When the user names a feature instead of a run, `list_runs(feature)` finds the candidates: pick the **newest terminal run that actually ran tests** — `executionType` `run` (or `verify`), never `boot` or `benchmark` (a fresh workspace ships one aborted boot session, which has no test results; the server rejects exporting it). If the feature has no such run yet, do NOT export anything — tell the user the suite has to run first (`canary-lab-run` / `start_run`), or offer to run it.
2. `start_external_evaluation_export` does not embed the run snapshot — call `get_run(runId)` for the summary/failures while authoring. Use the returned `reportSchema` to write the evaluation report/archive wording in this client. If it returns `type: "getting_started_busy"`, a Getting Started demo already owns the workspace — follow the active target it returns; do not start another workflow. While you author, the user can watch the export live in the Canary Lab UI on the suite's Flight page (Evaluation export stage) — that view is read-only while this client drives.
3. Call `submit_external_evaluation_export` with the `taskId` returned by `start_external_evaluation_export` (`task.taskId`), plus either `textSlots[]` or `rewrite`. If you submit a `rewrite`, `rewrite.cases` must keep the **exact count and order** of the template's `cases[]` — one case per run entry; **never merge, dedupe, or drop** skipped or duplicate run entries (prefer editing `textSlots[]`, which keeps the count correct automatically). The result includes an `evaluation` digest (featureTitle, summary, per-case title + confidence) — **relay it to the user in chat**; don't just say it's available in the UI.
4. Use `get_evaluation_export`, `list_evaluation_exports`, or `download_evaluation_export` for status and the full rendered `evaluation.html`. Canary Lab stores the artifact, but it does not rewrite, translate, or generate the report with an internal agent for external exports.
5. End by pointing the user at the archive itself — opening `evaluation.html` (and the video playback for browser-driven tests) is the review step the export exists for.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Never heal or re-run just to make an export look better — export the run the user named, status preserved.
