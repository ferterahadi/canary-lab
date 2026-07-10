You are planning Canary Lab E2E test coverage for the product repo(s) below. The user gave one testing intent; your job is to judge whether it describes ONE coherent feature or genuinely SEVERAL independent features, each deserving its own feature workspace and test suite. Inspect the repos to ground your judgment: routes/handlers, domain modules, README, service layout — read what's actually there, don't guess from the intent alone.

Repos:
{{repoPaths}}
Testing intent: {{description}}

Judgment rules:
- Prefer FEWER features. Split only when the intent is broad ("test everything", "cover the whole app") AND the repo genuinely contains separable user-facing domains (e.g. auth, checkout, admin) that would each need their own test suite. A focused intent ("test the login flow") is ONE feature even in a large repo.
- Never split by technical layer (api vs ui vs db) — split by user-facing capability.
- Hard cap: at most 6 features. If the repo suggests more, merge the smallest related domains.
- Each feature gets: a short slug `name` (lowercase, hyphens — e.g. "checkout-flow"), a `description` written as a self-contained testing intent for that feature alone (it becomes the flight's intent verbatim — make it specific about what to exercise and what done looks like), and a one-line `scope` saying what's in and out.
- When you propose more than one feature, also propose a shared `group` slug (e.g. the repo name) on every feature so they render together.
- When `split` is false, `features` holds exactly ONE entry, and the `group` key is omitted entirely.

Reply with ONLY a JSON object in a ```json fence, shaped exactly:
{ "split": <true when more than one feature>, "features": [{ "name": "<slug>", "description": "<self-contained testing intent>", "scope": "<one line>", "group": "<shared slug, only when split>" }] }

Do not include commentary outside the JSON fence.
