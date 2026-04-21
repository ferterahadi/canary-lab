<!-- managed:canary-lab:start -->
# Canary Lab Agent Guide

For available Codex skills, read:

- `.codex/self-fixing-loop.md` — diagnose and fix failing tests
- `.codex/env-import.md` — import env files from declared repos into envsets

## Quick Start

```bash
npm install
npm run install:browsers
npx canary-lab run
```

Leave the runner open in watch mode, then type:

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

If these files exist in `logs/`, read them in this order when starting a fix:

- `logs/heal-index.md` — **start here.** Compact markdown index: every failure, its pre-scoped log-slice paths, and a summary of the last 3 journal iterations. One read call, everything you need to plan from.
- `logs/failed/<slug>/<svc>.log` — per-failure service log slices referenced by the index. Already scoped via XML markers and capped (~20KB). Read only the ones for the failure you're fixing.
- `logs/e2e-summary.json` — raw Playwright results (name, error, location, retry). The index is derived from this; read it only if the index is missing.
- `logs/diagnosis-journal.json` — full prior-iteration history. The index summarizes the tail; only read the full file if you need older context.
- `logs/signal-history.json` — runner-maintained log of every restart/rerun signal and what changed.
- `logs/svc-<name>.log` — full raw service logs. Reach for these only if a slice in `logs/failed/` is elided in the middle and you need more; use `sed -n '/<slug>/,/<\/slug>/p' logs/svc-<name>.log`.

## Importing Env Files from Repos

When a feature's `feature.config.cjs` declares repos, use the env-import skill to copy their config files into envsets:

```text
import env files for <feature-name>
```
<!-- managed:canary-lab:end -->
