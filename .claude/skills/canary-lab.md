---
name: Canary Lab
description: Guide for running E2E tests in canary-lab — feature list, setup, prerequisite repos, and how to use the unified launcher
type: skill
---

# Canary Lab — E2E Test Hub

## Overview

canary-lab is a multi-feature E2E test platform. All features are run through a single unified launcher:

```bash
cd canary-lab
yarn install       # first time only
yarn e2e           # interactive: pick feature → env → terminal → headed?
```

The launcher:
1. Discovers all features automatically (any folder with `feature.config.ts`)
2. Asks which environment to use
3. Asks which terminal to use (iTerm or Terminal.app)
4. Checks all required repos are cloned locally
5. Starts the app stack in terminal tabs
6. Runs Playwright tests
7. Enters watch mode for iterative fixes

---

## Available Features

| Feature | Description | Modes | Required Repos |
|---------|-------------|-------|----------------|
| `example_todo_api` | Example feature — TODO API CRUD tests (self-contained) | `local` | none (built-in server) |

---

## Prerequisites

| Tool | Required by | Check |
|------|-------------|-------|
| Node.js 20+ | launcher, all features | `node --version` |
| Playwright | all features | `npx playwright --version` |
| iTerm2 or Terminal.app | service launcher | macOS built-in |

---

## Running Tests Manually (without launcher)

Each feature is self-contained and can be run directly:

```bash
cd features/example_todo_api
yarn test:e2e          # headless
yarn test:e2e:headed   # headed
```

---

## Adding a New Feature

```bash
yarn new-feature <name> "description"
```

See the `new-feature` skill for the full scaffold details. The minimum to integrate with the launcher:

1. Add `feature.config.ts` to `features/<name>/` — the launcher auto-discovers it
2. Define `repos` with `startCommands` (use `healthCheck.url` so the launcher skips already-running services)
3. If the feature needs ngrok tunnels, add `envs: ['local', 'tunnel']` and a `tunnels` array
