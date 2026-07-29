---
name: canary-lab-coverage
description: Use when working the Canary Lab semantic coverage ledger — "what's actually tested?", "map coverage for <feature>", "refresh the PRD summary", "close the coverage gaps", "add this plan/spec to the feature docs" — through the coverage MCP tools (write/list/delete_feature_doc, start/submit_external_summary, start/submit_external_coverage, get_feature_coverage, clear_prd_summary). For writing new tests use canary-lab-author.
type: skill
---

# Canary Lab — Semantic Coverage Ledger

This client reads the docs/tests and submits requirements + mappings; Canary
Lab writes the tags and computes the ledger. These tools arrive via the
Canary Lab MCP server. If this client is already connected (the plugin
connects with `full`), skip this step. To configure a connection manually:
`npx canary-lab mcp --profile coverage` (the composite `lifecycle`/`full`
profiles carry the same tools). Use this to answer "what's actually
tested?" — coverage is claim-based: a tag claims a test maps to each
requirement and its declared paths, regardless of run results. When the
feature has a recorded run the ledger also carries an additive **proven**
axis (`provenPct`, `totals.proven`, per-requirement/path `proven`,
`provenRunId`): covered = a tag claims it; proven = the covering test
actually passed in the latest run (omitted when no run is recorded).

## Workspace Bootstrap

1. Read `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`); one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`.
2. Check `/mcp/health` on the UI's port: read `port` from the workspace's `canary-lab.config.json` (fallback `7421`), then `curl -s http://127.0.0.1:<port>/mcp/health` — success is a JSON response. Confirm `projectRoot` matches the selected workspace.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.

## Coverage Loop

Coverage needs a real source doc to ground on. If `get_feature_coverage` is
**blocked** (`state.coverage: "blocked"`), read its `next:` field and follow
it — don't present a menu. When `next` reports no source doc ("Setup
needed", `sourceDocCount: 0`), **ask the user to attach or paste the
PRD/spec in the chat** — never invent one or pull an external file. Drop
source docs (specs, tickets, notes) into the feature with `write_feature_doc`
first.

**Step 1 — PRD summary** (author it YOURSELF; no local agent):

1. `start_external_summary(feature)` → returns a `jobId`, the source-doc
   paths, the previous requirement ids to PRESERVE, and a `prompt`.
2. Read each doc in the returned paths; extract the testable requirements.
3. `submit_external_summary(jobId, requirements[, variantDimension])`.

- Follow the returned `prompt`'s schema exactly: every requirement needs
  `title`, `text`, and `pathTypes` (`kind`, `happyPath`, `unhappyPath`,
  `variants`, `variantsNA`, `strictnessLadder` are optional; echo a prior
  requirement `id` to PRESERVE it, omit for a new one).
- If the feature has ONE cross-cutting dimension a requirement must hold
  across (channel/tenant/region/…), also pass `variantDimension {name,
  values}` and set each spanning requirement's `variants` — a requirement
  that claims "all 4 channels" but is tested on one is `variant-incomplete`,
  not covered.
- Canary reconciles ids against the prior summary (surviving ids preserved;
  new ones get fresh ids; dropped ones marked deprecated) and writes
  `docs/_prd-summary.{json,md}` — it never re-derives the requirements.
- The job is async + single-flight per feature and shows live in the GUI as
  an external session.
- Re-run whenever the ledger's `state` reports the summary `stale`
  (`state.drift.changedDocs` names which docs moved) — ids are preserved, so
  existing tags keep resolving.
- `list_feature_docs(feature)` shows what feeds the PRD; `write_feature_doc`
  adds a source doc and `delete_feature_doc(feature, relPath)` removes one.
  Source docs are `.txt`/`.pdf`/`.docx` extracted to markdown on import.
- `clear_prd_summary(feature)` resets coverage to a blank slate — removes the
  generated summary **and** strips the `@req-*`/`@path-*`/`@variant-*` tags
  from the specs (other tags kept; an emptied tag list reverts the test to
  its pre-coverage shape), so a re-map starts clean instead of inheriting
  stale tags (the UI "Redo from the start" does the same).
