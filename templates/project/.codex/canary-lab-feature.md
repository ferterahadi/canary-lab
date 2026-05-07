# Canary Lab Feature

Create or modify Canary Lab feature tests. This skill is mainly a workflow and file-placement guide: it tells the agent when to use the deterministic CLI scaffold, which feature directory to use, which files to create or edit, and which project structure Canary Lab expects.

The code-level scaffold contract is the final authority. For a new feature, create the scaffold with `npx canary-lab new feature <name> --description "..."` first, then edit the generated files. This skill guides file placement and conventions, but generated feature output must still pass Canary Lab's shared scaffold validation before it is accepted.

## When to Use

- The user asks to create a new Canary Lab feature in this repo.
- The user asks to add or modify a Playwright test in this repo and the repo contains `features/*/feature.config.cjs`.
- The user asks to add a test case, extend coverage, or update an existing feature's Playwright tests.
- You're about to write a `playwright.config.ts` or a `*.spec.ts` and you can see existing features under `features/`.

If `features/*/feature.config.cjs` does not exist, this is not a canary-lab repo — skip this skill.

## Workflow

### A. Creating a new feature

1. Run the deterministic scaffold command from the project root:
   ```bash
   npx canary-lab new feature <name> --description "<one-line purpose>"
   ```
2. Edit the generated files under `features/<name>/`. Do not create a partial hand-written scaffold instead of running the command.
3. Keep the generated file set intact unless the shared scaffold validator allows the change.

### B. Adding a test to an existing feature

1. Pick the feature dir (`features/<name>/`). Confirm with the user if more than one could plausibly host the new test.
2. Add the spec under `features/<name>/e2e/<thing>.spec.ts`.
3. Reuse helpers in `features/<name>/e2e/helpers/`. Add a new helper only if no existing one fits.
4. **Imports must be:**
   ```ts
   import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
   ```
   Do **not** import from `@playwright/test` directly — the log-marker fixture is what lets the runner slice service logs per test.
5. Read service URLs from the selected feature env/envset, with a local default that matches the service's readiness probe:
   ```ts
   baseUrl = process.env.GATEWAY_URL ?? 'http://localhost:4000'
   ```
6. Don't mock the service. Tests hit the real process started by `feature.config.cjs`.

## Files to Create or Edit

For a new test case, the default write targets are:

```
features/<name>/e2e/<thing>.spec.ts
features/<name>/e2e/helpers/<helper>.ts     # only when the existing helpers are insufficient
```

When creating a new feature programmatically, use `npx canary-lab new feature <name> --description "..."`. The complete scaffold it creates must include:

```
features/<name>/feature.config.cjs
features/<name>/playwright.config.ts
features/<name>/envsets/envsets.config.json
features/<name>/envsets/local/<name>.env
features/<name>/e2e/<thing>.spec.ts
```

For existing features, read these files before writing, but usually do not create them from scratch:

```
features/<name>/feature.config.cjs          # service startup, repo paths, readiness probes
features/<name>/playwright.config.ts        # should already spread baseConfig
features/<name>/envsets/envsets.config.json # env slots and test command/cwd
features/<name>/envsets/local/*             # local env files used by the feature
```

## Feature Directory Anatomy

Use this section to understand the generated layout, not as permission to invent a different partial scaffold by hand.

```
features/<name>/
  feature.config.cjs          # repos + startCommands + healthCheck (the runner reads this)
  playwright.config.ts        # spreads baseConfig from canary-lab/feature-support
  e2e/
    <thing>.spec.ts           # specs — import from log-marker-fixture
    helpers/
      <name>.ts               # API/page-object helpers shared across specs
  envsets/
    envsets.config.json       # appRoots + slots + feature.testCommand/testCwd
    local/                    # imported .env files (managed by the env-import skill)
```

Don't add a per-feature `package.json`. Don't put specs at the repo root. Don't create sibling top-level dirs — everything for one feature lives under `features/<name>/`.

## Feature-Owned Local Services

Some checked-in sample features include `scripts/server.ts` because they own a local demo/mock service. That is optional. Do not create `features/<name>/scripts/server.ts` unless this feature explicitly owns a local service implementation.

## `feature.config.cjs` Shape

