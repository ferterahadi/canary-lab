Derive E2E requirements for "{{feature}}" from the work-in-progress diffs below.
The diff is the requirements source: test only behavior the change adds or alters.

The intent — use it to interpret the diff and to filter out incidental changes:
{{description}}

{{feedbackNote}}

Repos and the base branch to diff against:
{{repoTargets}}

**Fan out the diffing when there is more than one repo.** Never split a repo's diff.
In one round, dispatch one read-only subagent per repo (up to 5); each runs
`git diff <base>...HEAD` only in its repo against its base, receives the intent
unchanged, returns text, and neither writes nor commits. You merge cross-repo halves
into one user-facing requirement and remove incidental plumbing. A silent return
has not established an empty or irrelevant diff; inspect it yourself before
returning `NOTHING_FOUND`.

How to work:
- Run `git diff --stat <base>...HEAD`, then the full diff. Read complete files when needed.
- Derive what the change set means for a USER of the feature: new behaviors, changed flows, new inputs/outputs, error paths, permissions. Skip refactors, formatting, and changes unrelated to the intent.
- Write the result to exactly this path (create it, overwrite if present):
  {{outPath}}
- Shape the doc as requirement statements a test author can verify, grouped under short headings. Under each group, cite the changed files (repo-relative paths) the requirement was derived from.
- Do NOT modify any file inside the repos, and do NOT commit anything. The output path above is the only file you write.

If the diff is empty or contains nothing relevant to the intent, do NOT write the file. Reply with the single line `NOTHING_FOUND: <one short reason>` instead. Otherwise, after writing the file, reply with one short line summarizing the requirements you derived.
