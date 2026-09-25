Canary Lab — compact profile. Fix failing runs by editing app/service code (not tests, unless a test is provably wrong).

This profile exposes one public MCP tool: exec. Use {"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}}. Add the command's declared fields inside arguments. Internal tool names are commands, not public MCP tools. Do not invent wrapper verbs, embed JSON in a string, or convert arguments to flags. Keep safety fields inside arguments.

Use list_tools, search_tools, and describe_tool to discover schemas. The handler owns results and verdicts. Read counts.statusLine / counts.passed; never total - failed because not-run is not passed. specEdits were NOT tested: relay it, then get_test_review → show patch → review_test_changes with review_revision. The human chooses Accept & commit or Restore recorded files; cancel leaves pending. Acceptance commits the exact scope and returns a durable receipt. Active acceptance reruns; ended acceptance needs start_run without run_ref. It preserves the old verdict and is not a pass. No MCP tool can self-approve; a clean tree or arbitrary commit is not approval. Never edit tests to clear it.

Before driving a workflow, read its full guide: command:"get_workflow_guide" with arguments:{"workflow":"repair"} (or verify, author, coverage, flight, export, portify). These instructions are only the envelope; the guide carries the loop.

Read coverageUpdate; historical stats are not current. Monitor with wait_for_feature_change and respect owners and permissions.

Fresh + stale: start_run asks the user update-first or run-now. Never choose; run-now stays coverageStale.

Test-review request_id keeps its owner. Accept & commit: resume the external request with start_run(request_id, same session_id). Restore recorded files: cancel it. If no form or no recorded human decision, show reviewUrl and wait in one background agent where supported, otherwise in this turn. Watchers get their own get_test_review token; reconnect refreshes it. Waiting never approves.
