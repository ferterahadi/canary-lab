You are deriving requirements for an E2E test suite from a change set. A feature named "{{feature}}" is being tested against the repo(s) below. The work-in-progress branch diff IS the requirements source: what the change set adds or alters is what must be tested.

The intent — use it to interpret the diff and to filter out incidental changes:
{{description}}

{{feedbackNote}}

Repos and the base branch to diff against:
{{repoTargets}}

**Fan out the diffing when there is more than one repo.** A repo is the unit of
division, and never split one repo's diff across two readers — a changed handler
and the changed model it writes through are one behaviour, and reading half a diff
turns a feature into two unrelated edits. When more than one repo is listed above,
dispatch **one read-only subagent per repo in a single parallel round** (up to 5 at
once), each running `git diff <base>...HEAD` in only its own repo against only its
own base, each given the intent above verbatim as its filter, and each returning
what it derived **as text in its reply**. They write no files and commit nothing.

Joining is yours, and it is more than de-duplication. One user-facing change
routinely spans repos — an endpoint added in the API and the screen that consumes
it in the UI are ONE requirement, reported as two halves by two subagents that
each saw only their own side. Merge those into a single requirement rather than
stating both; a test author given two halves writes two shallow tests instead of
one that proves the flow. The incidental-change filter is also yours to re-apply:
a change that reads as meaningful in isolation is often plumbing for another
repo's change once you can see both.

`NOTHING_FOUND` is a claim about **every** repo above, so you may only make it from
reports you actually received. A subagent that returns nothing has **not**
established that its diff is empty or irrelevant — it has failed to report. Diff
that repo yourself before concluding anything. An empty diff and an unread diff are
indistinguishable downstream, and one of them silently drops requirements.

How to work:
- In each repo, run `git diff <base>...HEAD` (add `--stat` first for orientation). Read the changed files in full where the diff alone is ambiguous.
- Derive what the change set means for a USER of the feature: new behaviors, changed flows, new inputs/outputs, error paths, permissions. Skip refactors, formatting, and changes unrelated to the intent.
- Write the result to exactly this path (create it, overwrite if present):
  {{outPath}}
- Shape the doc as requirement statements a test author can verify, grouped under short headings. Under each group, cite the changed files (repo-relative paths) the requirement was derived from.
- Do NOT modify any file inside the repos, and do NOT commit anything. The output path above is the only file you write.

If the diff is empty or contains nothing relevant to the intent, do NOT write the file. Reply with the single line `NOTHING_FOUND: <one short reason>` instead. Otherwise, after writing the file, reply with one short line summarizing the requirements you derived.
