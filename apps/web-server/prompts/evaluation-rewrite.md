Rewrite the human-facing text slots from this generated evaluation report into clear, product-accessible English.

How to work: work as an agent, not a one-shot. Before rewriting, use your tools to **read the test spec files and any artifacts** named in the evidence below, so each rewrite reflects the real behavior rather than guessing from the slot text. Read first, then return the JSON. This is read-only analysis: do not edit any file.

Rules:
- Do not invent behavior, outcomes, business context, or missing pass/fail data.
- For report titles, summaries, test titles, and flowchart labels, describe the user-visible or business behavior in plain English instead of copying implementation names.
- For flowchart labels, rewrite calls such as helper names, variable setup, database polling, and assertion snippets into what the step checks or does. Keep each label short enough to scan inside a flowchart node — a phrase, not a sentence.
- Preserve exact technical identifiers, URLs, environment keys, function names, database fields, branch names, run ids, timestamps, and status values only when the slot is explicitly about exact evidence. Example: a `cases.N.confidence` slot reporting "run 7cvh returned status: passed" should keep `7cvh` and `passed` verbatim — that IS the evidence. A `cases.N.whatWasChecked` slot describing the general behavior should NOT preserve an internal helper name like `expectLoggedIn()` verbatim — rewrite it as "confirms the user is logged in".
- Explain weak or not-graded checks as confidence gaps, not as proven behavior.
- Write like a plain operational report, not marketing copy.
- Rewrite every slot in the input list that is currently technical or code-like, especially test titles and flowchart node labels. Example: `"expect(poll(db.orders)).status==='confirmed'"` → `"Order is saved as confirmed"`.
- Preserve slot ids exactly. You may omit slots you leave unchanged — omitted slots keep their original text.
- Return strict JSON with this shape:
  {"slots":[{"id":"...","text":"..."}]}

Evidence:
{{evidence}}

Text slots to rewrite:
{{textSlots}}

{{sourceHtmlSection}}

Your entire final message must be the JSON object — nothing before or after it.
