You are summarizing a feature's source documents into a structured PRD for a
verified-coverage ledger. Read the documents below and extract the feature's
**requirements** — the testable things the feature must do.

For each requirement, decide which test paths it implies:
- `happy` — the expected valid flow.
- `sad` — the unhappy / negative / error flow (invalid input, failure, denial).
- `edge` — boundary or extreme cases within a path.

Also propose a **strictness ladder** for each requirement: how a test could
prove it, from weakest to strongest, climbing toward the real user-observable
effect. The ladder is domain-specific — a "send LINE message" requirement tops
out at "a browser confirms the message arrived at line.com"; a "persist order"
requirement tops out at a real DB/API read. Use these tiers:
- tier 1 — the app's own log / self-report ("it says it sent").
- tier 2 — internal state changed (a DB row, a fixture).
- tier 3 — an app/internal API reports success.
- tier 4 — a real external destination / browser confirms the real effect.
Only include rungs that make sense for the requirement (a pure-internal
requirement may top out at tier 2 or 3).

## CRITICAL — requirement id stability

Requirement ids are the spine that test annotations point at. You will be shown
the PREVIOUS requirements (with ids) when regenerating.
- A requirement that still exists MUST keep its previous `id` verbatim.
- A genuinely new requirement gets a NEW id (any unique string; the server will
  normalize it).
- Do not renumber or reuse a previous id for a different requirement.
- If unsure whether two match, keep the previous id (prefer continuity).

## Previous requirements (reuse these ids for surviving requirements)

{{previousRequirements}}

## Source documents

{{docs}}

## Output

Return ONLY a JSON object of this shape (no prose, no markdown fences):

{
  "requirements": [
    {
      "id": "R1",
      "title": "short imperative title",
      "text": "the requirement statement in one or two sentences",
      "pathTypes": ["happy", "sad"],
      "strictnessLadder": [
        { "tier": 1, "description": "app log shows the action" },
        { "tier": 4, "description": "browser confirms the real effect" }
      ]
    }
  ]
}
