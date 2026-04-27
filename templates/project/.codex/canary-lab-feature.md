# Canary Lab Feature

Author or extend a Canary Lab feature. A "feature" is a self-contained directory under `features/` that bundles a Playwright test suite, the services it exercises, env wiring, and a small config the runner reads.

## When to Use

- The user asks to add or modify a Playwright test in this repo and the repo contains `features/*/feature.config.cjs`.
- The user asks to "create a feature", "add a canary-lab feature", "set up tests for X".
- You're about to write a `playwright.config.ts` or a `*.spec.ts` and you can see existing features under `features/`.

If `features/*/feature.config.cjs` does not exist, this is not a canary-lab repo — skip this skill.

## Two Paths

### A. Adding a test to an existing feature

1. Pick the feature dir (`features/<name>/`). Confirm with the user if more than one could plausibly host the new test.
2. Add the spec under `features/<name>/e2e/<thing>.spec.ts`.
3. Reuse helpers in `features/<name>/e2e/helpers/`. Add a new helper only if no existing one fits.
4. **Imports must be:**
   ```ts
   import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
   ```
   Do **not** import from `@playwright/test` directly — the log-marker fixture is what lets the runner slice service logs per test.
5. Read service URLs from env with a default that matches the feature's `healthCheck.url`:
   ```ts
   baseUrl = process.env.GATEWAY_URL ?? 'http://localhost:4000'
   ```
6. Don't mock the service. Tests hit the real process started by `feature.config.cjs`.

### B. Creating a new feature

Prefer the CLI:

```bash
npx canary-lab new-feature <name>
```

It scaffolds the whole directory correctly. Only hand-author if the user explicitly insists, in which case follow the anatomy in §3 and the config shape in §4.

## Feature Directory Anatomy

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
  scripts/
    server.ts                 # any local service the feature owns
```

Don't add a per-feature `package.json`. Don't put specs at the repo root. Don't create sibling top-level dirs — everything for one feature lives under `features/<name>/`.

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
          command: 'npx tsx scripts/server.ts',
          healthCheck: {
            url: 'http://localhost:4000/',
            timeoutMs: 3000,
          },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
```

- One repo entry per repo the feature spans. `localPath: __dirname` means "this feature owns the service code"; an external path means "we exercise an existing repo on disk".
- `healthCheck.url` must respond before the runner starts the test suite — keep it cheap (e.g. `/` or `/health`).
- `featureDir: __dirname` is required.

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

`envsets/envsets.config.json` declares `appRoots` (named pointers to repo directories on disk) and `slots` (config files within those repos that the runner swaps in for each env). The `feature` block lists which slots apply, the `testCommand`, and `testCwd` (`$CANARY_LAB_PROJECT_ROOT/features/<name>`). For wiring `.env` files from external repos into slots, use the `Env Import` skill (`.claude/skills/env-import.md`) — don't re-derive that procedure here.

## Test Conventions

- File name: `<thing>.spec.ts`, kebab-case, in `e2e/`.
- Helpers go in `e2e/helpers/`, one class per service surface (e.g. `TodoApi`).
- Helpers wrap `fetch` (or Playwright's `request`) and read base URLs from env.
- A spec reads like a usage scenario: `describe(featureName) { test(behavior) }`.
- No mocks for services declared in `feature.config.cjs`. They're already running.

Reference: [features/example_todo_api/e2e/todo-api.spec.ts](../../features/example_todo_api/e2e/todo-api.spec.ts) and [features/example_todo_api/e2e/helpers/api.ts](../../features/example_todo_api/e2e/helpers/api.ts).

## Don'ts

- Don't import from `@playwright/test` in specs — use `canary-lab/feature-support/log-marker-fixture`.
- Don't add a `package.json` inside a feature dir.
- Don't write tests outside `features/<name>/e2e/`.
- Don't customize `playwright.config.ts` beyond spreading `baseConfig`.
- Don't edit healing artifacts (`logs/`, the managed `CLAUDE.md` block) as part of feature work.
- Don't fix tests when a test fails — fix the service. (See the `self heal` workflow in `CLAUDE.md`.)

## Verify

After authoring, run from the project root:

```bash
npx canary-lab run
```

Pick the feature and confirm: services come up, the new spec runs, log slices land under `logs/`. If the runner can't find the feature, re-check `feature.config.cjs` (`name`, `featureDir`) and that the dir is directly under `features/`.
