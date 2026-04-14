---
name: Env Switcher
description: Switch the active environment variable set across canary-lab and sibling apps before running E2E tests
type: skill
---

# Env Switcher

Manages named sets of environment variables spanning multiple repos. Before tests run, it backs up the current config files, applies the chosen set, then restores originals when done.

The switcher is fully generic — every feature defines its own slots in `envsets/envsets.config.json`.

## How it works

```
features/<feature-name>/envsets/
├── envsets.config.json          # Slot definitions: name → target path
└── <env-name>/                  # One folder per env (e.g. local, staging, tunnel)
    └── <slot-file>              # Only include slots you want to override
```

When the launcher runs, it:
1. Reads `envsets.config.json` to resolve slot → target file paths
2. Backs up the current target files
3. Copies the chosen env set's slot files into place
4. Runs tests
5. Restores the originals from backups

## Usage

```bash
# Full flow via launcher (recommended)
yarn e2e   # interactive: pick feature → env → runs env-switcher automatically

# Manual apply/revert (from within a feature folder)
yarn env:apply local
yarn env:revert
```

## envsets.config.json structure

```json
{
  "appRoots": {
    "CANARY_LAB": "../..",
    "MY_APP": "/path/to/my-app"
  },
  "slots": {
    "<slot-filename>": {
      "description": "Human-readable label",
      "target": "$MY_APP/path/to/.env.local"
    }
  },
  "feature": {
    "slots": ["<slot-filename>"],
    "testCommand": "yarn test:e2e",
    "testCwd": "$CANARY_LAB/features/<feature-name>"
  }
}
```

- `appRoots` — named path variables used in `target` values
- `slots` — every file type this feature can manage; missing slot files in an env set are silently skipped
- `feature.slots` — which slots this feature actually uses
- `testCommand` / `testCwd` — used by `root-cli.ts` when running tests directly via the switcher

## Adding a new env set

1. Create `features/<feature-name>/envsets/<set-name>/`
2. Add files matching the slot names you want to override (missing slots are skipped)

## Adding a new slot

1. Add entry to `envsets/envsets.config.json` under `slots`
2. Add the app root to `appRoots` if the target is in a new sibling repo
3. Add the slot name to `feature.slots`
4. Drop the slot file into each env set folder

## Script locations

- Switcher: `shared/env-switcher/switch.ts`
- Root CLI: `shared/env-switcher/root-cli.ts`
