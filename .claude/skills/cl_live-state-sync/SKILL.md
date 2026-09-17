---
name: cl_live-state-sync
description: Use whenever a Canary Lab change affects state shown in an open UI or consumed by a connected Claude/Codex workflow, including documents, test files, run results, jobs, and derived coverage. Requires live delivery and recovery without manual refresh; also use for stale-view reports.
metadata:
  internal: true
---

# Live State Sync — keep every consumer current

Read `cl_ws-driven-state` for the producer and event wiring. This skill covers
the consumers and their recovery. These are acceptance requirements; they do not
claim that every existing surface already satisfies them.

## 2026-09-17 — Every affected open view updates without user action

- **Rule:** Canary must display the current authoritative state while the view
  stays open. Never require a browser refresh, closing/reopening a dialog,
  restarting Canary, or a new user command to reveal a change. This applies to
  every state change, not only the feature's main happy path.
- **Why:** The user relies on Canary to notice changes. Making the user discover
  stale information or remind each agent about reactivity breaks that promise.
- **How to apply:** Trace each changed fact from its producer through every
  dependent view and agent consumer. Correct persistence and one refreshed panel
  do not establish that the feature is live. Treat a missing dependency as a
  defect, not an acceptable workaround or a low-value exception.

Account for all writers: GUI actions, MCP tools, internal/external agents, direct
file saves/additions/deletions, linked-source edits, and standalone run results.
File-backed inputs need change detection for the actual source, including linked
targets. If a connection or read fails, show disconnected/stale/error state and
recover automatically; do not silently present old data as current.

Derived data has its own dependencies. For coverage, inspect at least:

| Changed fact | Consumers that must update |
| --- | --- |
| Selected source document or linked target | Source text, summary/mapping freshness, affected requirements, actionable stale-state notice |
| Test added/deleted, body or tags edited | Test roster/count, expanded source, mapping/path gaps, depth, proof freshness |
| Run summary or lifecycle changes | Latest result, path pass/fail/not-run cells, proof provenance, requirement detail and headline |
| Summary/mapping job or external workflow changes | Job progress, generated documents, ledger, Flight stage evidence, connected workflow |

Automatic detection/refetch does not itself regenerate requirements, infer new
tags, or rerun tests. When recovery needs such work, show a clear action routed to
the earliest invalid stage: changed documents need requirements then mapping;
stale mappings need mapping. Honour existing workflow ownership and launch policy,
reuse valid earlier stages, and avoid duplicate Flights. Do not report a
notification/action as implemented until its source and click path are verified.

## 2026-09-17 — Connected agents receive relevant changes

- **Rule:** A connected Claude/Codex workflow must have a supported way to learn
  that relevant documents, tests, coverage, run outcomes, or required actions
  changed, without the user copying updates into chat or reconnecting the client.
- **Why:** The agent makes decisions from the same changing workspace as the UI;
  stale context can send it down the wrong workflow or report obsolete evidence.
- **How to apply:** Identify the target client and its actual delivery capability.
  Use supported MCP notifications/subscriptions or a bounded wait/change read
  with a cursor; provide missed changes in the next relevant tool response when
  unsolicited delivery is unavailable. Keep a recoverable revision/snapshot so
  reconnects and missed signals catch up. Expose suite/run identity, what changed,
  freshness and the supported next action; coalesce duplicate/no-op updates.

UI WebSocket delivery does not prove agent delivery. A transport notification
also does not prove that Claude/Codex received it in model context or can wake an
idle turn. Verify the actual client-visible response/wait path, name unsupported
capabilities honestly, and document the fallback. Receiving new state does not
authorize the agent to start unrelated work or an unrequested rerun.

The expensive mistake on this codebase: **gating a real-time UI transition on a
single broadcast push.** The server persisted the new state correctly and emitted a
`*-updated` workspace event; the dialog was supposed to flip (text progress →
`AgentSessionView`) when that event arrived. It didn't — the broadcast simply wasn't
delivered to that client — so the panel stayed on the old view until the user hit
refresh, at which point the page-load REST read carried the truth the push had
dropped. The fix wasn't "debug the push"; it was **stop depending on it alone.**

## The diagnostic fingerprint

> "It only updates after I refresh the page."

If reload shows the right state, the read path can obtain it. That does not prove
that the writer emitted a signal, that all consumers subscribed, or that reconnect
recovery works. Inspect the complete producer → event → invalidation → reader →
render chain before choosing the fix.

## Delivery and recovery channels

| Channel | Nature | Trust for a correctness-critical transition? |
| --- | --- | --- |
| **Broadcast push** — a workspace/fan-out event (`*-created/-updated/-deleted`) to every connected client | Best-effort, one-shot, no per-client replay; a dropped/late frame is silently lost | **No, not alone.** Great as a fast-path hint, never the sole trigger |
| **Task-scoped stream** — the per-job WS already watching this job | Provides object-scoped signals; still needs reconnect recovery | Use its state changes/completion to refetch authoritative state; resync after reconnect |
| **Automatic scoped refetch** — read the affected record | Authoritative snapshot; still requires a trigger | Back push with a reliable task signal or bounded reconciliation while the view/task is active |

## The rule

**A UI transition that must happen may not depend solely on a broadcast push.** Back
it with a channel you can trust:

- Keep the push as the fast path (when it lands, great — flip immediately).
- **Also** drive the same transition off the reliable per-task stream you already
  hold: when that stream emits a signal implying the state changed, **refetch the
  record** and let the refetched truth flip the UI. Make it **self-limiting** —
  stop awaiting the field once it lands, and release listeners/timers when the
  view closes or the task ends. Where no reliable task signal exists, use bounded
  reconciliation while the view/task is active. Define and test its recovery
  bound; do not ban a necessary fallback just because the fast path is push.
- **Guard ordering:** ignore an older in-flight response when a newer revision or
  selected entity has already arrived. Preserve selection, expanded rows, scroll
  position, and unsaved edits during refresh.

Worked example: the export dialog swaps to `AgentSessionView` once the
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

**Second instance (coverage dialog):** the Docs rail must show the
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

For each changed producer/consumer, keep the view or agent session open, change
the authoritative input from another writer, and assert the dependent values
update without remounting, navigating, refreshing, or a compensating manual read.
Exercise missed-event/reconnect recovery and a late response that must not
overwrite newer state. For coverage, include direct docs/tests edits and a new
standalone run result, not only a coverage-job completion. A test asserting only
that `publishWorkspaceEvent` was called cannot prove any of these transitions.

Keep evidence labels precise during updates: mapped/covered is separate from
latest-run pass/fail/not-run. Historical proof must name its source run and must
not masquerade as the latest result. Do not display guessed success while waiting
for authoritative evidence.

If you genuinely can't observe the live path locally (the wire needs the
`canary-apply` cycle — see [[cl_verify-changes]] Tier 3), **say it's unverified**
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
live transition need the `canary-apply` cycle (see [[cl_verify-changes]] Tier 3 for
who runs it). Typecheck with `tsconfig.build.json`.
