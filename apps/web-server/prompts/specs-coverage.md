You are authoring Playwright E2E specs for the Canary Lab feature "{{feature}}" ({{description}}).
Close every coverage gap below by writing/rewriting spec files.
Read the feature config at {{configPath}} first — it declares the services, port slots, and health-check URLs the booted app exposes; target those.

The feature directory is {{featureDir}}. Existing specs (if any) live at {{featureDir}}/e2e/*.spec.ts — read them with your tools before deciding what to change; rewrite them freely.

Requirements (from the PRD summary):
```json
{{requirements}}
```

Open gaps to close{{iterationNote}}:
```json
{{gaps}}
```
{{validationErrors}}

**Fan out when the gaps span more than one spec file.** First assign each gap to a
file. With several files and many gaps, dispatch one subagent per spec file in one
round (up to 5); otherwise write them yourself. No two agents may share a file.
Each edits exactly its assigned path and nothing else: never {{configPath}}, another
spec, or application code.

Read {{configPath}} yourself and give every subagent the same resolved services,
ports, health URLs, fallbacks, import line, and base-URL expression verbatim. Repeat
this guardrail verbatim: **if a gap cannot be exercised because the app exposes no
surface for it, skip it and say so; never write a test that fakes the behavior or
weaken an assertion to make it pass.** A silent return has not closed its gaps;
verify its file and report every gap still open.

Hard rules:
- Create or rewrite spec files directly with your Read/Write/Edit tools. Files live directly under {{featureDir}}/e2e/ and end in .spec.ts.
- Every spec imports: import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
- If a spec starts a repo-owned process itself, also import `resolveRunRepoPath` from that fixture and use `resolveRunRepoPath(repo.name, repo.localPath)` as its `cwd`. Never spawn from `repo.localPath` directly: during a Canary run the helper selects the active per-run worktree; direct Playwright use safely falls back to the configured path.
- Tag each test title with the requirement + path it covers: "@req-<id> @path-<happy|sad|edge>" (and "@variant-<value>" when the requirement spans variants). One test may carry several tags. Example: `test('@req-R2 @path-sad rejects an expired voucher', async ({ request }) => { … })`
- After the tags, write the title as a plain-English sentence a non-engineer can read: name the user-visible behavior, not the mechanism. `test('@req-R4 @path-happy user can reset their password after requesting a reset link', …)`, never `test('@req-R4 @path-happy POST /reset-token returns 200', …)`. Keep a technical term only when it is the requirement's own vocabulary (an endpoint name in an API-contract requirement stays technical). Reviewers read these titles directly in the coverage ledger and exported reports.
- Resolve each service's base URL as: `process.env.CANARY_PORT_<env-slot> ? \`http://localhost:${process.env.CANARY_PORT_<env-slot>}\` : <the config's literal fallback URL>`.
  - Normally start from the `ports[].name` declared in the feature config. For the environment key, replace every character outside letters, digits, and `_` with `_`: slot `checkout-service` is exposed as `CANARY_PORT_checkout_service`. This normalization is required because interactive shells drop invalid environment names.
  - A start command may temporarily have no `ports` because its source still hardcodes a listener. In that case, reserve the start command's `name` as the future slot, apply the same shell-safe normalization for `CANARY_PORT_<env-slot>`, and use its literal health-check URL only as the fallback. The first serial Test run and Report can use that fallback; the final Parallel setup stage adds the reserved verbatim slot for concurrent runs.
  - Never emit a naked literal base URL such as `const baseUrl = 'http://localhost:4300'`; every local service URL must check its shell-safe `CANARY_PORT_<env-slot>` first.
- Assert real user-observable effects, not merely 200s. No `toHaveURL(/.*/)`, no `waitForTimeout` as an assertion.
- If a gap cannot be exercised because the app exposes no surface for it, skip it and name it in your one-line summary — do not write a test that fakes the behavior.

Do NOT reply with JSON or file contents — the runner reads the spec files you wrote on disk. When done, reply with a one-line summary of what you changed.
