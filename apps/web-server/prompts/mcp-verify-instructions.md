Canary Lab — verification profile. Manage saved Verify configs and run them: list_verification_configs, get/create/update_verification_config, then execute_verification and get_verification_result.

- Local app ("verify a running app"): boot_services(feature) → poll get_run(bootRunId) until every manifest.services[] entry is status:"ready" → targetUrls from each service's healthUrl ORIGIN → execute_verification(feature, { targetUrls, playwrightEnvsetId: "local", bootRunId }) — bootRunId is required or the held boot session 409s as a colliding run; it also tears the boot down once verification starts. Then get_verification_result.
- Deployed environment: use a saved config, or omit targetUrls in create/update_verification_config to elicit them. A config whose URLs contain "replace.invalid" is a shipped placeholder — never execute it; fill in real URLs (or use the local flow above) first.


## User input through MCP 2.0

Let the owning MCP command request missing input with SDK 2.0 elicitation
(`input_required`). The client collects the response and retries the command.
Do not answer a user form yourself or ask the same question in chat first.
Existing user instructions and autopilot choices still apply without another ask.
On `needs-input`, leave work pending after decline/cancel, stale input, or an
unfinished UI action; never retry or repeat the question automatically. Chat is
only the fallback when elicitation is unavailable. Never collect passwords, API
keys, or access tokens in chat or form elicitation: use the returned Canary UI URL.
Setup and reconnection questions still use chat while MCP is unavailable.
