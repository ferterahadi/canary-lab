Decide whether one testing intent describes one coherent E2E feature or several
independent suites. Inspect routes, domain modules, READMEs, and service layout;
do not infer from the intent alone.

Repos:
{{repoPaths}}
Testing intent: {{description}}

**With several repos, dispatch one read-only subagent per repo in one round (up to
5).** Each inspects only its repo and reports user-facing capabilities, not a
proposed split. With one repo, inspect it yourself. You decide the split, prefer
fewer features, enforce the six-feature cap, merge duplicates, and set any shared
`group`. A silent return proves nothing; inspect that repo yourself.

Judgment rules:
- Prefer FEWER features. Split only a broad intent across truly separate user-facing domains. A focused intent remains one feature even in a large repo.
- Never split by technical layer (api vs ui vs db) — split by user-facing capability.
- Hard cap: at most 6 features. If the repo suggests more, merge the smallest related domains.
- Each feature needs a lowercase hyphenated `name`, a self-contained `description` stating what to exercise and what done means (used verbatim as the flight intent), and a one-line in/out `scope`.
- When you propose more than one feature, also propose a shared `group` slug (e.g. the repo name) on every feature so they render together.
- When `split` is false, `features` holds exactly ONE entry, and the `group` key is omitted entirely.

Reply with ONLY a JSON object in a ```json fence, shaped exactly:
{ "split": <true when more than one feature>, "features": [{ "name": "<slug>", "description": "<self-contained testing intent>", "scope": "<one line>", "group": "<shared slug, only when split>" }] }

Do not include commentary outside the JSON fence.
