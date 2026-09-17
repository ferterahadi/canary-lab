Canary Lab — authoring profile. Create or extend features and write specs; Canary Lab is the control plane, this client writes the test content.

- Existing feature (the request names one — e.g. "author tests for <feature>", the Getting Started demo): do NOT create_feature and never invent a variant name. Author the new specs straight into features/<feature>/e2e. To choose WHAT to test, get_feature_coverage(feature) names the untested/path-incomplete requirements (list_feature_docs points at the source docs); tag the new test with the requirement it covers — test('…', { tag: ['@req-R2'] }, …) — so the gap actually closes in the ledger. Running the new test needs start_run: hand off to the repair loop (reconnect with the compact profile if this connection lacks it).
- New feature: create_feature returns the skeleton + nextSteps. Choose a unique slug and call create_feature directly; do not call list_features just to avoid collisions (retry with a different name ONLY for a name you invented — never rename away from a feature the user asked for; that is the existing-feature flow above). Author specs under features/<feature>/e2e importing from 'canary-lab/feature-support/log-marker-fixture'. capture_feature_env_files preserves repo env/config (secret values are never returned).
- Test titles (both paths): write each as a plain-English sentence naming the user-visible behavior — `user can reset their password after requesting a reset link`, not `POST /reset-token returns 200`; keep a technical term only when it is the requirement's own vocabulary. Reviewers read titles directly in the ledger and exported reports.
- Draft flow: start_external_draft → update_external_draft_stage (scaffolding → authoring-tests → validating → ready → applied) → apply_external_draft. start_external_draft only creates a visible task (no server-side agent is spawned); this client writes the specs and calls apply_external_draft when they are ready.

Before changing envsets or spec selection: get_workflow_guide(workflow:"author").

<!-- initialize-cut -->

## Envset source and target

Store the actual configuration values in the selected workspace at
`features/<feature>/envsets/<env>/<slot>`. For a suite that reads `.env`, use
`envsets/local/<feature>.env` with a slot target of
`$CANARY_LAB_PROJECT_ROOT/features/<feature>/.env`. That target is the temporary
file the launcher and Playwright read; the envset file is the durable source.
The runner applies it before startup and restores backed-up targets at teardown.
The intended lifecycle for a new suite `.env` target is absent at rest: verify
that teardown removes targets absent before the run. If it does not, report or
fix that lifecycle gap within the authorized scope; do not delete pre-existing
user files to force that state.

Inspect each consumer before choosing a target. Do not target `.runtime/envsets`,
the envset source directory itself, or a personal source checkout merely because
an existing environment variable points there. `capture_feature_env_files`
defaults an omitted target to `sourcePath`: pass an explicit target when importing
values for a different consumer. Existing paths are evidence to investigate,
not instructions to preserve their ownership.

Never create pointer-only envsets that outsource configuration to an unmanaged
env file. Capture its actual values and update the launcher/configuration together
to read the materialized target. A genuine file input (certificate, binary bundle,
or JSON configuration) may keep a separate slot when its consumer requires that
format; verify that reference and target together. Do not flatten every suite
into one slot or encode files into environment variables merely for uniformity.

For an all-suites migration, inspect every suite, preserve existing values, and
change only incorrect mappings. Verify source → target → consumer and teardown,
including local/live variants, before calling it complete. Keep secret values out
of chat, logs, and commits. Do not invent `.recovery` trees or copy credentials to
new locations as a precaution; retain the original until its replacement works,
and use the runner's existing target backup/restore lifecycle during runs.

## Readable test source

Use one variable declaration per statement, descriptive names, and clear setup,
action, and assertions. Avoid comma expressions and nested conditional expressions.
Draft acceptance splits ordinary grouped declarations and formats specs before
accepting them. Syntax errors and comma expressions are rejected; nested conditionals
produce review warnings. Preserve test behavior when addressing those warnings.

For existing suites, run `canary-lab test-readability <file-or-directory>` to audit,
then add `--fix` for safe declaration fixes and formatting. `--rules-only` preserves
the current layout. Review the diff and rerun affected tests. Never weaken assertions
or modify recorded run artifacts during cleanup.

## Spec selection never depends on the envset

A suite declares ONE roster of tests, and every run of it declares the same one. Playwright builds that roster by walking the suite with the config's selection fields applied, before the first test starts — that walk is the run's evidence, so a config that narrows it by environment does not hide tests from a run, it deletes them from the record. A `meta` run of a 45-test suite then reports a 4-test suite: the other 41 are absent rather than "not run", and two runs of one suite cannot be compared.

So in `features/<feature>/playwright.config.*`, keep `testDir`, `testMatch`, `testIgnore`, `grep` and `grepInvert` as constant literals. Never derive one from `CANARY_LAB_MANIFEST_PATH`, `process.env`, or the recorded env — a `testMatch` built from that env is forbidden, and Canary Lab refuses both the draft that carries it and any run of the suite.

A test that must not execute in some environment skips ITSELF at runtime, so it stays declared, counted, and visibly skipped:

```ts
test('merchant can connect a Meta template', async ({ page }) => {
  test.skip(process.env.VERIFICATION_ENV !== 'meta', 'needs the Meta sandbox')
  …
})
```

Read the env from the envset's own values (a slot in `envsets/<env>/…`), not from the manifest.

Repo checkouts: get_feature_repo_status(feature, repo) reports the checkout's branch plus where the pinned branch stands against its upstream (upstreamSha, behindUpstream, aheadUpstream; fetch:true by default). When it is behind, update_feature_repo_branch(feature, repo, confirm:true) fast-forwards it so the next run boots the latest commit; it refuses and changes nothing when the checkout is dirty, detached, on another branch or diverged — report the reason, never discard the user's work. checkout_feature_repo_branch switches branches. A repo declared track:'upstream' in feature.config.cjs is fast-forwarded automatically at every run start.
