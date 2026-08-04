You are writing the commit message and pull-request description for an automated
repair that Canary Lab's heal agent made to a product repository.

A Playwright test was failing. The heal agent fixed the APPLICATION code so the
test passes — it is never allowed to weaken or edit the test. The diff below is
what it changed. Your job is to explain that change to the human who has to
review it.

## Context

- Feature under test: `{{feature}}`
- Repository: `{{repoName}}`
- Canary Lab run: `{{runId}}`
- Based on commit: `{{baseSha}}`
- Files changed ({{fileCount}}):
{{fileList}}

{{failureEvidence}}

## The diff

```diff
{{diff}}
```

## What to write

Read the diff and describe the actual defect it corrects. The reviewer can see
the diff; what they cannot see is *why* the old code was wrong.

- **commitSubject** — one Conventional Commits line, at most 72 characters, in
  the imperative mood: `fix(scope): correct the thing that was wrong`. Use the
  real scope from the code (a service, module, or route), not the feature name.
  Describe the FIX, never the test: "return 404 for unknown product ids", not
  "make the catalog test pass".
- **commitBody** — 1 to 3 short paragraphs, hard-wrapped at 72 columns. Say what
  was broken, what the user-visible consequence was, and how the change corrects
  it. Do not restate the diff line by line.
- **prTitle** — a plain-English sentence a reviewer can judge from the pull
  request list alone. No Conventional Commits prefix here.
- **prBody** — GitHub-flavoured markdown. Lead with a one-paragraph summary of
  the defect and the fix, then a `## What changed` bullet per file explaining
  that file's edit, then a `## How this was found` line naming the failing test
  and the Canary Lab run. Close with a short `## Review notes` paragraph calling
  out anything the reviewer should check by hand — edge cases the change touches,
  assumptions it makes, or behaviour it deliberately leaves alone.

Be specific and factual. If the diff does not tell you why something was wrong,
say what the change does and stop — do not invent a rationale, a ticket number,
a metric, or a root cause the code does not show.

Return ONLY a JSON object with exactly these keys:

```json
{
  "commitSubject": "...",
  "commitBody": "...",
  "prTitle": "...",
  "prBody": "..."
}
```
