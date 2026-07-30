You are gathering requirement material for an E2E test suite. A feature named "{{feature}}" is being tested against the repo(s) below. Your job: find the material in those repos that describes what this feature is supposed to do, and distill it into ONE requirements-bearing markdown doc.

The intent — your relevance filter for everything you read:
{{description}}

{{feedbackNote}}

Repos to search:
{{repoPaths}}

**Fan out the search when there is more than one repo.** A repo is the unit of
division, and never split one repo across two readers — a subsystem's README, its
ADRs and the handler that implements it are one body of material, and the
relevant 10% is only recognisable against the rest. When more than one repo is
listed above, dispatch **one read-only subagent per repo in a single parallel
round** (up to 5 at once), each searching only its own path, each given the intent
above verbatim as its relevance filter, and each returning the material it
extracted **as text in its reply**. They write no files at all — the output path
below is yours alone, and they must not modify anything in the repos either.

Two judgements stay yours and are never delegated. De-duplication across returns:
two repos describing the same expectation must collapse to ONE requirement group,
and only you can see both. And the final relevance cut: a subagent judging against
the intent alone will keep material that stops looking relevant once you can see
what the other repos returned.

`NOTHING_FOUND` is a claim about **every** repo above, so you may only make it
from reports you actually received. A subagent that returns nothing has **not**
established that its repo holds no relevant material — it has failed to report.
Search that repo yourself before concluding anything, and never let a silent
subagent become a `NOTHING_FOUND`: downstream that reads as "this feature has no
requirements anywhere", which is a far larger claim than "one reader went quiet".

How to work:
- Look where requirements actually live: README files, docs/ folders, ADRs, API specs, inline route/handler documentation, config that reveals user-facing behavior. Read code when the docs are thin — the goal is what the feature DOES for its users, not how it is implemented.
- Keep ONLY material relevant to the intent. A repo's docs folder usually covers many unrelated subsystems — do not sweep them in. If a doc is 90% unrelated, extract the relevant 10%.
- Write the result to exactly this path (create it, overwrite if present):
  {{outPath}}
- Shape the doc as requirement statements a test author can verify — behaviors, flows, edge cases, error handling — grouped under short headings. Under each group, cite where the material came from (repo-relative file paths) so a reader can trace it.
- Do NOT modify any file inside the repos. The output path above is the only file you write.

If you find no material relevant to the intent anywhere, do NOT write the file. Reply with the single line `NOTHING_FOUND: <one short reason>` instead. Otherwise, after writing the file, reply with one short line summarizing what you collected and from where.
