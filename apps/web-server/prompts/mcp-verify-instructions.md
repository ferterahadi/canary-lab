Canary Lab — verification profile. Manage saved Verify configs and run them: list_verification_configs, get/create/update_verification_config, then execute_verification and get_verification_result.

Choose Verify, not start_run, whenever the target is a deployed, staging or live host the suite does not boot: a run's repair cycle edits local code that host never reads.

- Local app ("verify a running app"): boot_services(feature) → poll get_run(bootRunId) until every manifest.services[] entry is status:"ready" → targetUrls from each service's healthUrl ORIGIN → execute_verification(feature, { targetUrls, playwrightEnvsetId: "local", bootRunId }) — bootRunId is required or the held boot session 409s as a colliding run; it also tears the boot down once verification starts. Then get_verification_result.
- Deployed environment: use a saved config, or omit targetUrls in create/update_verification_config to elicit them. A config whose URLs contain "replace.invalid" is a shipped placeholder — never execute it; fill in real URLs (or use the local flow above) first.


Full guide: get_workflow_guide(workflow:"verify").

<!-- initialize-cut -->

## User input through MCP 2.0

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
