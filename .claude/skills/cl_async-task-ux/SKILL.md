---
name: cl_async-task-ux
description: Use when adding a long-running background task to Canary Lab (anything that shouldn't block a REST request or the UI) — coverage generation, port-ification, spec/eval generation. Defines the non-blocking · persistent · recoverable · re-openable · single-flight contract and the file-backed store pattern to copy.
---

# Canary Lab Async-Task UX

Long-running work (agent runs, multi-second generation, double-boot verification)
must NOT block a REST handler or freeze the UI. Canary models it as a **background
job**: start returns immediately, the job persists to disk, the UI/MCP poll it, and
a server restart recovers it. Get this contract right by copying an existing impl —
don't invent a new lifecycle.

## Reference implementations

| Subsystem | Store | Runner / lifecycle |
| --- | --- | --- |
| Verified Coverage jobs | `apps/web-server/lib/coverage/jobs/store.ts` | `…/jobs/runner.ts` (`startCoverageJob`) |
| Port-ification | `apps/web-server/lib/runtime/portify/store.ts` | `…/portify/*` + `routes/portify.ts` |

Coverage jobs are the smallest complete example — read those two files first.

## The five-part contract

1. **Non-blocking.** The start endpoint validates input, creates a `running`
   manifest, kicks off the work *detached* (no `await` on the driver), and returns
   `202` with the manifest. The driver streams progress into the manifest and
   flips it to `done` / `failed` when it settles.
2. **Persistent.** State lives in a file-backed store (`<logs>/<kind>/<id>/…json`
   + an `index.json`), never only in memory. `save()` writes atomically (tmp +
   rename) then emits a `changed` event (the WS/poll push point). Reads come
   straight off disk so a fresh process sees history.
3. **Recoverable.** On server boot, call `store.reconcileInterrupted(now)` to flip
   any job left `running` by the dead process to `aborted` — otherwise it shows as
   live forever AND wedges the single-flight lock. Wire this next to the other
   store reconciles in `server.ts`.
4. **Re-openable.** Status is a pure read of the manifest by id (`GET …/jobs/:id`)
   plus a per-feature list (`GET …/:name/jobs`). The dialog/pill re-attaches to a
   running job by polling that id — closing the UI never kills the work.
5. **Server-side single-flight.** The guard is on the START path, keyed on the
   real identity (e.g. `feature + kind`): `store.activeFor(...)` → throw a typed
   conflict (`409`). **UI disabling is cosmetic, never the guard** — two tabs, an
   agent, and the UI all hit the same on-disk index, so the server must be the lock.

## Dual-surface parity

Every async capability ships on BOTH the UI (REST) and MCP, against the same store
(see `cl_add-mcp-tool`). Start + poll + list at minimum; accept/reject-style
follow-ups if the job parks for human input. MCP tools may construct a fresh store
over the same `logsDir` — the lock is the on-disk index, not the instance.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| `await`-ing the driver in the start handler | Request blocks — the whole point is lost |
| Single-flight enforced only by disabling the button | A second tab / an agent / a restart races a duplicate job |
| Skipping `reconcileInterrupted` on boot | Crashed jobs show as live forever and hold the lock |
| In-memory-only state | A restart loses history and re-openability |
| Non-atomic manifest writes | A crash mid-write corrupts the job; readers throw |
