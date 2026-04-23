---
description: Self-heal the most recent Playwright failure
---

Playwright just failed. The map is at `logs/heal-index.md` — it lists the feature, the repos to edit, every failing test with its error, and the path to each failure's service-log slice. Journal tail is at the bottom; full history in `logs/diagnosis-journal.md`.

Diagnose from the error messages first. `Read` a slice file only if the error alone isn't enough. Grep distinctive literals in the repos listed. Fix the service/app code — never the test — then append a new iteration to `logs/diagnosis-journal.md` using this format:

```markdown
## Iteration <N> — <ISO timestamp>

- feature: <feature-name>
- failingTests: <slug-a>, <slug-b>
- hypothesis: <what is wrong and why>
- fix.file: <path>
- fix.description: <what changed>
- signal: .restart | .rerun
- outcome: pending
```

`<N>` is one higher than the highest existing iteration. Outcome stays `pending` until the next cycle evaluates it.

Write `logs/.restart` if you changed service code, `logs/.rerun` if only test/config. Body is a single JSON line: `{"hypothesis":"…","filesChanged":["…"],"expectation":"<slug-a>,<slug-b>"}`. If spawned by the runner, exit — it's polling. If driven by `self heal` in chat, tell the user which signal you wrote and don't exit the chat.

Skip hypotheses already tried (check the journal). If the latest journal iteration's `outcome` is still `pending`, set it first based on the current index (`all_passed` / `partial` / `no_change` / `regression` — see `.claude/skills/self-fixing-loop.md` for the rubric). If `heal-index.md` is missing entirely, fall back to `logs/e2e-summary.json` + `.claude/skills/self-fixing-loop.md`.
