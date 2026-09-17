---
name: cl_ws-driven-state
description: Use when changing a Canary Lab state producer or its event wiring, including routes, background jobs, MCP writes, direct file edits and run results. Trace each change to all UI and agent consumers without manual refresh; pair with cl_live-state-sync for consumer recovery.
metadata:
  internal: true
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# WS-Driven State — Every Mutation Emits an Event

If the server already emits the event and only the client fails to react →
`cl_live-state-sync`.

The product requirement is **no manual refresh**. Push is the fast path, backed by
automatic recovery in `cl_live-state-sync`. When an authoritative fact changes,
publish through its owning store/event bridge or the shared writer, then refresh
every dependent consumer. A listener that updates only test source does not update
the coverage ledger derived from those tests.

Forgetting this is the primary cause of "I had to refresh to see X."

## The full event chain

```
Authoritative change (route / job / MCP tool / watched file / run result)
  → owning store bridge or shared writer publishes the change
      ├─ Browser: WorkspaceEventBus (apps/web-server/src/shared/workspace-events.ts)
      │   → apps/web-server/src/shared/ws/workspace-stream.ts broadcasts JSON
      │   → apps/web/src/shared/api/workspace-socket.ts parses the frame
      │   → apps/web/src/shared/state/use-workspace-data.ts invalidates affected topics
      │   → every dependent reader refetches → component renders current state
      └─ Agent: supported notification / wait / change-read path
          → connected workflow receives relevant changes with missed-change recovery
```

Trace agent delivery separately from the browser WebSocket. Reuse existing task
streams/store bridges where they own the state; do not add duplicate publishers.
For direct filesystem or linked-source edits, cover the actual observed path and
recover missed events. Reconnect/resync and bounded reconciliation are required
where a dropped signal could otherwise leave a consumer stale indefinitely.

## Existing event types

| Event type | What it signals | Client action |
|---|---|---|
| `feature-created` | A new feature dir was created | `refreshFeatures(newFeature)` |
| `feature-deleted` | A feature dir was removed | `refreshFeatures()` |
| `features-changed` | Any `Feature` field changed (config, envs, portified) | `refreshFeatures()` |
| `tests-changed` | Test files for a feature changed | Invalidate tests and every derived consumer, including coverage |
| `envsets-changed` | Envset added/removed for a feature | `refreshFeatures()` |
| `coverage-changed` (carries `feature`) | Source docs, summary, mappings or coverage-job state changed | Invalidate coverage, docs and dependent stage evidence |
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

The client-action column describes required consumers, not proof of current
wiring. Read the authoritative `WorkspaceEvent` union in
`apps/web-server/src/shared/workspace-events.ts` and its handlers before changing
a type. Run streams and summary watchers also carry state: trace those into
coverage proof readers even when no `WorkspaceEvent` directly represents a run.

## Checklist — adding a new mutation

Before closing a change to any producer, watcher or event bridge:

1. **Which facts and consumers change?** Include derived counts, freshness,
   evidence, open details, notifications and connected agents. Enumerate all
   entry points, including direct file/linked-target changes and standalone runs.
   Only skip delivery when there is no UI or agent consumer.

2. **Which event type fits?**  
   Use an existing type if it covers the change (see table above). If nothing fits,
   add a new type (steps below).

3. **Wire the owning publisher.** Inject the real `WorkspaceEventPublisher` into
   the shared writer or store bridge in `server.ts`. A route/runner/tool needs the
   dependency only when it publishes directly; do not bypass an existing bridge.

4. **Publish after authoritative state changes.** Prefer the existing store bridge
   or shared writer so all entry points share delivery. A failed data write must
   not announce success; a persisted failed job/result is itself a state change.

5. **Add the type to both sides** if it's new:
   - `apps/web-server/src/shared/workspace-events.ts` — `WorkspaceEvent` union
   - `apps/web/src/shared/api/workspace-socket.ts` — client `WorkspaceEvent` union

6. **Handle it in `use-workspace-data.ts`** and inspect the fetch-owning consumers:
   - For feature-list changes: call `refreshFeatures()`
   - Invalidate the appropriate topics through the shared invalidation bus
   - Each dependent reader subscribes and refetches; a component re-render alone
     does not re-run a fetch whose effect dependencies did not change
   - Wire and verify agent delivery separately; a UI broadcast does not enter
     Claude/Codex model context by itself

7. **Wire real dependencies and verify consumers.** Test the registered route,
   shared writer or watcher with its production event bridge, then test an already
   open consumer without reload. Pair with `cl_live-state-sync` for recovery.

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

A user-visible change can enter through REST, MCP, jobs, direct source edits or
standalone runs. Wiring one route does **not** cover the other writers. Prefer the
shared owner over repeated event calls. The rule the user holds you to:

> Whether triggered by an MCP tool or by the GUI, the change must show up live — the
> user must never refresh to see the latest state.

So for every mutation, trace every writer and consumer. The classic gap: a REST
route emits `features-changed` but the MCP
tool that performs the same write (the Desktop path) does not — so a mutation made
from Desktop leaves the badge stale until a manual refresh.

## Audit — reviewing an existing route for completeness

When reviewing a mutation that is NOT yours, check **both** surfaces:

```
rg -n 'publishWorkspaceEvent|workspaceEvents\.publish|bridge.*Events' apps/web-server/src
rg -n 'useInvalidationKey|invalidate\(' apps/web/src
```

Check whether a store bridge or shared writer already covers a mutation before
adding a publisher. Then follow the event all the way to each reader, including
derived data and connected agents. Correct publication alone is not completion.

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
- **How to apply:** When auditing/adding a mutation, the only valid reason to omit
  change delivery is "no UI or agent consumer exists at all." If a surface shows the data live (even an
  on-demand dialog another client could mutate underneath), wire the event + make the
  consumer refetch — *non-destructively* (don't clobber the editing user's in-progress
  local state; refetch the list, preserve selection/form). Present the fix, not a skip.
