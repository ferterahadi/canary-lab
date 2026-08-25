You are writing the commit message and pull-request description for an automated
repair that Canary Lab's heal agent made to a product repository.

A Playwright test failed. The heal agent fixed the APPLICATION code; it may never
weaken or edit the test. Explain the diff to its reviewer.

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

Describe the defect and why the old code was wrong, not the visible diff alone.

- **commitSubject** — an imperative Conventional Commits line, at most 72
  characters: `fix(scope): correct the defect`. Use the code's scope, not the
  feature. Describe the fix, never the failing test.
- **commitBody** — 1 to 3 short paragraphs, hard-wrapped at 72 columns. Say what
  was broken, what the user-visible consequence was, and how the change corrects
  it. Do not restate the diff line by line.
- **prTitle** — plain English a reviewer can judge from the pull-request list. No
  Conventional Commits prefix.
- **prBody** — GitHub-flavoured markdown. Lead with a one-paragraph summary of
  the defect and the fix, then a `## What changed` bullet per file explaining
  that file's edit, then a `## How this was found` line naming the failing test
  and the Canary Lab run. Close with a short `## Review notes` paragraph calling
  out anything the reviewer should check by hand — edge cases the change touches,
  assumptions it makes, or behaviour it deliberately leaves alone.

Be factual. If the diff does not show why, state what changed and stop. Never
invent rationale, tickets, metrics, or root causes.

Return ONLY a JSON object with exactly these keys:

```json
{
  "commitSubject": "...",
  "commitBody": "...",
  "prTitle": "...",
  "prBody": "..."
}
```
