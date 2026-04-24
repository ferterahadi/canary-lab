<!-- managed:canary-lab:start -->
# Canary Lab Project Notes

## Quick Start

```bash
npm install
npm run install:browsers
npx canary-lab run
```

Leave the runner open in watch mode. When a test fails you have two options:

- **Manual:** type `self heal` in a Claude Code session (the workflow is inlined below, so Claude already has it).
- **Auto-heal:** when `npx canary-lab run` asks "Auto-heal on test failure?", pick `Yes — Claude Code`. The runner spawns `claude -p` in its own tab each time Playwright fails, using the workflow below as its prompt. Pick **Resume** session mode to carry context across cycles; the runner gives up after 3 consecutive cycles on the same failure set.

If the managed block in this file looks stale after a `canary-lab` upgrade, run `npm run upgrade` manually — `postinstall` may not fire on every `npm install` / `npm update`.

## Self-Heal Workflow

When the user types `self heal` — or when the auto-heal runner spawns you — follow the workflow between the `heal-prompt` markers below. The runner reads this same section verbatim as its prompt, so keep the content self-contained.

<!-- heal-prompt:start -->
Playwright just failed. Read `logs/heal-index.md` — it maps each failing test to its error message, the repos you may edit, and (if present) a pre-scoped service-log slice at `logs/failed/<slug>/<svc>.log`. Diagnose from the error message; read a slice only when the error alone is insufficient. Fix the service/app code — never the test.

Signal when done:

- `logs/.restart` if you changed service/app code (runner rebuilds + reruns).
- `logs/.rerun` if only test/config changed.
- Body is a single JSON line: `{"hypothesis":"…","filesChanged":["<abs-path>", …]}`. The runner uses `filesChanged` to decide which services to restart and to append a journal entry on your behalf — you do not need to write to `logs/diagnosis-journal.md` yourself.

**Fallback — when the error alone can't localize the bug:**

1. Raw log by slug: `sed -n '/<test-case-SLUG>/,/<\/test-case-SLUG>/p' logs/svc-*.log`. Svc logs are wiped on every signal, so output is this iteration only.
2. If `sed` is also empty — instrument, then fix. Grep to locate the handler, add `console.log` at decision points, write `.restart` with a `gather-evidence` hypothesis, and exit. On the next iteration, re-run `sed` and fix from real evidence. Remove the diagnostic logs in the same iteration that lands the fix.

If `heal-index.md` is missing entirely, fall back to `logs/e2e-summary.json`.

**When to exit:** if spawned by the runner (auto-heal), exit after writing the signal — the runner is polling. If driven by `self heal` typed in chat, tell the user which signal you wrote and **don't** exit the chat.

After 3 consecutive cycles on the same failure set, the runner gives up on auto-heal. If you reach that point manually, produce a brief diagnosis report (what you tried, what you learned, suspected root cause) and ask the user for guidance instead of retrying.
<!-- heal-prompt:end -->

## Context Files

If these files exist in `logs/`, read them in this order when starting a fix:

- `logs/heal-index.md` — **start here.** Compact markdown index: every failure, its pre-scoped log-slice paths, and a summary of the last 3 journal iterations. One Read call, everything you need to plan from.
- `logs/failed/<slug>/<svc>.log` — per-failure service log slices referenced by the index. Already scoped via XML markers and capped (~20KB). Read only the ones for the failure you're fixing.
- `logs/e2e-summary.json` — raw Playwright results (name, error, location, retry). The index is derived from this; read it only if the index is missing.
- `logs/diagnosis-journal.md` — full prior-iteration history (Markdown, one `## Iteration <N>` section per cycle). The index summarizes the tail; only read the full file if you need older context. The runner appends a new section for you on each signal — don't write to this file directly.
- `logs/signal-history.json` — runner-maintained log of every restart/rerun signal and what changed.
- `logs/svc-<name>.log` — full raw service logs. Reach for these only if a slice in `logs/failed/` is elided in the middle and you need more; use `sed -n '/<slug>/,/<\/slug>/p' logs/svc-<name>.log`.

## Importing Env Files from Repos

When a feature's `feature.config.cjs` declares repos, use the env-import skill to copy their config files into envsets:

```text
import env files for <feature-name>
```

See `.claude/skills/env-import.md`.
<!-- managed:canary-lab:end -->
