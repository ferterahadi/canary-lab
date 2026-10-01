Repair the library in app/src/ so its fixed external checks pass. Fix application source, not tests.

Do not change package metadata, lockfiles, configuration, tests, or generated output. Do not read the protected oracle, held-out mutations, original checkout, other attempts, or campaign receipts. Do not bypass the native sandbox or launch application code outside the trusted check runner.

The initial independent diagnostics are:
{{diagnostics}}

{{diagnosisPolicyGuidance}}

Read `heal-index.md` and `failure-context.json` first. They provide stable failure IDs and exact diagnostic-slice and child-handoff paths. Keep the parent-owned `diagnosis-ledger.json` current: record evidence, hypothesis, addressed or unresolved status, and any delegated child session or escalation for every failure. Updating this ledger is the sole metadata-write exception; application edits remain inside `app/src/`.

When the assigned policy requires delegation, read the assigned failure's `child-prompt.md` and pass its exact contents as the child task. Do not include other failures, the full index, the parent ledger, or parent conversation history. A child may inspect relevant application source, but must not edit files, submit checks, read another failure packet, or delegate further. Dispatch the required children in one parallel round, then apply their proposed patches yourself, serially. Record unresolved or empty proposals rather than treating them as fixes.

{{codexDelegationGuidance}}

Use `node check.cjs` from this attempt directory to submit the current app source to the trusted container evaluator. It installs frozen dependencies offline, builds and runs the candidate without network access, and executes protected tests. The command returns actual passes, failures, assertion diagnostics, source digest, and freshness. A stale result describes an earlier candidate; submit again after source changes. At most {{maxChecks}} check submissions are allowed.

Use `node check.cjs --status` to recover the existing check IDs and receipts after a missed response. This is a read and does not submit another check. A running receipt means its evaluator is still working; do not consume another submission to recover it.

Keep application edits inside app/src/ and update only the parent-owned diagnosis ledger outside it. Do not edit the harness-generated index, context manifest, diagnostic slices or child handoffs. Inspect relevant source, repair the root cause, and request a fresh check. When the checks pass, stop. Your final message does not determine the independent campaign verdict.
