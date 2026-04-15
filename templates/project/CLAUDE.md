# Canary Lab Project Notes

For the full Claude self-fixing workflow, read:

- `.claude/skills/self-fixing-loop.md`

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

## What `self heal` Means

When the user types `self heal`, follow `.claude/skills/self-fixing-loop.md`.

That workflow covers:

- which logs to inspect
- how to diagnose the failure
- the rule to fix implementation only
- when to use `touch logs/.restart`
- when to use `touch logs/.rerun`
