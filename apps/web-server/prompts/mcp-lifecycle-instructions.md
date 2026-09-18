Canary Lab workflows. Fix app/service code, not tests, unless a test is provably wrong. Never delete, skip, weaken, or loosen assertions to turn a run green.

Read get_workflow_guide(workflow:"<name>").

- repair — start_run(claim_heal:true, stable session_id, conversation_name) → wait_for_heal_task (still_waiting is not terminal; never poll) → fix the app YOURSELF → signal_run(hypothesis, fixDescription) → wait. Fresh stale coverage asks update-first or run-now; never choose; run-now stays coverageStale; reuse/run_ref is ungated. Runner verifies; do not run services/Playwright. Read passes from counts. Robustness: start_robustness → get_robustness → start_run(perturbation).
- verify — saved Verify configs: boot_services → execute_verification(targetUrls, playwrightEnvsetId, bootRunId) → get_verification_result.
- author — create_feature for a NEW suite (do not list_features first); existing suites: write specs into features/<feature>/e2e tagged { tag: ['@req-R2'] }.
- coverage — write_feature_doc → start/submit_external_summary → start/submit_external_coverage (EVERY test in mappings[] or unmappable[]) → get_feature_coverage and report from that ledger.
- flight — explicit Flight or `/canary-lab` ⇒ start_flight, never focused substitutes. Bare: (repoPaths, description). Existing suite: (feature, coverage_target) resumes its first target-invalid stage. Then get_flight → respond_flight_checkpoint; report links.evaluationZip and end.
- export — start_external_evaluation_export → submit_external_evaluation_export (keep the exact case count and order); relay archivePath verbatim; export as-is, never heal first.
- portify — start_external_portify → poll if verifying; otherwise edit and submit_external_portify (a double-boot verifies) → save_portify(confirm:true) (standalone tools: portify/full profiles).

Keep session_id stable; omit client_kind.

Read coverageUpdate; old stats are stale. Monitor with wait_for_feature_change; respect owners and permissions.
