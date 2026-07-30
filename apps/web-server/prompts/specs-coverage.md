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

**Fan out when the gaps span more than one spec file.** A spec FILE is the unit of
division, and no two writers may ever touch the same file — tests in one file share
fixtures and setup, so two agents editing it concurrently clobber each other rather
than working in parallel. First decide yourself which file each gap belongs in and
group them; when that leaves more than one file and more than a handful of gaps,
dispatch **one subagent per spec file in a single parallel round** (up to 5 at
once). Below that, write them yourself.

Unlike a diagnosis fan-out, these subagents DO write — but each writes exactly one
file, the path you assign it, and nothing else. Spell out for each: it must not
touch another spec file, must not edit {{configPath}}, and must not modify any
application code. That constraint is what makes writing in parallel safe here at
all; the moment two of them share a path you have a lost-update bug, not a speedup.

Read {{configPath}} ONCE yourself and hand every subagent the resolved facts —
service names, port slot names, health-check URLs, the fallback ports — plus the
import line and the port-resolution expression from the hard rules below, verbatim.
Do not let five subagents each re-derive the base URL: they will each pick a
slightly different form, and the suite ends up with five conventions.

Give every subagent the guardrail below verbatim, because a subagent measured on
closing its own gap is exactly who would rather fake a test than report an
unexercisable one: **if a gap cannot be exercised because the app exposes no
surface for it, skip it and say so — never write a test that fakes the behaviour,
and never weaken an assertion to make something pass.**

The merged answer is yours. A subagent that returns nothing has **not** closed its
gaps — it has failed to report; re-check its file on disk before counting those
gaps closed, and name any gap still open in your summary rather than letting
silence read as coverage.

Hard rules:
- Create or rewrite spec files directly with your Read/Write/Edit tools. Files live directly under {{featureDir}}/e2e/ and end in .spec.ts.
- Every spec imports: import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
- Tag each test title with the requirement + path it covers: "@req-<id> @path-<happy|sad|edge>" (and "@variant-<value>" when the requirement spans variants). One test may carry several tags. Example: `test('@req-R2 @path-sad rejects an expired voucher', async ({ request }) => { … })`
- Resolve each service's base URL as: `process.env.CANARY_PORT_<slot> ? \`http://localhost:${process.env.CANARY_PORT_<slot>}\` : <the config's fallback port>` — `<slot>` is the `ports[].name` declared in the feature config. Never hardcode a port.
- Assert real user-observable effects, not merely 200s. No `toHaveURL(/.*/)`, no `waitForTimeout` as an assertion.
- If a gap cannot be exercised because the app exposes no surface for it, skip it and name it in your one-line summary — do not write a test that fakes the behavior.

Do NOT reply with JSON or file contents — the runner reads the spec files you wrote on disk. When done, reply with a one-line summary of what you changed.
