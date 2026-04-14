---
name: New Canary Lab Feature
description: Scaffold a new canary-lab feature using yarn new-feature — directory structure, feature.config.ts, envsets, scripts, playwright config, and launcher integration
type: skill
---

# New Canary Lab Feature

## Quick start

```bash
yarn new-feature <name> "description"
# Example: yarn new-feature api_webhooks "Webhook delivery E2E tests"
```

This generates all required files using shared configs. Then edit `feature.config.ts` to add your repos and write your tests.

## Conventions to follow

Every feature in canary-lab follows the structure established by the example features. Features use shared configs from `shared/configs/` to minimize boilerplate.

## Required directory structure

```
features/<feature-name>/
├── feature.config.ts          # Launcher registration — REQUIRED
├── package.json               # Scripts only, no deps (hoisted to root via yarn workspaces)
├── playwright.config.ts
├── tsconfig.json
├── .env.example
├── envsets/
│   ├── envsets.config.json    # Slot definitions + testCommand
│   └── <env-name>/            # One folder per env (e.g. local, staging)
│       └── <feature-name>.env # Env vars for that env
├── src/
│   └── config.ts              # Uses loadFeatureEnv, exports typed constants
└── e2e/
    ├── helpers/
    │   └── *.ts               # Test helpers (HTTP, service control, etc.)
    └── <feature-name>.spec.ts
```

## feature.config.ts

This is the single source of truth for the launcher. All startup behaviour is derived from this file.

```ts
import type { FeatureConfig } from '../../shared/launcher/types'

export const config: FeatureConfig = {
  name: '<feature-name>',
  description: '<one-line description>',
  envs: ['local'],
  repos: [
    {
      name: '<repo-name>',
      localPath: '~/Documents/<repo-name>',
      cloneUrl: 'git@github.com:<org>/<repo-name>.git',
      startCommands: [
        {
          name: '<human-readable name>',
          command: 'yarn dev',
          healthCheck: {
            url: 'http://localhost:3000/',
            timeoutMs: 2000,
          },
        },
      ],
    },
  ],
  featureDir: __dirname,
}
```

**Rules:**
- `localPath` uses `~/Documents/<repo>` convention
- `startCommands` is an array — each entry opens one terminal tab in the repo's directory
- `healthCheck.url` enables skip-if-already-running detection; always set it

## playwright.config.ts

Extends the shared base config. Override only what differs:

```ts
import { defineConfig } from '@playwright/test'
import { baseConfig } from '../../shared/configs/playwright.base'

export default defineConfig({
  ...baseConfig,
  // Override defaults as needed:
  // timeout: 180_000,
})
```

## tsconfig.json

Extends the shared base config:

```json
{
  "extends": "../../shared/configs/tsconfig.feature.json"
}
```

## src/config.ts

Uses the shared `loadFeatureEnv` utility for dotenv loading:

```ts
import { loadFeatureEnv } from '../../shared/configs/loadEnv'
loadFeatureEnv(__dirname + '/..')

export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3000'
// export other typed constants here
```

## Checklist before done

- [ ] `feature.config.ts` — name, repos with cloneUrl, startCommands with healthCheck URLs
- [ ] `envsets/envsets.config.json` — testCommand is `yarn test:e2e`
- [ ] `envsets/<env>/<feature-name>.env` for each env
- [ ] `src/config.ts` — uses loadFeatureEnv + typed exports
- [ ] `package.json` — scripts only, name is `canary-lab-<feature-name>`
- [ ] `playwright.config.ts` — extends shared base config
- [ ] `tsconfig.json` — extends shared base config
- [ ] `.env.example` — mirrors the local envset file
- [ ] `e2e/<feature-name>.spec.ts` — uses `test.describe`, `test.afterAll` for cleanup
