<!-- managed:canary-lab:start -->
# Canary Lab Agent Guide

For the full Codex self-fixing workflow, read:

- `.codex/self-fixing-loop.md`

## Quick Start

1. Run `npx canary-lab run`
2. Leave the runner open in watch mode
3. In Codex, type:

```text
self heal
```

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
<!-- managed:canary-lab:end -->
