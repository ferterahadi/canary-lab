Canary Lab — compact profile. Fix failing runs by editing app/service code (not tests, unless a test is provably wrong).

This profile exposes one public MCP tool: exec. Use {"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}}. Internal names are commands, not public tools. Keep fields (including safety fields) inside arguments; no wrapper verbs, stringified JSON, or flags.

Discover schemas: list_tools, search_tools, describe_tool. Read counts.statusLine / counts.passed; never total - failed (not-run ≠ passed). specEdits were NOT tested: relay it, then get_test_review → show patch → review_test_changes with review_revision. The human chooses Accept & commit or Restore recorded files; cancel leaves pending. Acceptance commits reviewed bytes and records a receipt. Active acceptance reruns. Ended acceptance starts nothing: continuation-ready permits explicit start_run(run_ref); new-run-required needs a fresh approved run with continuationOf. Approval is not a pass. No MCP tool can self-approve; a clean tree or arbitrary commit is not approval. Never edit tests to clear it.

First read the workflow guide: command:"get_workflow_guide" with arguments:{"workflow":"repair"} (or verify, author, coverage, flight, export, portify). Retry the same run; use run_ref for a particular ID.

Read coverageUpdate/runUpdate. Monitor wait_for_feature_change; respect owners and permissions.

Use the native Canary connector. Fresh + stale: start_run asks update-first or run-now. Never choose; run-now stays coverageStale. With approvalId, show reviewUrl and wait_for_approval; repeat still_waiting. The human answers in chat or Notifications.

Test-review request_id keeps its owner. Accept & commit: resume the external request with start_run(request_id, same session_id). Restore recorded files: cancel it. If no form or no recorded human decision, show reviewUrl and wait in one background agent where supported, otherwise in this turn. Watchers get their own get_test_review token; reconnect refreshes it. Waiting never approves.
