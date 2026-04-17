<!-- managed:canary-lab:start -->
# Canary Lab Agent Guide

For available Codex skills, read:

- `.codex/self-fixing-loop.md` — diagnose and fix failing tests
- `.codex/env-import.md` — import env files from declared repos into envsets

## Quick Start

1. Run `npx canary-lab run`
2. Leave the runner open in watch mode
3. In Codex, type:

```text
self heal
```

## Auto-Heal Mode

When `npx canary-lab run` asks "Auto-heal on test failure?", pick `Yes — Codex`. The runner will spawn `codex exec` in its own tab each time Playwright fails, pointed at `.codex/heal-loop.md`. You do not need to type `self heal` yourself. Pick **Resume** session mode to carry context across heal cycles; the runner gives up after 3 consecutive cycles on the same failure set and falls back to manual signalling.

If the managed blocks or `.codex/*` skills look stale after a `canary-lab` upgrade, run `npm run upgrade` manually — `postinstall` may not fire on every `npm install` / `npm update`.

## What `self heal` Means

When the user types `self heal`, follow `.codex/self-fixing-loop.md`.

That workflow is a phased process: explore first, hypothesize, fix, evaluate. It covers:

- which logs to inspect and how to read them
- how to build a mental model before touching code
- the rule to fix implementation only
- how to maintain a diagnostic journal across iterations
- when to use `logs/.restart` vs `logs/.rerun` (with JSON context)

## Context Files

If these files exist in `logs/`, read them before starting any fix:

- `logs/e2e-summary.json` — test results with error messages and enriched service logs
- `logs/diagnosis-journal.json` — accumulated diagnostic context from prior fix iterations
- `logs/signal-history.json` — runner-maintained log of every restart/rerun signal and what changed

## Importing Env Files from Repos

When a feature's `feature.config.cjs` declares repos, use the env-import skill to copy their config files into envsets:

```text
import env files for <feature-name>
```
<!-- managed:canary-lab:end -->
