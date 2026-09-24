Gather requirements for the E2E feature "{{feature}}" from the repos below and
distill them into one Markdown document.

The intent — your relevance filter for everything you read:
{{description}}

{{feedbackNote}}

Repos to search:
{{repoPaths}}

**Fan out the search when there is more than one repo.** Never split a repo. In one
round, dispatch one read-only subagent per repo (up to 5); each searches only its
path, receives the intent unchanged, returns extracted text, and writes nothing.
The output path is yours alone. You merge duplicate expectations and make the final
relevance cut. A silent return has not established that its repo has no relevant
material; search it yourself before returning `NOTHING_FOUND`.

How to work:
- Discover documents before asking the user. Search READMEs, docs, ADRs, API specs, route documentation, and explicit references in the intent. Use clearly relevant, authorized documents automatically; a confidence percentage or matching filename is not evidence. Honor prior user choices and explicit source precedence.
- Read code only to locate or understand a documented requirement. Do not infer requirements from implementation or tests when docs are thin; inference requires the user's authorization through infer-from-diff (or explicit yolo).
- Treat an explicit scope statement (for example, "these are the whole feature") as authoritative. Do not promote incidental code or config outside that scope into a behavior.
- Keep service setup facts out of this requirements document: fixed or hardcoded ports, start commands, env-file or env-var loading (including their absence), process topology, and bootstrap wiring belong to Repo scan and Parallel setup, not the coverage ledger. Do not manufacture a user-visible happy path from successful startup to make one testable.
- An absence found only in code or config (for example, no env file, database, or telemetry) describes the current implementation, not a requirement.
- Keep ONLY material relevant to the intent. A repo's docs folder usually covers many unrelated subsystems — do not sweep them in. If a doc is 90% unrelated, extract the relevant 10%.
- Write the result to exactly this path (create it, overwrite if present):
  {{outPath}}
- Group verifiable behaviors, flows, edge cases, and errors under short headings. Cite repo-relative sources per group.
- Do NOT modify any file inside the repos. The output path above is the only file you write.

If documents are missing, ambiguous, or conflicting after the search, do NOT write the file or invent a resolution. Return JSON with `document_resolution`: `{status:"missing",searched:[paths examined],reason}` or `{status:"ambiguous"|"conflicting",searched:[paths examined],question,candidates:[{label,sources:[{path,sha256,reason}]}]}`. Provide 1–5 candidates for ambiguity, or 2–5 for a conflict; use absolute paths, SHA-256 of each source's bytes, and reasons identifying the relevant requirements. The flight keeps this question pending for user input. An external client can instead pass that same `document_resolution` directly to `respond_flight_checkpoint` without a choice to request MCP 2.0 elicitation. Do not start another coverage job. The older `NOTHING_FOUND: <one short reason>` response is also accepted for missing material.

Otherwise, after writing the document, draft its structured requirements in this
same session. Follow the summary instructions below, reading the completed output
and every other listed document. Return that JSON as your final answer (on `data`
when responding to a Flight checkpoint). Canary validates the draft and preserves
requirement ids in the next stage. Do not write the generated summary files.

{{summaryPrompt}}