- If your client supports subagents, give each a subset of docs to read and
  merge their extracted requirements; otherwise read serially. Either way
  call `submit_external_summary` exactly once.

**Step 2 — coverage mapping** (map it YOURSELF; no local agent), after the
PRD summary exists:

1. `start_external_coverage(feature)` → returns the active requirements, the
   feature's tests (each with the spec `file` to read), and a `prompt`.
2. **Fan out the reading.** Group the tests by their `file` — never split one
   spec file across two readers, since a file's tests share fixtures that
   only make sense read together. If that leaves more than one group and more
   than a handful of tests, dispatch **one read-only subagent per group in a
   single parallel round** (up to 5 at once), each reading only its own
   files; below that, read them yourself. Give every subagent the FULL
   requirement list unchanged — the tests divide, the requirements do not,
   because a mapping judged against a subset of them is wrong rather than
   partial. Merge their answers.
3. `submit_external_coverage(jobId, mappings, unmappable)`.

- One mapping entry per test: `{testName, requirements: [ids], pathTypes:
  ['happy'|'sad'|'edge'], variants: […]}` (`file`, `rationale`, and
  `confidence` are optional).
- **Every test must come back — in `mappings` or in `unmappable`
  (`{testName, reason}`), never neither.** A submit that leaves tests
  unaccounted for is REJECTED with their names. A dropped test is
  indistinguishable from one you read and found no requirement for, so the
  ledger would score it uncovered on your silence instead of on evidence. If
  a subagent fails to return, say so in `unmappable` rather than omitting
  its tests.
- Link each `test()` to its requirement with **Playwright tags on the
  test**: `test('…', { tag: ['@req-R3', '@path-happy', '@variant-email'] },
  …)` — `@req-<id>` (repeatable), `@path-happy|sad|edge`, and
  `@variant-<value>` (which of the feature's variant-dimension values the
  test actually exercises). Tags are greppable and survive renames. (Legacy
  `// @requirement` / `// @path` comments above the test still parse as a
  migration fallback.)
- Canary writes the `@req-*`/`@variant-*` tags through its canonical
  tag-writer and recomputes the ledger (unknown ids/test names/variants
  dropped). It writes the *tag* (mapping) — never the test body — and there
  is **no** accept/reject review gate.
- No PRD summary yet → `status: "needs-summary"` (run `start_external_summary`
  first); single-flight per feature.
- Split by spec file, never by test count, and call
  `submit_external_coverage` exactly once with the merged answer.

**Step 3 — read the ledger.** `get_feature_coverage(feature)`: per
requirement → covering tests → `gapType` (`untested` / `path-incomplete` /
`variant-incomplete` / `covered`) + coarse `coverageStatus`
(covered/partial/uncovered), a coverage % (`covered ÷ total` — every
declared path claimed by a mapped test) and a mapped % (requirements with ≥1
test), per-test `strength` (`strong` / `solid` / `basic` / `shallow`, graded
from each test's assertion tiers — independent of runs), `orphanTestNames`
(tests with no requirement), and the derived `state` (summary × coverage
axes + headline).

**Step 4 — act on gaps.** `untested` means no test maps to the requirement
(write one, or run the coverage engine to map an existing test);
`path-incomplete` means a declared sad/edge path has no mapped test;
`variant-incomplete` means the requirement spans variant values no mapped
test exercises (test the missing variant, or add the `@variant-*` tag to a
test that already does); a `shallow` test only reaches a weak assertion tier
(write a stronger check — e.g. a browser confirming the real external effect
rather than an app log); an orphan test needs a `@req-*` tag. The UI's
full-screen Coverage dialog shows the same data — both surfaces read the
same computation.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- New tests belong to the `canary-lab-author` skill/profile; this profile maps and measures.
- Proving coverage takes a run — `canary-lab-run` (or a flight) records the run the `proven` axis reads.
