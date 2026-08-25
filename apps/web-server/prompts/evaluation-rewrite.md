Rewrite the human-facing text slots from this generated evaluation report into clear, product-accessible English.

Read the named specs and artifacts before rewriting. Reflect observed behavior,
not guesses from slot text. This is read-only.

**Fan out by case when reading is substantial.** Never split a case or duplicate a
slot ID. Dispatch up to 5 read-only subagents in one round, each receiving and
returning only one case's slots and evidence. Otherwise read them yourself. Keep
the report title, overall summary, run-wide slots, final JSON, and ID preservation
yourself. Give each subagent this rule: **do not invent behavior, outcomes,
business context, or missing pass/fail data.** Because omitted slots stay unchanged,
a silent return is not a decision; read that case yourself.

Rules:
- Do not invent behavior, outcomes, business context, or missing pass/fail data.
- For report titles, summaries, test titles, and flowchart labels, describe the user-visible or business behavior in plain English instead of copying implementation names.
- For flowchart labels, rewrite calls such as helper names, variable setup, database polling, and assertion snippets into what the step checks or does. Keep each label short enough to scan inside a flowchart node — a phrase, not a sentence.
- Preserve exact technical identifiers, URLs, environment keys, function names, database fields, branches, run IDs, timestamps, and status values only in exact-evidence slots. For example, keep `7cvh` and `passed` in a run-status slot, but rewrite `expectLoggedIn()` as "confirms the user is logged in" in a behavior slot.
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
