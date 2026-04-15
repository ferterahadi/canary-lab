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

That workflow covers:

- which logs to inspect
- how to diagnose the failure
- the rule to fix implementation only
- when to use `touch logs/.restart`
- when to use `touch logs/.rerun`
