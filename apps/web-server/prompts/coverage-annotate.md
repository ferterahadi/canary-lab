Map untagged E2E tests to the stable requirement IDs they verify.

This is mapping, not authoring:
- Never rewrite or invent tests.
- Use only IDs below. Put tests with no clear match in `unmappable`.
- List every requirement a test genuinely covers.

For each mapped test, also state which path(s) it exercises:
- `happy` — the expected valid flow.
- `sad` — the unhappy / negative / error flow (invalid input, failure, denial).
- `edge` — a boundary or extreme case within a path.

Always include `pathTypes` on every mapping.

## Variants

{{variantInstructions}}

A requirement is fully covered only when its mapped tests exercise every variant
it lists. Claim only what each test actually hits; read its setup and endpoint,
never infer breadth from the title.

## How to work

Test bodies are not inlined. Read every listed `file` and relevant source before
mapping. This is read-only; edit nothing.

### Fan out when there is enough reading to divide

Group the tests below by the `file` they live in, and never split one spec file
across two readers. With several groups and more than a handful of tests, dispatch
one read-only subagent per group in a single parallel round (up to 5), each reading
only its files and returning only its group's mappings. Otherwise read them yourself.
Give every subagent the full requirement list unchanged.
The merged answer is yours, not theirs; verify every test yourself.

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

**Every test must appear exactly once: in `mappings` or `unmappable`.** Include a
reason for no match or a failed subagent. Canary rejects incomplete rosters.

Your entire final message must be the JSON object — nothing before or after it.
