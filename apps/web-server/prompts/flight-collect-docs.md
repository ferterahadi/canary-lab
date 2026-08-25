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
- Search READMEs, docs, ADRs, API specs, route documentation, and behavior-revealing config. Read code when docs are thin; capture what users observe, not implementation.
- Keep ONLY material relevant to the intent. A repo's docs folder usually covers many unrelated subsystems — do not sweep them in. If a doc is 90% unrelated, extract the relevant 10%.
- Write the result to exactly this path (create it, overwrite if present):
  {{outPath}}
- Group verifiable behaviors, flows, edge cases, and errors under short headings. Cite repo-relative sources per group.
- Do NOT modify any file inside the repos. The output path above is the only file you write.

If you find no material relevant to the intent anywhere, do NOT write the file. Reply with the single line `NOTHING_FOUND: <one short reason>` instead. Otherwise, after writing the file, reply with one short line summarizing what you collected and from where.
