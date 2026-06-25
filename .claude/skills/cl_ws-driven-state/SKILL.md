---
name: cl_ws-driven-state
description: Use whenever you add or modify a server-side mutation (new route, background job completion, MCP tool write) that changes something visible in the UI — feature list, badges, coverage icons, run states, anything. Also use when a user says "I had to refresh to see X" or "the badge didn't update until I reloaded". The rule: every mutation that affects UI state must emit a WorkspaceEvent so the client updates live. No broadcast event → stale UI, always.
---

# WS-Driven State — Every Mutation Emits an Event

The pattern the project enforces: **UI state is never polled and never requires a
manual refresh.** When the server mutates something visible, it emits a
`WorkspaceEvent`. The client's WebSocket connection picks it up and re-fetches exactly
the data that changed.

Forgetting this is the primary cause of "I had to refresh to see X."

## The full event chain

```
Server mutation (route / job runner / MCP tool)
  → publishWorkspaceEvent(deps.workspaceEvents, { type: '...' })
  → WorkspaceEventBus  (apps/web-server/src/shared/workspace-events.ts)
  → ws/workspace-stream.ts  broadcasts JSON to every open client socket
  → apps/web/src/features/runs/api/workspace-socket.ts  parses the frame
  → App.tsx  onEvent handler  dispatches to state setter
  → component re-renders with fresh REST data
```

Nothing in this chain polls. Nothing auto-retries. If you don't call
`publishWorkspaceEvent`, the client never learns.

## Existing event types

| Event type | What it signals | Client action |
|---|---|---|
| `feature-created` | A new feature dir was created | `refreshFeatures(newFeature)` |
| `feature-deleted` | A feature dir was removed | `refreshFeatures()` |
| `features-changed` | Any `Feature` field changed (config, envs, portified) | `refreshFeatures()` |
| `tests-changed` | Test files for a feature changed | `setTestsRefreshKey(k+1)` |
| `envsets-changed` | Envset added/removed for a feature | `refreshFeatures()` |
| `coverage-changed` | A coverage job finished (done or failed) | `setCoverageRefreshKey(k+1)` |
| `draft-created/updated/deleted` | Wizard draft mutations | draft context reducer |
| `evaluation-export-*` | Eval export task lifecycle | export task context |

Pick the narrowest type that fits. `features-changed` is a catch-all for the feature
list; `coverage-changed` is scoped to coverage headlines. Prefer scoped events — they
avoid unnecessary re-fetches across all features.

## Checklist — adding a new mutation

Before closing a PR for any route, job runner, or MCP tool that writes to disk:

1. **What does this change in the UI?**  
   Feature list fields (name/repos/envs/portified)? Coverage icon color? Something
   else? If the answer is "nothing visible", you're done. Otherwise continue.

2. **Which event type fits?**  
   Use an existing type if it covers the change (see table above). If nothing fits,
   add a new type (steps below).

3. **Inject `workspaceEvents`**  
   The route/runner/tool must receive a `WorkspaceEventPublisher` dep (optional, same
   pattern as every other route — absent in tests, real bus in `server.ts`).

4. **Call `publishWorkspaceEvent`** after the mutation succeeds (not before, not in
   the catch — a failed write should not signal a change).

5. **Add the type to both sides** if it's new:
   - `apps/web-server/src/shared/workspace-events.ts` — `WorkspaceEvent` union
   - `apps/web/src/features/runs/api/workspace-socket.ts` — client `WorkspaceEvent` union

6. **Handle it in `App.tsx`** — add a branch in the `onEvent` handler:
   - For feature-list changes: call `refreshFeatures()`
   - For component-local data: add a `refreshKey` state, increment it, pass as prop
   - The component's `useEffect` dep array includes the key → re-fetches on change

7. **Wire `workspaceEvents` in `server.ts`** for the new route/runner.

## How to add a new event type (full example)

The two gaps fixed in session (2026-06-19) are the reference:

**Portify save** — `POST /api/portify/:id/save` writes the overlay to disk but
previously emitted no event. Badge stayed stale until the user clicked "Done" in the
wizard or refreshed.

Fix: added `publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })`
after `savePortify` returns in `routes/portify.ts`, added `workspaceEvents` to
`PortifyRouteDeps`, and passed it from `server.ts`.

**Coverage job completion** — `finishOk` / `finishErr` in
`lib/coverage/jobs/runner.ts` wrote the manifest to disk but never told the client.
The coverage icon color stayed "Generating" (sky) forever.

Fix: added `coverage-changed` event type to both `WorkspaceEvent` unions, called
`publishWorkspaceEvent` in both `finishOk` and `finishErr`, added `workspaceEvents` to
`CoverageJobRunnerDeps`, threaded it through `CoverageRouteDeps`, and wired it in
`server.ts`. On the client: `App.tsx` increments `coverageRefreshKey` on
`coverage-changed`; `FeaturesColumn` includes it in the `listCoverageStates`
`useEffect` deps.

## Both surfaces, or it's only half-wired

A user-visible mutation almost always has **two** entry points: the GUI's REST route
*and* an MCP tool (driven from Claude Desktop / Codex / CLI). They are separate code
paths into the same write — wiring the event on one does **not** cover the other. The
rule the user holds you to:

> Whether triggered by an MCP tool or by the GUI, the change must show up live — the
> user must never refresh to see the latest state.

So for every mutation, ask "what are *all* the ways this gets triggered?" and emit the
event on each. The 2026-06-25 portify regression was exactly this: the REST route
`POST /api/portify/:id/save` emitted `features-changed`, but the MCP `save_portify` /
`remove_portification` tools (the Desktop path) did not — so portifying from Desktop
left the badge stale until a manual refresh.

## Audit — reviewing an existing route for completeness

When reviewing a mutation that is NOT yours, check **both** surfaces:

```
grep -rn "publishWorkspaceEvent" apps/web-server/src/features/   # REST routes + job runners
grep -rn "publishWorkspaceEvent" apps/web-server/mcp/tools.ts    # MCP tools (Desktop/Codex/CLI)
```

Anything that writes to disk but has no `publishWorkspaceEvent` call is a candidate
for a gap. Cross-check against the UI: does this write affect a visible field? If yes,
it needs an event — on *every* path that performs the write, not just the GUI one.

## Relationship to neighbours

- [[cl_live-state-sync]] — the **client** side: once the event arrives, don't gate a
  must-happen UI transition on a single push. This skill is the **server** side: make
  sure the push exists in the first place.
- [[cl_async-task-ux]] — background jobs (coverage, portify, portify) complete async;
  their runner is where `finishOk`/`finishErr` live — both must emit events.
- [[cl_verify-changes]] — changes to `apps/web-server/**` need Tier 3 (canary-apply)
  to confirm end-to-end. Unit tests verify the event is called; live confirms it
  propagates to the browser without a refresh.
