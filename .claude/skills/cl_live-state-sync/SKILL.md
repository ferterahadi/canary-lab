---
name: cl_live-state-sync
description: Use when a UI must react in real time to a backend state change — a status flip, a panel swap, a list update, anything driven by a workspace/broadcast event — or when a user reports that something "only updates after I refresh", "doesn't update live", "the toggle/swap didn't happen until reload", or a live view feels stale. Also use when choosing how the client learns about a server-side change (broadcast push vs task-scoped stream vs refetch). Prevents gating a correctness-critical UI transition on a single best-effort push that can silently fail to deliver.
---

# Live State Sync (push is best-effort; back the transition)

The expensive mistake on this codebase: **gating a real-time UI transition on a
single broadcast push.** The server persisted the new state correctly and emitted a
`*-updated` workspace event; the dialog was supposed to flip (text progress →
`AgentSessionView`) when that event arrived. It didn't — the broadcast simply wasn't
delivered to that client — so the panel stayed on the old view until the user hit
refresh, at which point the page-load REST read carried the truth the push had
dropped. The fix wasn't "debug the push"; it was **stop depending on it alone.**

## The diagnostic fingerprint

> "It only updates after I refresh the page."

That single sentence almost always means the same thing: **the persisted state is
correct (the REST read on reload proves it), and the live channel that was supposed
to carry the change didn't.** Don't go hunting in the store or the writer — they're
fine. The bug is in how the client *learns about* the change while open.

## Two kinds of channel — know which is reliable for what

| Channel | Nature | Trust for a correctness-critical transition? |
| --- | --- | --- |
| **Broadcast push** — a workspace/fan-out event (`*-created/-updated/-deleted`) to every connected client | Best-effort, one-shot, no per-client replay; a dropped/late frame is silently lost | **No, not alone.** Great as a fast-path hint, never the sole trigger |
| **Task-scoped stream** — the per-job WS you already opened to watch *this* thing (the export log WS, the agent-session tail) | Reliable for the object you're subscribed to; you can see it's alive (data is flowing) | **Yes** — if data is streaming, this channel works; hang the transition off it |
| **On-demand refetch** — `GET …/:id` for the one record | Authoritative; what a page refresh does | **Yes** — the reliable fallback; refetch on a signal you *do* receive |

## The rule

**A UI transition that must happen may not depend solely on a broadcast push.** Back
it with a channel you can trust:

- Keep the push as the fast path (when it lands, great — flip immediately).
- **Also** drive the same transition off the reliable per-task stream you already
  hold: when that stream emits a signal implying the state changed, **refetch the
  record once** and let the refetched truth flip the UI. Make it **self-limiting** —
  stop refetching the moment the awaited field lands, so you don't poll forever.

Worked example (this session): the export dialog swaps to `AgentSessionView` once the
rewrite agent pins its `sessionRef`. The reliable signal is the per-task log WS (it's
visibly streaming the agent's lines). When a chunk matches the agent-start marker and
the task still lacks `sessionRef`, refetch the task once; the refetched `sessionRef`
flips the panel. The workspace-event push still flips it instantly when it *does*
arrive — but the log-stream refetch guarantees it even when the push is lost.

```
onData: (chunk) => {
  appendLog(taskId, chunk)
  if (!tasksById[taskId]?.sessionRef && /<agent-start marker>/.test(chunk)) {
    void refetchTask(taskId)        // self-limiting: stops once sessionRef lands
  }
}
```

**Second instance (coverage dialog, items 1+2):** the Docs rail must show the
generated `_prd-summary.md` the moment generation finishes — not after a manual
refresh. The fix was *not* the `coverage-changed` broadcast; it was bumping a
`docsReloadKey` off the **reliable `pollJob` completion** (the per-task poll the
dialog already holds), which the rail watches to re-list itself. Same rule: a
must-happen update rides the channel you can trust, not the fan-out push.

## Verify the transition, not just the persistence

The trap that let this ship: claiming "it'll swap live" after only confirming the
state was *persisted* (and that a refresh showed it). Those prove the write path, not
the live path. The live transition is a separate behaviour and must be observed
separately — watch it flip *while the job runs*, without reloading.

If you genuinely can't observe the live path locally (the wire needs the user's
`canary-apply` env — see [[cl_verify-changes]]), **say the live path is unverified**
rather than asserting it works. "Persisted + works on refresh; the live swap I
couldn't exercise here" is the honest report.

## Common mistakes

| Mistake | Symptom | Fix |
| --- | --- | --- |
| Transition gated only on a broadcast push | "only updates after refresh" | Also refetch off the reliable per-task stream; push stays as fast path |
| Treated push delivery as guaranteed | Intermittent stale UI, hard to reproduce | Treat broadcasts as best-effort hints; never the sole trigger for a must-happen change |
| Refetch loop with no stop condition | Hammers `GET …/:id` for the whole job | Gate on "awaited field still missing"; stop once it lands |
| Verified persistence, claimed live works | Ships broken; user finds it | Observe the transition mid-job without reloading, or flag it unverified |

## Relationship to the neighbours

- [[cl_async-task-ux]] — the server-side job contract (persistent, recoverable,
  re-openable). This skill is the **client** half: how the open UI learns a job's
  state changed and reacts reliably.
- [[cl_surfacing-agent-work]] — match the agent *view* to what the agent emits; its
  "persist the LIVE lifecycle, not just navigation" point is the rehydrate-on-open
  cousin of this rule.
- [[cl_ui-design-philosophy]] — "A live UI transition needs a reliable trigger, not
  just a push" and "one owner for a long-lived lifecycle" are the design-language
  statements of the same idea.

## Verify

Client live-sync logic (refetch-on-marker, self-limiting guards) is happy-dom /
unit-testable without a live server. The actual broadcast delivery and the end-to-end
live transition are the user's `canary-apply` trial (never run it — see
[[cl_verify-changes]]). Typecheck with `tsconfig.build.json`.
