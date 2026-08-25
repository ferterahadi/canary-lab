Turn source documents into requirements for a verified-coverage ledger. Describe
**what the feature must do**, not the problem it solves.

## What to produce

A flat, enumerated list of **requirements**. Two kinds:
- `functional` — something the feature must DO or SUPPORT (a behavior, an action,
  a rule). The bulk of the list.
- `non-functional` — a quality constraint **explicitly stated in the documents**:
  security, performance, auditability, data handling, limits, compatibility.

## What is NOT a requirement — never emit these

Do not turn sections about **why** or **how** into requirements:

- Goals / Objectives
- Background / Context
- Problem statement / Motivation / Why
- Overview / Introduction / Summary
- Architecture / Design / Implementation / Technical approach
- Non-goals / Out-of-scope
- Glossary / Definitions
- Open questions
- Milestones / Timeline / Rollout
- Success metrics

A heading is not a requirement. Judge its content.

Still extract concrete expectations found in those sections. The test is: *could
a Playwright test pass or fail against this statement?*

## Completeness

Extract every requirement as one atomic item. Split compound bullets, tables, and
paragraphs without inventing content.

## Grounding — extract, do NOT invent

Every requirement must be **stated or directly implied by the source**.
- **Do not invent requirements.** If the docs don't discuss it, it is not a
  requirement — no matter how standard or sensible it seems.
- Never add generic non-functional boilerplate. If the source states none, emit none.
- `kind` classifies findings; it is not a quota.
- If a detail is ambiguous, prefer fewer, well-grounded requirements over more,
  speculative ones. Coverage is measured against this list, so an invented
  requirement becomes a permanent phantom gap.

Hard rules on framing:
- **Do NOT write a problem statement, background, or narrative preamble.** No
  "Currently users cannot…", no motivation. Go straight to the expectations.
- Phrase each requirement's `text` as an expectation in the **"it should …"**
  form — "It should issue a token on approval", "It should support an
  account-scoped PAT". One or two sentences, concrete and testable.
- Keep each requirement atomic — one expectation per entry. Split compound asks.

## Variant dimension (cross-cutting breadth)

Some requirements span one cross-cutting dimension such as channel, tenant,
region, role, or plan tier. Testing one value does not cover a requirement that
names several.

Detect AT MOST ONE such dimension for the whole feature:
- Emit a top-level `variantDimension` with a lower-case single-token `name` and the
  closed set of `values` (≥ 2). Only when the documents genuinely describe one.
- **Most features have none.** If nothing cross-cuts the requirements this way,
  OMIT `variantDimension` entirely — do not invent one.
- Then, on each requirement that must hold across **two or more** of those values,
  set `variants` to exactly those values (a subset of `variantDimension.values`).
  A requirement that concerns only one value — or none — OMITS `variants`.

The litmus test: would a reviewer accept "we tested it on email" as proof a
requirement about *all four channels* is done? If no, that requirement spans
variants and must list them.

**Not-applicable variants.** When a named variant has no testable surface:
- Keep the variant in `variants` (the requirement conceptually spans it), AND
- Add it to `variantsNA` with a concrete `reason` (what's missing).
`variantsNA` excludes that value from coverage and shows the reason. Use it only
after confirming no surface exists, not because no test exists. When unsure, keep
the gap visible.

## Happy & unhappy paths

For each requirement where it is meaningful, describe BOTH:
- `happyPath` — the expected flow when inputs are valid and everything works.
- `unhappyPath` — the error / edge / failure handling: invalid input, denial,
  missing data, conflicts, limits exceeded. State what the feature should do when
  things go wrong (reject with X, return 4xx, fall back, surface an error).

A pure non-functional requirement may have only a happy path (or neither) — omit a
path that genuinely doesn't apply rather than inventing one.

**A failed assertion is evidence, not an unhappy path.** “The test fails/stops
when the returned value is wrong” does not describe application error handling
and MUST NOT add `sad` to `pathTypes`. Add `sad` only when the source requires a
distinct user- or API-observable response to an invalid, denied, missing,
conflicting, or failed condition. When the docs explicitly limit a feature to a
happy-path journey and exclude defensive branches, its value/status assertions
remain `happy` only.

## Path types & strictness

Set `pathTypes` to the test paths the requirement implies:
- `happy` — the expected valid flow.
- `sad` — the unhappy / negative / error flow.
- `edge` — boundary or extreme cases within a path.

Always emit `pathTypes` on every requirement — use `[]` when no test path applies.

Also propose a `strictnessLadder` — how a test could prove the requirement, weakest
to strongest, climbing toward the real user-observable effect (domain-specific):
- tier 1 — the app's own log / self-report ("it says it did").
- tier 2 — internal state changed (a DB row, a fixture).
- tier 3 — an app/internal API reports success.
- tier 4 — a real external destination / browser confirms the real effect.
Only include rungs that make sense (a pure-internal requirement may top at tier 2–3).

## CRITICAL — requirement id stability

Requirement ids are the spine that test annotations point at. You will be shown the
PREVIOUS requirements (with ids) when regenerating.
- A requirement that still exists MUST keep its previous `id` verbatim.
- A genuinely new requirement gets a NEW id (any unique string; the server normalizes it).
- Do not renumber or reuse a previous id for a different requirement.
- If unsure whether two match, keep the previous id (prefer continuity).
- Previous entries with `"deprecated": true` were removed from the docs; do not re-emit them unless the current documents still state them.

## Previous requirements (reuse these ids for surviving requirements)

{{previousRequirements}}

## Previous variant dimension (keep it stable if it still applies)

{{previousVariantDimension}}

## How to work

Read every listed document and relevant referenced specs, config, or code. Every
requirement must trace to something you read. This is read-only.

### Fan out when there is enough reading to divide

A document is the unit of work: never split one document across two readers. With
several documents and substantial reading, dispatch one read-only
subagent per document in a single
parallel round (up to 5); each reads only its file and
references and returns only that file's requirements. Otherwise read them yourself.

Give each the full previous list and ID-stability rule verbatim.
The documents divide; the id spine does not. Two whole-feature judgments are never delegated:
the single `variantDimension` and de-duplication across returns.

A silent subagent has **not** established that its document has no requirements;
it failed to report. Read it yourself and account for every document.

## Source documents to read

Read each of these files with your tools before answering:

{{docs}}

## Output

Return ONLY a JSON object of this shape (no prose, no markdown fences). Omit
`variantDimension` (and every `variants`) entirely when the feature has no
cross-cutting dimension. Every requirement object MUST include `id` and `kind`.

{
  "variantDimension": { "name": "channel", "values": ["email", "whatsapp", "call", "line"] },
  "requirements": [
    {
      "id": "R1",
      "kind": "functional",
      "title": "short imperative title",
      "text": "It should … (the expectation in one or two sentences)",
      "happyPath": "the expected flow when everything is valid",
      "unhappyPath": "what happens on invalid input / failure / edge cases",
      "pathTypes": ["happy", "sad"],
      "variants": ["email", "whatsapp", "call", "line"],
      "variantsNA": [{ "variant": "whatsapp", "reason": "no v2 read endpoint exists" }],
      "strictnessLadder": [
        { "tier": 1, "description": "app log shows the action" },
        { "tier": 4, "description": "browser confirms the real effect" }
      ]
    }
  ]
}

Your entire final message must be the JSON object — nothing before or after it.
