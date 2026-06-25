---
name: cl_design-feedback
description: Use when asked to critique, review, or give design feedback on any Canary Lab web UI — a screenshot, a live screen, a Figma link, or a component ("review this design", "design feedback", "what do you think of this panel/dialog/pill"). Grounds every finding in the component source + the design tokens BEFORE you voice it, so you don't flag a shared system primitive, an already-compliant value, or an intentional choice as a defect.
---

# Giving Design Feedback on Canary Lab UI

Critique is cheap to produce and expensive to act on. The trap is the confident
finding made from a screenshot alone: it reads as insight, but a screenshot can't
tell you whether what you're looking at is a *local* choice you can freely change,
a *shared system primitive* whose change ripples across the app, or a *deliberate*
decision the author already reasoned about. Voicing an ungrounded finding wastes
the user's attention; *implementing* one creates churn and inconsistency.

This skill is the companion to the `cl_ui-design-philosophy` skill: that one is for
*building*; this one is for *judging*. Apply a critique framework (usability,
hierarchy, consistency, a11y) — but ground each finding in the codebase first.

## The failure this exists to prevent

Critiquing the Portify "Plan" screen from a screenshot produced four findings.
After reading the source, **only one survived**:

| Finding from the screenshot | What the source said | Verdict |
| --- | --- | --- |
| "Glowing CTA looks marketing-y, flatten it" | It's `.cl-button-primary` — the global primary button used on every screen | ❌ Withdrawn — changing it makes this screen *inconsistent*, not better |
| "Guarantees card is too airy, tighten it" | Rows were already `padding: 10px 16px` — inside the 8–12px density rule | ❌ Withdrawn — screenshot read airy from capture scale |
| "Header/body widths are misaligned" | The stepper is intentionally centered above a centered column | ❌ Withdrawn — intent, not a bug |
| "Content is vertically centered → CTA floats with dead space" | Real local layout decision, tall content | ✅ Real + in-scope; fixed |

Three of four were noise that would have become churn. The screenshot was honest;
the *judgment* was ungrounded.

## Before you voice a single finding

1. **Read the `cl_ui-design-philosophy` skill** so "consistency" means consistency with
   *this* system (the token set, the layout precedents, meaning-carries-the-style),
   not with generic taste.
2. **Open the component source.** Find the element you're about to critique and
   read how it's actually styled — inline values, the class it uses, the tokens it
   pulls. Read nearby comments: authors here often state intent inline (e.g. "center
   so it owns the space", "drop the decorative accent — the dot already says it").
3. **Trace shared styling to its definition.** If a finding targets a `className`,
   open `styles.css` (or wherever it's defined) and see *who else uses it*. A class
   on five screens is a system decision, not this screen's.

## Classify every finding before it leaves your mouth

For each candidate, answer these — the answer often flips the verdict:

| Ask | Why it changes the verdict |
| --- | --- |
| Local style or shared primitive? | Editing a shared class/token ripples everywhere. Restyling a system button to "fix" one screen usually makes that screen the inconsistent one. Out of scope unless the user wants a system change. |
| Did I measure, or eyeball it? | "Too tight / too airy / too big" must be checked against the real px or token value. Screenshots scale; capture DPI lies. Verify density and spacing claims against the source before asserting them. |
| Bug or intent? | A comment, a deliberate width, a centered element — read for stated intent. Flagging intent as a defect burns trust. If you suspect the intent is wrong, argue the intent, not the pixels. |
| Token-native or my taste? | A recommendation that introduces a hex, a new radius, or a novel pattern is usually wrong here — the bar is *native*, not *novel*. Prefer a fix that reuses an existing precedent. |

## Report the survivors — and show the filtering

Don't dump every candidate. State the findings that survived grounding, and
briefly list what you **withdrew and why** (system-wide / already-compliant /
intentional). Showing the filter is more useful than a long list — it tells the
user the critique was grounded, not generated. Order real findings worst-first.

When you then implement (often the user's next step is "do it"), only touch what's
local and in-scope; verify per `cl_verify-changes` before claiming it works.

## On clarifying questions

When the user opens with "need design feedback" (or similar) and the artifact is
clearly about to arrive — a screenshot, a link, a launched element — wait for it
rather than firing a target/stage question menu. A question answered by "here's the
screenshot" two seconds later shouldn't have been asked. This is the design-feedback
case of the `cl_scope-the-ask` rule — see that skill for the general pattern.