```js
const config = {
  name: '<feature-name>',
  description: '<one-line purpose>',
  envs: ['local'],
  repos: [
    {
      name: '<repo-id>',
      localPath: __dirname,                    // or '~/Documents/<repo>' for external repos
      startCommands: [
        {
          name: '<service-name>',
          command: '<local start command>',
          // Readiness probe — declare exactly one transport per probe.
          healthCheck: { http: { url: 'http://localhost:4000/', timeoutMs: 3000 } },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
```

- One repo entry per repo the feature spans. `localPath: __dirname` means "this feature owns the service code"; an external path means "we exercise an existing repo on disk".
- The readiness probe must respond before the runner starts the test suite. Prefer the tagged shape (`healthCheck: { http: { ... } }` or `{ tcp: { ... } }`) and keep it cheap (e.g. `/` or `/health`).
- `featureDir: __dirname` is required.

### Healthcheck Inference

Before finalizing `startCommands`, inspect the target repo closely enough to infer how the local service starts and when it is ready. Check README startup notes, package scripts, framework bootstrap files, route/controller files, env files, Docker/dev-compose files, and local port conventions.

- Prefer an HTTP readiness probe when the repo exposes a local root page or health route such as `/health`, `/healthz`, `/actuator/health`, `/ready`, or `/readiness`.
- Use a TCP probe only when there is no defensible HTTP readiness route but a local service port is known.
- Do not omit `healthCheck` for a service with a start command unless repo inspection finds no defensible local endpoint or port.
- Never point a health check at a production URL or a remote shared environment. The probe must match the local service started for this feature.

## `playwright.config.ts` Rule

Spread `baseConfig`. Don't hand-roll reporters, retries, projects, or output dirs — the runner depends on them.

```ts
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

loadDotenv({ path: path.join(__dirname, '.env') })

export default defineConfig({ ...baseConfig })
```

If you need to override one field (e.g. `timeout`), spread first and override last: `{ ...baseConfig, timeout: 60_000 }`.

## Envsets in One Paragraph

`envsets/envsets.config.json` declares `appRoots` (named pointers to repo directories on disk) and `slots` (config files within those repos that the runner swaps in for each env). The `feature` block lists which slots apply, the `testCommand`, and `testCwd` (`$CANARY_LAB_PROJECT_ROOT/features/<name>`). For wiring `.env` files from external repos into slots, use the Env Import guide (`.codex/env-import.md`) — don't re-derive that procedure here.

## Test Conventions

- File name: `<thing>.spec.ts`, kebab-case, in `e2e/`.
- Helpers go in `e2e/helpers/`, one class per service surface (e.g. `TodoApi`).
- Helpers wrap `fetch` (or Playwright's `request`) and read base URLs from env.
- A spec reads like a usage scenario: `describe(featureName) { test(behavior) }`.
- No mocks for services declared in `feature.config.cjs`. They're already running.

Reference: [features/example_todo_api/e2e/todo-api.spec.ts](../features/example_todo_api/e2e/todo-api.spec.ts) and [features/example_todo_api/e2e/helpers/api.ts](../features/example_todo_api/e2e/helpers/api.ts).

## Don'ts

- Don't import from `@playwright/test` in specs — use `canary-lab/feature-support/log-marker-fixture`.
- Don't add a `package.json` inside a feature dir.
- Don't write tests outside `features/<name>/e2e/`.
- Don't customize `playwright.config.ts` beyond spreading `baseConfig`.
- Don't edit healing artifacts (`logs/`, the managed `CLAUDE.md` block) as part of feature work.
- Don't fix tests when a test fails — fix the service. (See the `self heal` workflow in `CLAUDE.md`.)
- Don't create a new feature by manually inventing only some of the files.
- Don't use the structure section as a partial scaffold.
- Don't bypass `npx canary-lab new feature` when the task is new feature creation.

## Verify

After authoring, run from the project root:

```bash
npx canary-lab ui
```

Open the local UI, pick the feature, and confirm: services come up, the new spec runs, and log slices land under `logs/current/`. If the UI can't find the feature, re-check `feature.config.cjs` (`name`, `featureDir`) and that the dir is directly under `features/`.
