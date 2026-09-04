---
name: cl_ws-driven-state
description: Use whenever you add or modify a server-side mutation (route, background job completion, MCP tool write) that changes something visible in the UI, or when a user says "I had to refresh to see X". Every mutation affecting UI state must emit a WorkspaceEvent.
---

# WS-Driven State — Every Mutation Emits an Event

If the server already emits the event and only the client fails to react →
`cl_live-state-sync`.

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
  → apps/web-server/src/shared/ws/workspace-stream.ts  broadcasts JSON to every open client socket
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
| `coverage-changed` (carries `feature`) | A coverage job finished (done or failed) | `setCoverageRefreshKey(k+1)` |
| `tests-dirty-changed` (carries `feature`) | A feature's tests-dirty status flipped | `refreshFeatures(selected)` |
| `verification-config-changed` (carries `feature`) | Verify config saved (route or MCP tool) | `setVerificationRefreshKey(k+1)` if feature selected |
| `journal-changed` (carries `runId`) | A run's journal file changed | bump `journalRefreshKeys[runId]` |
| `draft-created/updated/deleted` | Wizard draft mutations | draft context reducer |
| `evaluation-export-*` | Eval export task lifecycle | export task context |
| `version-changed` | Registry `latest` moved, or an update job finished | `refreshVersion()` |
| `flights-changed` | A flight's state changed (stage advance, checkpoint, completion) | `refreshFlights()` + bump `flightsRefreshKey` |
| `project-config-changed` | `canary-lab.config.json` was written (PUT /api/project-config) | `invalidate('project-config')` — the demo launcher refetches `showDemo` |

Pick the narrowest type that fits. `features-changed` is a catch-all for the feature
list; `coverage-changed` is scoped to coverage headlines. Prefer scoped events — they
avoid unnecessary re-fetches across all features.

This table is a snapshot; the authoritative union is `WorkspaceEvent` in
`apps/web-server/src/shared/workspace-events.ts` — read it before adding a type.

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

## Reference wiring (live examples)

- **A route mutation** — `routes/portify.ts` publishes `{ type: 'features-changed' }`
  right after `savePortify` returns, through the `workspaceEvents` dep on
  `PortifyRouteDeps` that `server.ts` injects.
- **A background job** — the coverage job store publishes `coverage-changed` on
  every write via `bridgeCoverageJobEvents(coverageJobStore, workspaceEvents)` in
  `server.ts`, so job completion reaches the client without the runner knowing
  about the WS. For the client side read `feature-activity.ts` and
  `use-stage-band-data.ts` under `apps/web/src/features/flights/`.

## Both surfaces, or it's only half-wired

A user-visible mutation almost always has **two** entry points: the GUI's REST route
*and* an MCP tool (driven from Claude Desktop / Codex / CLI). They are separate code
paths into the same write — wiring the event on one does **not** cover the other. The
rule the user holds you to:

> Whether triggered by an MCP tool or by the GUI, the change must show up live — the
> user must never refresh to see the latest state.

So for every mutation, ask "what are *all* the ways this gets triggered?" and emit the
event on each. The classic gap: a REST route emits `features-changed` but the MCP
tool that performs the same write (the Desktop path) does not — so a mutation made
from Desktop leaves the badge stale until a manual refresh.

## Audit — reviewing an existing route for completeness

When reviewing a mutation that is NOT yours, check **both** surfaces:

```
grep -rn "publishWorkspaceEvent" apps/web-server/src/features/   # REST routes + job runners
grep -rn "publishWorkspaceEvent" apps/web-server/src/mcp/tool-groups/  # MCP tools (Desktop/Codex/CLI)
```

Anything that writes to disk but has no `publishWorkspaceEvent` call is a candidate
for a gap. Cross-check against the UI: does this write affect a visible field? If yes,
it needs an event — on *every* path that performs the write, not just the GUI one.

## Relationship to neighbours

- [[cl_live-state-sync]] — the **client** side: once the event arrives, don't gate a
  must-happen UI transition on a single push. This skill is the **server** side: make
  sure the push exists in the first place.
- [[cl_async-task-ux]] — background jobs (coverage, portify) complete async;
  their runner is where `finishOk`/`finishErr` live — both must emit events.
- [[cl_verify-changes]] — changes to `apps/web-server/**` need Tier 3 (canary-apply)
  to confirm end-to-end. Unit tests verify the event is called; live confirms it
  propagates to the browser without a refresh.

## Learned corrections (/todo-learn)

### 2026-06-25 — Don't value-gate live-update wiring; "rare" is not an exemption
- **Rule:** If a mutation has *any* live UI consumer, wire its `WorkspaceEvent` — even
  when the only stale scenario is rare (e.g. two clients editing the same thing at
  once, like the Verify-config dialog). Do **not** recommend skipping a gap on
  cost/value grounds ("narrow edge case", "dialog refetches on reopen", "by design").
- **Why:** The "user must never refresh to see real state" bar is **absolute**. How
  unlikely the concurrent-edit case is doesn't make a stale UI acceptable — rarity ≠
  exempt. The user holds every visible mutation to live-update, full stop.
- **How to apply:** When auditing/adding a mutation, the only valid reason to NOT emit
  is "no visible UI consumer exists at all." If a surface shows the data live (even an
  on-demand dialog another client could mutate underneath), wire the event + make the
  consumer refetch — *non-destructively* (don't clobber the editing user's in-progress
  local state; refetch the list, preserve selection/form). Present the fix, not a skip.
