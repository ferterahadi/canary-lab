Canary Lab — lifecycle and full profiles: every workflow on one connection. Fix failing runs by editing app/service code (not tests, unless a test is provably wrong); never delete, skip, weaken, or loosen an assertion to turn a run green.

Before driving a workflow read its guide: get_workflow_guide(workflow:"<name>") — this text is only the index.

- repair — start_run(claim_heal:true, stable session_id, conversation_name) → wait_for_heal_task (blocks; still_waiting is not terminal; never poll get_run_snapshot) → fix the app YOURSELF → signal_run(hypothesis, fixDescription) once per cycle → wait again. The signal requests runner verification; do not start services or run Playwright yourself. Pass counts come from counts.statusLine / counts.passed, never total - failed.
- verify — saved Verify configs: boot_services → execute_verification(targetUrls, playwrightEnvsetId, bootRunId) → get_verification_result.
- author — create_feature for a NEW suite (call it directly; do not list_features to avoid collisions); for an existing suite write specs into features/<feature>/e2e tagged { tag: ['@req-R2'] }.
- coverage — write_feature_doc → start/submit_external_summary → start/submit_external_coverage (EVERY test in mappings[] or unmappable[]) → get_feature_coverage and report from that ledger.
- flight — start_flight(repoPaths, description) → get_flight → respond_flight_checkpoint; YOU drive it and the UI is read-only; when links.evaluationZip appears, report it and end your turn.
- export — start_external_evaluation_export → submit_external_evaluation_export (keep the exact case count and order); relay archivePath verbatim; export as-is, never heal first.
- portify — start_external_portify → edit the listeners → submit_external_portify (a double-boot verifies) → save_portify(confirm:true) (standalone tools: portify/full profiles).

Reuse one stable session_id for the whole conversation; never pass client_kind.
