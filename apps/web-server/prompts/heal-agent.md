Playwright failed. {{healingDirective}}

Run directory:
- `{{runDir}}` (`{{runDirRel}}` from the project root)

Start here:
- `{{healIndexPath}}` — first file to read when present. It lists failed tests, assertion errors, editable repos, and exact per-failure slice paths.
- `{{summaryPath}}` — raw Playwright summary. Use only if `heal-index.md` is missing or incomplete.
- If neither `heal-index.md` nor the summary exists or lists failures, read the newest `*.log` in the run directory, note the missing index in your hypothesis, and proceed from raw logs.

Useful only when needed:
{{traceExtractHint}}
- `{{failedDir}}/<slug>/<svc>.log` — pre-sliced service logs referenced by `heal-index.md`.
{{playwrightMcpHint}}
- `{{runDir}}/svc-<safeName>.log` — full service log. Use only if a slice is missing or too short.
- `{{journalPath}}` — prior heal attempts. Use only when the current prompt or index says prior iterations exist.

{{featureDocsMap}}

{{personalWikiMap}}

Rules:
- {{testSpecRule}}
- In service/app repair mode, edit only the effective repo paths listed by `heal-index.md`. The authored feature suite and each original source checkout are read-only; worktree paths are the repair target.
- Prefer exact slice paths from `heal-index.md` before broad repo search.
- When SEVERAL tests failed, fan out the diagnosis. Dispatch **one read-only
  sub-agent per failure in a single parallel round** (up to 5 at once), each
  given just that failure's slice paths from `heal-index.md`, each reporting
  back a hypothesis PLUS a concrete proposed patch — the exact edits — for its
  own failure. Those sub-agents are READ-ONLY: they must not edit a file and
  must not write a signal file. Apply their patches yourself, serially, and
  where two of them touch the same file reconcile by hand before applying.
  Investigation and drafting fan out; editing and signalling never do. A
  sub-agent that comes back empty has not cleared its failure — say so in your
  hypothesis, or investigate that one yourself, rather than signalling as
  though its test were addressed.
- The signal requests runner verification; it is not a claim that the fix already passes. Do not start services or run Playwright, smoke, end-to-end, or other runtime checks yourself. Canary Lab owns affected-service restart, health checks, and targeted Playwright verification after the signal. If an edit command failed or syntax is uncertain, run at most one fast non-network static check before signalling.
- After fixing, write the per-run signal file:
  - Service/app fix → `{{restartSignal}}`
  - Test/config-only fix → `{{rerunSignal}}`
  - If you changed BOTH app and test/config files, write ONLY the restart signal. Write exactly one signal file per cycle.
- {{loggingRule}}
- Signal body: `{"hypothesis":"<concise diagnosis of what's wrong>","fixDescription":"<concise summary of what the fix does>"}`. Both fields land in the audit journal. The runner detects which files you changed via git — do not list them.

{{closingDirective}}
