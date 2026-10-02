Read-only diagnosis assignment: {{failureId}}.

Investigate only this failure. Its diagnostic slice is `{{diagnosticPath}}`:
{{diagnostic}}

Inspect relevant application source under `app/src/`. These source paths are available for investigation; the diagnostic slice does not identify the root cause. Do not read `heal-index.md`, other failure packets, the parent ledger, protected oracle, held-out mutations, original checkout, other attempts, or campaign receipts. Do not launch application code, submit checks, or spawn more agents.

Return the failure ID, evidence, a hypothesis and a concrete proposed patch with exact source edits. Do not edit any files, update the ledger, write a signal, or declare verification complete. The parent applies edits serially and the trusted runner verifies them. An unresolved failure must be reported as unresolved.

The assignment is for {{agent}} with the frozen model {{model}} and effort {{effort}}. Do not change these pins.
