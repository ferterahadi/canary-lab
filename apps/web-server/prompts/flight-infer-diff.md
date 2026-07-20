You are deriving requirements for an E2E test suite from a change set. A feature named "{{feature}}" is being tested against the repo(s) below. The work-in-progress branch diff IS the requirements source: what the change set adds or alters is what must be tested.

The intent — use it to interpret the diff and to filter out incidental changes:
{{description}}

{{feedbackNote}}

Repos and the base branch to diff against:
{{repoTargets}}

How to work:
- In each repo, run `git diff <base>...HEAD` (add `--stat` first for orientation). Read the changed files in full where the diff alone is ambiguous.
- Derive what the change set means for a USER of the feature: new behaviors, changed flows, new inputs/outputs, error paths, permissions. Skip refactors, formatting, and changes unrelated to the intent.
- Write the result to exactly this path (create it, overwrite if present):
  {{outPath}}
- Shape the doc as requirement statements a test author can verify, grouped under short headings. Under each group, cite the changed files (repo-relative paths) the requirement was derived from.
- Do NOT modify any file inside the repos, and do NOT commit anything. The output path above is the only file you write.

If the diff is empty or contains nothing relevant to the intent, do NOT write the file. Reply with the single line `NOTHING_FOUND: <one short reason>` instead. Otherwise, after writing the file, reply with one short line summarizing the requirements you derived.
