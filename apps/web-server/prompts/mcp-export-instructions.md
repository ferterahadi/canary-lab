Canary Lab — export profile. Produce the evaluation archive for a terminal run; Canary Lab renders the final report, this client writes the reasoning.

- Evaluation export (run must be terminal, not necessarily passing): start_external_evaluation_export returns editable textSlots/rewrite; submit through submit_external_evaluation_export (Canary renders the final evaluation.html). If you submit a rewrite, rewrite.cases must keep the EXACT count and order of the provided template — one case per run entry; never merge/dedupe/drop skipped or duplicate runs (textSlots[] keeps the count correct automatically). submit returns an `evaluation` digest (featureTitle, summary, per-case verdicts) plus `archivePath`, the exact absolute path of the zip Canary already wrote — RELAY both to the user in chat. Do not end with `npx canary-lab export download` when `archivePath` is present; the file is already there. get/list recover status and that path; download_evaluation_export is only for a client that cannot access the server filesystem and explicitly needs base64 (it also carries the full certificate). A completed task carries a `certificate` digest and `certificatePath`: the internal behavior certificate (stored separately from the downloadable archive) proves which tests ran from which suite snapshot and what they asserted — relay `certificate.statement` and `certificate.notProven` as written; it does NOT prove the absence of weakening, and no number in it is yours to round. If the run failed/aborted and the user wants it exported as-is, preserve that status in the wording — don't heal first.

Full guide: get_workflow_guide(workflow:"export").

<!-- initialize-cut -->

## Shared form approvals

Use the native Canary connector in the requesting chat so SDK 2.0 elicitation
(`input_required`) reaches the human there. Do not substitute a shell MCP client,
answer a form yourself, or recreate the question in chat. Existing explicit
instructions and autopilot choices still apply without another ask.

Form decisions have one shared record. The native form links to the same approval
in Canary Notifications, also surfaced above the Flight page. On `needs-input`
with `approvalId` and `reviewUrl`, show that link and call `wait_for_approval` with
the ID; repeat on `still_waiting`. The human answers once in either surface.
A browser answer resolves the server decision; some clients keep their native
form visible until the human dismisses it. Dismissal then returns the stored
result. Client decline/cancel alone does not represent a human decision.

Without an `approvalId`, leave `needs-input` pending after decline/cancel, stale
input, or an unfinished UI action; do not automatically retry or repeat the
question. Setup/reconnection can use chat while MCP is unavailable. Never collect
passwords, API keys, or access tokens in chat or form elicitation; use the returned
Canary UI URL for secret entry.
