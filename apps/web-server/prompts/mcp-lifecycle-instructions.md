Canary Lab — lifecycle/full workflows. Fix app/service code, not tests, unless a test is provably wrong. Never delete, skip, weaken, or loosen assertions to turn a run green.

Read get_workflow_guide(workflow:"<name>") before driving it.

- repair — start_run(claim_heal:true, stable session_id, conversation_name) → wait_for_heal_task (blocks; still_waiting is not terminal; never poll get_run_snapshot) → fix the app YOURSELF → signal_run(hypothesis, fixDescription) once per cycle → wait again. The signal requests runner verification; do not start services or run Playwright yourself. Pass counts come from counts.statusLine / counts.passed, never total - failed. Robustness Lab: start_robustness → get_robustness → start_run(perturbation) per finding.
- verify — saved Verify configs: boot_services → execute_verification(targetUrls, playwrightEnvsetId, bootRunId) → get_verification_result.
- author — create_feature for a NEW suite (do not list_features first); existing suites: write specs into features/<feature>/e2e tagged { tag: ['@req-R2'] }.
- coverage — write_feature_doc → start/submit_external_summary → start/submit_external_coverage (EVERY test in mappings[] or unmappable[]) → get_feature_coverage and report from that ledger.
- flight — start_flight(repoPaths, description) → get_flight → respond_flight_checkpoint; YOU drive it and the UI is read-only; when links.evaluationZip appears, report it and end your turn.
- export — start_external_evaluation_export → submit_external_evaluation_export (keep the exact case count and order); relay archivePath verbatim; export as-is, never heal first.
- portify — start_external_portify → poll if verifying; otherwise edit and submit_external_portify (a double-boot verifies) → save_portify(confirm:true) (standalone tools: portify/full profiles).

Reuse one stable session_id for the whole conversation; never pass client_kind.

Read coverageUpdate; monitor via wait_for_feature_change. Respect permissions and owners. Historical stats are not current; see the coverage guide.
