---
name: Env Import
description: Import environment files from declared repos into a feature's envsets. Triggered by "import env", "set up envsets", "copy env files from repos".
type: skill
---

# Env Import

Import existing environment/config files from the repos declared in a feature's `feature.config.cjs` into its `envsets/` directory.

Canary Lab's UI is the primary surface for switching envs and running tests, but it uses the same `envsets/envsets.config.json` contract described here.

This skill guides envset discovery and file copying. The final generated feature still has to satisfy Canary Lab's shared scaffold validation: `envsets/envsets.config.json` must use top-level `appRoots`, `slots`, and `feature`, not a stale wrapper shape.

Use deterministic CLI commands when an agent needs to apply or revert envsets:

```bash
npx canary-lab env apply <feature> <set>
npx canary-lab env revert <feature>
```

The procedure below is only for discovering/copying env files and updating `envsets.config.json`.

## When to Use

When a feature has repos declared in `feature.config.cjs` but the envsets are not yet configured — or when adding a new repo to an existing feature.

Trigger phrases: "import env", "set up envsets", "copy env files", "configure envsets for [feature]"

## Procedure

### Step 1 — Identify the feature

Ask the user which feature, or infer from context (e.g., the feature they're currently working on).

Read `features/<feature>/feature.config.cjs` and extract the `repos` array. Each entry has:
- `name` — the repo identifier
- `localPath` — path to the repo on disk (may use `~`)

### Step 2 — Resolve and validate repo paths

Expand `~` to the user's home directory. Verify each repo directory exists on disk.

If a repo directory is missing, warn the user and skip it. Do not abort — other repos may still be importable.

### Step 3 — Explore each repo

For each repo, determine its type by checking for project markers at the repo root:

| Marker file | App type | Where to look for config |
|------------|----------|-------------------------|
| `build.gradle` or `pom.xml` | Java / Spring Boot | `**/src/main/resources/application-local.properties`, `application-dev.properties` |
| `package.json` with `next` dependency | Next.js | `.env.local` at the app root |
| `pnpm-workspace.yaml` or `workspaces` in `package.json` | Monorepo | Scan each sub-app under `apps/` or `packages/` for `.env.local`, `.env` |
| `package.json` (no Next.js, no workspaces) | Generic Node | `.env`, `.env.local`, `.env.dev` |

**Always skip** these directories when scanning: `node_modules/`, `.next/`, `build/`, `dist/`, `.gradle/`, `target/`, `.git/`

For monorepos with multiple sub-apps, check if the feature's `startCommands` reference specific sub-apps (by command or working directory) — those are the relevant ones.

### Step 4 — Present findings

Show the user what was found per repo:
- The app type detected
- Which config files were found
- Which ones look relevant for the feature (and why)

Ask the user to confirm which files to import. Respect the user's choices — they know their stack.

### Step 5 — Copy files to envsets

For each confirmed file, copy it into `features/<feature>/envsets/local/` using these naming conventions:

| Source pattern | Slot name example |
|---------------|-------------------|
| Root-level `.env.local` in a repo | `{repo-name}.env.local` |
| Monorepo sub-app `apps/{app}/.env.local` | `{app}.env.local` |
| Spring Boot `{module}/src/main/resources/application-local.properties` | `{repo-name}-application-local.properties` |

**appRoot variable name**: uppercase the repo name and replace hyphens with underscores.
- `my-backend` → `MY_BACKEND`
- `my-monorepo` → `MY_MONOREPO`

### Step 6 — Update envsets.config.json

Read the existing `features/<feature>/envsets/envsets.config.json`. Merge in the new entries:

- Add new `appRoots` entries (absolute path to each repo). Do not overwrite existing entries.
- Add new `slots` entries. Each slot needs `description` and `target` (using `$APPROOT_VAR/relative/path`).
- Append new slot names to `feature.slots` (do not duplicate existing entries).
- Preserve the existing `feature.testCommand` and `feature.testCwd`.

**Do not** add `CANARY_LAB_PROJECT_ROOT` to `appRoots` — it is injected automatically at runtime.

### Target JSON structure

```json
{
  "appRoots": {
    "REPO_VAR": "/absolute/path/to/repo"
  },
  "slots": {
    "slot-name.ext": {
      "description": "Short description of this config file",
      "target": "$REPO_VAR/relative/path/to/file"
    }
  },
  "feature": {
    "slots": ["feature.env", "slot-name.ext"],
    "testCommand": "npx playwright test",
    "testCwd": "$CANARY_LAB_PROJECT_ROOT/features/<feature-name>"
  }
}
```

## Example

A feature that spans a Spring Boot backend, a Next.js monorepo, an API gateway, and a notification service:

```
feature.config.cjs declares:
  my-backend       → ~/Documents/my-backend
  my-monorepo      → ~/Documents/my-monorepo
  api-gateway      → ~/Documents/api-gateway
  notification-svc → ~/Documents/notification-svc

Results in envsets.config.json:
  appRoots:
    MY_BACKEND       → /Users/.../my-backend
    MY_MONOREPO      → /Users/.../my-monorepo
    API_GATEWAY      → /Users/.../api-gateway
    NOTIFICATION_SVC → /Users/.../notification-svc

  slots:
    my-backend-application-local.properties
      → $MY_BACKEND/service/src/main/resources/application-local.properties
    admin-portal.env.local
      → $MY_MONOREPO/apps/admin-portal/.env.local
    storefront.env.local
      → $MY_MONOREPO/apps/storefront/.env.local
    api-gateway-application-local.properties
      → $API_GATEWAY/src/main/resources/application-local.properties
    notification-svc.env.local
      → $NOTIFICATION_SVC/.env.local
```

## Safety Rules

- **Copy files verbatim.** Never modify, reformat, or "clean up" env file contents during import. The file in `envsets/local/` must be byte-identical to the source.
- **Never generate or guess config values.** If a value is missing or looks wrong, flag it to the user — do not fill it in.
- **Do not write to the source repos.** This skill only reads from external repos and writes to the feature's `envsets/` directory.
- **Show the user what will be written before writing.** List the exact file paths and slot names before copying or editing `envsets.config.json`.

## Edge Cases

- **Repo not cloned yet**: Skip with a warning. The user can re-run the import after cloning.
- **envsets.config.json already has slots**: Merge additively. Do not remove or overwrite existing entries.
- **Feature's own `.env` slot already exists**: Preserve it — the import only handles external repo files.
- **File contains secrets**: Still copy it. The values are local dev config. Note it to the user so they can review.
- **Multiple config files in one repo**: Present all of them and let the user choose.

## Script Locations

- Env switcher: `apps/web-server/lib/runtime/env-switcher/switch.ts`
- Env switcher types: `apps/web-server/lib/runtime/env-switcher/types.ts`
- Feature config types: `shared/launcher/types.ts`
