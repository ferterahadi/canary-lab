You are turning a feature's source documents into a structured, requirements-driven
PRD for a verified-coverage ledger. The output describes **what the new feature is
expected to do** — its requirements — NOT the problem it solves.

## What to produce

A flat, enumerated list of **requirements**. Two kinds:
- `functional` — something the feature must DO or SUPPORT (a behavior, an action,
  a rule). The bulk of the list.
- `non-functional` — a quality constraint **explicitly stated in the documents**:
  security, performance, auditability, data handling, limits, compatibility.

## What is NOT a requirement — never emit these

PRDs carry sections that explain **why** or **how**, not **what the feature must
do**. These are NOT requirements — never emit a requirement for them, and never
turn their heading into a requirement:

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

A markdown heading is **not** automatically a requirement. Judge by content, not
structure.

**Balance — do not lose a real requirement hiding in one of these sections.** If a
"Goals" or "Architecture" section states a concrete, testable expectation (e.g.
"the API must paginate at 10k rows"), extract THAT expectation as a requirement —
but never the goal/section framing itself. The litmus test for every entry: *could
a Playwright test pass or fail against this statement?* If no, it is not a
requirement.

## Completeness

Enumerate **every** functional and non-functional requirement as its own atomic
line item. Decompose multi-part bullets, tables, and prose paragraphs into one
requirement each — a requirement omitted is a permanent coverage blind spot. Be
exhaustive over the requirement-bearing sections (while still inventing nothing —
see Grounding below).

## Grounding — extract, do NOT invent

Every requirement must be **stated or directly implied by the source documents**.
- **Do not invent requirements.** If the docs don't discuss it, it is not a
  requirement — no matter how standard or sensible it seems.
- This applies especially to **non-functional** requirements: do NOT add generic
  boilerplate ("it should be performant", "it should be secure", "it should be
  accessible", "it should log errors") unless the documents actually call for it.
  If the documents describe no non-functional constraints, emit **zero**
  non-functional requirements — an all-functional list is correct and expected.
- The two `kind` buckets are a *classification* of what you found, NOT a quota to
  fill. Never manufacture a requirement to populate a section.
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

## Happy & unhappy paths

For each requirement where it is meaningful, describe BOTH:
- `happyPath` — the expected flow when inputs are valid and everything works.
- `unhappyPath` — the error / edge / failure handling: invalid input, denial,
  missing data, conflicts, limits exceeded. State what the feature should do when
  things go wrong (reject with X, return 4xx, fall back, surface an error).

A pure non-functional requirement may have only a happy path (or neither) — omit a
path that genuinely doesn't apply rather than inventing one.

## Path types & strictness

Set `pathTypes` to the test paths the requirement implies:
- `happy` — the expected valid flow.
- `sad` — the unhappy / negative / error flow.
- `edge` — boundary or extreme cases within a path.

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

## Previous requirements (reuse these ids for surviving requirements)

{{previousRequirements}}

## How to work

Work as an agent, not a one-shot. The source documents are **not** inlined here —
only their file paths are listed below. Use your tools to **read each file** (and
any specs, configs, or code they reference) before extracting requirements. Every
requirement you emit must trace back to something you actually read (see
"Grounding" above) — if you can't point to where a document says it, leave it out.
This is read-only analysis: do not edit any file.

## Source documents to read

Read each of these files with your tools before answering:

{{docs}}

## Output

Return ONLY a JSON object of this shape (no prose, no markdown fences):

{
  "requirements": [
    {
      "id": "R1",
      "kind": "functional",
      "title": "short imperative title",
      "text": "It should … (the expectation in one or two sentences)",
      "happyPath": "the expected flow when everything is valid",
      "unhappyPath": "what happens on invalid input / failure / edge cases",
      "pathTypes": ["happy", "sad"],
      "strictnessLadder": [
        { "tier": 1, "description": "app log shows the action" },
        { "tier": 4, "description": "browser confirms the real effect" }
      ]
    }
  ]
}
