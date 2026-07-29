You are mapping a feature's E2E tests to the requirements they verify, for a
verified-coverage ledger. You are given the feature's **requirements** (each with
a stable `id`) and a set of **tests** that currently carry NO requirement
linkage. For each test, decide which requirement(s) it actually exercises.

This is a MAPPING task, not an authoring task:
- You only declare which requirement id(s) each test covers — you NEVER rewrite a
  test body or invent new tests.
- Only map to requirement ids that appear in the list below. A test that doesn't
  clearly verify any listed requirement goes in `unmappable` (see Output) — never
  omit it.
- A test may cover more than one requirement; list all that genuinely apply.

For each mapped test, also state which path(s) it exercises:
- `happy` — the expected valid flow.
- `sad` — the unhappy / negative / error flow (invalid input, failure, denial).
- `edge` — a boundary or extreme case within a path.

Always include `pathTypes` on every mapping.

## Variants

{{variantInstructions}}

When a variant dimension applies, a requirement is only fully covered once EVERY
variant it lists is exercised by some test. So your `variants` per test must
reflect what the test ACTUALLY hits — read the endpoint / fixture / setup, don't
infer breadth from the test name. A test that drives only one variant must claim
only that one, even if the requirement it maps to lists several.

## How to work

Work as an agent, not a one-shot. The test bodies are **not** inlined here — each
test below is just a name + the path to its spec file. Use your tools to **read the
actual test file** (the `file` shown) and grep the source it touches, so each
mapping reflects what the test really exercises. Read first, then decide the
mappings. This is read-only analysis: do not edit any file.

### Fan out when there is enough reading to divide

Group the tests below by the `file` they live in, and never split one spec file
across two readers — tests in a file share fixtures and setup that only make
sense read together. If that leaves you more than one group and more than a
handful of tests, dispatch **one read-only subagent per group in a single
parallel round** (up to 5 at once), each reading only its own files and
returning only its own group's mappings. Below that, read them yourself; the
round trips cost more than the reading.

Give every subagent the full requirement list unchanged. The tests divide; the
requirements do not, because a mapping judged against a subset of the
requirements is wrong rather than partial.

The merged answer is yours, not theirs. Check it accounts for every test before
you send it — see the roster rule under Output.

## Requirements (map only to these ids)

{{requirements}}

## Tests to map (currently untagged — read each `file` before mapping)

{{tests}}

## Output

Return ONLY a JSON object of this shape (no prose, no markdown fences).
`confidence` is your 0–1 certainty that the mapping is correct (how sure you are
the test verifies that requirement, not how good the test is):

{
  "mappings": [
    {
      "testName": "exact test name as given",
      "requirements": ["R1"],
      "pathTypes": ["happy"],
      "variants": ["email"],
      "rationale": "one short sentence on why this test verifies that requirement",
      "confidence": 0.9
    }
  ],
  "unmappable": [
    { "testName": "exact test name as given", "reason": "one short sentence" }
  ]
}

**Every test listed above must appear exactly once — in `mappings` or in
`unmappable`, never both and never neither.** A test you read and found no
requirement for goes in `unmappable` with the reason. Silently dropping it
instead would be indistinguishable from never having read it, and the ledger
would score it as uncovered on your say-so rather than on evidence. Canary checks
this roster and rejects an answer that does not account for every test — so if a
subagent fails to return, say so in `unmappable` rather than omitting its tests.

Your entire final message must be the JSON object — nothing before or after it.
