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

1. Read `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`); one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`.
2. Check `/mcp/health` on the UI's port: read `port` from the workspace's `canary-lab.config.json` (fallback `7421`), then `curl -s http://127.0.0.1:<port>/mcp/health` — success is a JSON response. Confirm `projectRoot` matches the selected workspace.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.

## Export Loop

1. After the relevant run is terminal (passed, failed, or aborted), call `start_external_evaluation_export` with the run id and requested language. If the user asks to export a failed or aborted run as-is, preserve that status in the report instead of trying to heal first. (`list_runs` / `get_run` find the run id when the user names a feature instead of a run.)
2. `start_external_evaluation_export` does not embed the run snapshot — call `get_run(runId)` for the summary/failures while authoring. Use the returned `reportSchema` to write the evaluation report/archive wording in this client.
3. Call `submit_external_evaluation_export` with the `taskId` returned by `start_external_evaluation_export` (`task.taskId`), plus either `textSlots[]` or `rewrite`. If you submit a `rewrite`, `rewrite.cases` must keep the **exact count and order** of the template's `cases[]` — one case per run entry; **never merge, dedupe, or drop** skipped or duplicate run entries (prefer editing `textSlots[]`, which keeps the count correct automatically). The result includes an `evaluation` digest (featureTitle, summary, per-case title + confidence) — **relay it to the user in chat**; don't just say it's available in the UI.
4. Use `get_evaluation_export`, `list_evaluation_exports`, or `download_evaluation_export` for status and the full rendered `evaluation.html`. Canary Lab stores the artifact, but it does not rewrite, translate, or generate the report with an internal agent for external exports.
5. End by pointing the user at the archive itself — opening `evaluation.html` (and the video playback for browser-driven tests) is the review step the export exists for.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Never heal or re-run just to make an export look better — export the run the user named, status preserved.
