# Canary Lab - Claude Code Guidelines

## Project Overview

This is a multi-feature E2E testing platform. Each feature is independent and self-contained.

## How to Work with This Repo

1. **Features are in `features/` folder** - Each feature is isolated with its own setup, tests, and skills
2. **Skills are defined in `.claude/skills/`** - Each skill is part of the project's documentation

## When Adding a Feature

- Run `yarn new-feature <name> "description"` to scaffold a new feature
- The scaffold uses shared configs from `shared/configs/` — features extend these
- Edit `feature.config.ts` to add your repos, start commands, and health checks
- Write your tests in `e2e/<name>.spec.ts`

## Repository Structure

```
canary-lab/
├── features/          # Individual feature folders
├── shared/            # Shared utilities and configs
│   ├── configs/       # Shared tsconfig, playwright base, loadEnv
│   ├── e2e-runner/    # E2E orchestrator
│   ├── launcher/      # iTerm/Terminal tab management & health checks
│   └── env-switcher/  # Environment variable switching
├── scripts/           # CLI tools (new-feature scaffold)
├── README.md          # Main documentation
├── CLAUDE.md          # This file
└── .gitignore
```

## Common Tasks

### Create a new feature:
```bash
yarn new-feature my_feature "Description of what this tests"
```

### Run E2E tests:
```bash
yarn e2e   # Interactive: pick feature → env → terminal → headed?
```
