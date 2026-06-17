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

## Requirements (map only to these ids)

{{requirements}}

## Tests to map (currently untagged)

{{tests}}

## Output

Return ONLY a JSON object of this shape (no prose, no markdown fences). Omit any
test you cannot confidently map:

{
  "mappings": [
    {
      "testName": "exact test name as given",
      "requirements": ["R1"],
      "pathTypes": ["happy"],
      "rationale": "one short sentence on why this test verifies that requirement",
      "confidence": 0.0
    }
  ]
}
