Canary Lab — authoring profile. Create or extend features and write specs; Canary Lab is the control plane, this client writes the test content.

- Existing feature (the request names one — e.g. "author tests for <feature>", the Getting Started demo): do NOT create_feature and never invent a variant name. Author the new specs straight into features/<feature>/e2e. To choose WHAT to test, get_feature_coverage(feature) names the untested/path-incomplete requirements (list_feature_docs points at the source docs); tag the new test with the requirement it covers — test('…', { tag: ['@req-R2'] }, …) — so the gap actually closes in the ledger. Running the new test needs start_run: hand off to the repair loop (reconnect with the compact profile if this connection lacks it).
- New feature: create_feature returns the skeleton + nextSteps. Choose a unique slug and call create_feature directly; do not call list_features just to avoid collisions (retry with a different name ONLY for a name you invented — never rename away from a feature the user asked for; that is the existing-feature flow above). Author specs under features/<feature>/e2e importing from 'canary-lab/feature-support/log-marker-fixture'. capture_feature_env_files preserves repo env/config (secret values are never returned).
- Test titles (both paths): write each as a plain-English sentence naming the user-visible behavior — `user can reset their password after requesting a reset link`, not `POST /reset-token returns 200`; keep a technical term only when it is the requirement's own vocabulary. Reviewers read titles directly in the ledger and exported reports.
- Draft flow: start_external_draft → update_external_draft_stage (scaffolding → authoring-tests → validating → ready → applied) → apply_external_draft. start_external_draft only creates a visible task (no server-side agent is spawned); this client writes the specs and calls apply_external_draft when they are ready.

Full guide (envset-independent spec selection): get_workflow_guide(workflow:"author").

<!-- initialize-cut -->

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

A test that must not execute in some environment belongs in a sibling feature for that environment, with its own literal roster — never behind a runtime `test.skip`. The verdict counts a skipped test as not passed, so a roster that carries another lane's specs can never go green:

```
features/<suite>/playwright.config.ts        testMatch: '**/*.local.spec.ts'   envs: ['local']
features/<suite>-meta/playwright.config.ts   testMatch: '**/*.meta.spec.ts'    envs: ['meta']
```

Each lane's config may refuse to run in the wrong environment (throw when the manifest's env is not its lane); that guards the boot, it does not select tests. Read any env value a test needs from the envset's own values (a slot in `envsets/<env>/…`), not from the manifest.

Repo checkouts: get_feature_repo_status(feature, repo) reports the checkout's branch plus where the pinned branch stands against its upstream (upstreamSha, behindUpstream, aheadUpstream; fetch:true by default). When it is behind, update_feature_repo_branch(feature, repo, confirm:true) fast-forwards it so the next run boots the latest commit; it refuses and changes nothing when the checkout is dirty, detached, on another branch or diverged — report the reason, never discard the user's work. checkout_feature_repo_branch switches branches. A repo declared track:'upstream' in feature.config.cjs is fast-forwarded automatically at every run start.
