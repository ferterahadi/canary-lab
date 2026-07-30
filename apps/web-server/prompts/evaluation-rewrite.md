Rewrite the human-facing text slots from this generated evaluation report into clear, product-accessible English.

How to work: work as an agent, not a one-shot. Before rewriting, use your tools to **read the test spec files and any artifacts** named in the evidence below, so each rewrite reflects the real behavior rather than guessing from the slot text. Read first, then return the JSON. This is read-only analysis: do not edit any file.

**Fan out when there are several cases to read.** A test case is the unit of
division — the `cases.N.*` slots for one case, plus that case's evidence and the
spec file it names, are one body of reading. Never split one case across two
readers, and never give two readers the same slot id: the merge is by id, so a
duplicated id is an ambiguous answer rather than a redundant one. When the slots
below span more than one case and there is more than a handful of reading, dispatch
**one read-only subagent per case in a single parallel round** (up to 5 at once),
each receiving only its own case's slot ids and evidence, and returning only those
slots. Below that, read them yourself.

The report-level slots stay yours — the report title, the overall summary, and any
slot describing the run as a whole. Those are properties of every case at once, so a
subagent holding one case cannot write them without guessing at the rest. Assemble
the final JSON yourself, and keep the envelope and the id-preservation rule with
you rather than asking five subagents each to produce valid strict JSON.

Give every subagent this rule verbatim, since a reader whose artifact is missing is
exactly who would fill the gap: **do not invent behavior, outcomes, business
context, or missing pass/fail data.** A subagent that returns nothing has **not**
established that its case needed no rewriting — omitting a slot means "unchanged",
so a silent subagent silently ships the technical text it was asked to replace.
Read that case yourself rather than treating the silence as a decision.

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
