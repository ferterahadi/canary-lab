// The words that travel with every `weaker` hint (D13), on both sides of the
// wire: the server writes them onto the run manifest and into MCP results; the
// web shows them beside a hint that has no run to read them from (a spec edited
// between runs). One home so the two can never disagree.
//
// The numbers are the Phase 1 measurement and nothing newer: a `weaker` verdict
// was wrong on 2.4% of the frozen 140-pair public-repository holdout (strict —
// the edit was equivalent or stronger), labelled by one AI and checked blind by a
// second AI on 40 pairs; no human labelled it. Quote the rate only with the
// disclosure, never alone.

/** Advisory framing plus how the detection was checked. Shown wherever a hint is. */
export const INTEGRITY_HINT_DISCLOSURE =
  'Advisory only — this hint never changes a verdict. Its detection was checked by AI: one AI labelled, a second AI checked blind, no human.'

/** The `weaker` hint's measured false-positive rate, as a reader sees it. */
export const INTEGRITY_HINT_FALSE_POSITIVE_RATE = '2.4%'

/** One sentence for a surface that has room for the rate: what the hint claims,
 *  how often that claim was wrong, and the disclosure. */
export const INTEGRITY_HINT_COPY =
  `A hint, not a verdict: the differential read this edit as weaker than what ran. On the frozen public-repo holdout that reading was wrong ${INTEGRITY_HINT_FALSE_POSITIVE_RATE} of the time. ${INTEGRITY_HINT_DISCLOSURE}`
