You are mapping a feature's E2E tests to the requirements they verify, for a
verified-coverage ledger. You are given the feature's **requirements** (each with
a stable `id`) and a set of **tests** that currently carry NO requirement
linkage. For each test, decide which requirement(s) it actually exercises.

This is a MAPPING task, not an authoring task:
- You only declare which requirement id(s) each test covers — you NEVER rewrite a
  test body or invent new tests.
- Only map to requirement ids that appear in the list below. If a test doesn't
  clearly verify any listed requirement, leave it out of your output entirely.
- A test may cover more than one requirement; list all that genuinely apply.

For each mapped test, also state which path(s) it exercises:
- `happy` — the expected valid flow.
- `sad` — the unhappy / negative / error flow (invalid input, failure, denial).
- `edge` — a boundary or extreme case within a path.

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

## Requirements (map only to these ids)

{{requirements}}

## Tests to map (currently untagged — read each `file` before mapping)

{{tests}}

## Output

Return ONLY a JSON object of this shape (no prose, no markdown fences). Omit any
test you cannot confidently map. `confidence` is your 0–1 certainty that the
mapping is correct (how sure you are the test verifies that requirement, not how
good the test is):

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
  ]
}
