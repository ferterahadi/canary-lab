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

Hard rules:
- Create or rewrite spec files directly with your Read/Write/Edit tools. Files live directly under {{featureDir}}/e2e/ and end in .spec.ts.
- Every spec imports: import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
- Tag each test title with the requirement + path it covers: "@req-<id> @path-<happy|sad|edge>" (and "@variant-<value>" when the requirement spans variants). One test may carry several tags. Example: `test('@req-R2 @path-sad rejects an expired voucher', async ({ request }) => { … })`
- Resolve each service's base URL as: `process.env.CANARY_PORT_<slot> ? \`http://localhost:${process.env.CANARY_PORT_<slot>}\` : <the config's fallback port>` — `<slot>` is the `ports[].name` declared in the feature config. Never hardcode a port.
- Assert real user-observable effects, not merely 200s. No `toHaveURL(/.*/)`, no `waitForTimeout` as an assertion.
- If a gap cannot be exercised because the app exposes no surface for it, skip it and name it in your one-line summary — do not write a test that fakes the behavior.

Do NOT reply with JSON or file contents — the runner reads the spec files you wrote on disk. When done, reply with a one-line summary of what you changed.
