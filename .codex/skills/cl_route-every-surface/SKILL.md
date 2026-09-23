---
name: cl_route-every-surface
description: Use whenever you add a new page/view or a dialog/modal to the web UI (apps/web), or when a user says "I want to link to X", "refresh loses my place", "make this bookmarkable", "this dialog doesn't survive reload". Every page and cold-load-coherent dialog gets a URL param.
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Route Every Surface — A New Page/Dialog Gets a URL

The pattern the project enforces: **the URL is the source of truth for where you
are.** A view, a selected run, and an open dialog all serialize to the URL so a
refresh, a copy-pasted link, or a new tab rehydrates the exact same screen.

Forgetting this is how a new dialog "vanishes on refresh" and a new page can't be
linked to.

## The cold-load test (decides whether to route a dialog)

> **Route a dialog only if landing on its URL cold — fresh tab, no prior in-memory
> state — produces something coherent.**

| Route it | Don't route it |
|---|---|
| Pages/views (coverage, cleanup, flights) | Collision-confirm (fires off a live run event) |
| Selected run | Services / Runs-list / Portify-picker (transient pickers) |
| Config / settings panels; changed-tests review and notifications | Any modal that reacts to a momentary event you can't reconstruct |
| Wizards (open-state, not per-step) | Confirmation prompts |
| Verification, flight-start, flight-new | |

Pages always route. Dialogs route selectively. When unsure, ask: *if I paste this
URL into a clean browser, does the dialog have everything it needs?* If it depends
on live in-memory state, leave it ephemeral.

## The one home — extend, don't fork

All route serialization lives in **one module**:
`apps/web/src/shared/lib/workspace-view-state.ts` (`readPersistedView` /
`persistView` / `onViewChangedInOtherTab`). Navigation state and dialog
precedence live in `apps/web/src/shared/state/nav-state.ts`; the
`use-workspace-navigation.ts` hook hydrates and persists them. Add a param in
that path — **never** a second URL-writing mechanism, and **never** react-router
(deliberate: query-param style, no router dependency). See [[cl_reuse-shared-logic]].

The server already serves `index.html` for any deep link (catch-all in
`apps/web-server/src/server.ts`) — refreshing `/?...` never 404s. No server change is
needed for new routes.

## Two tiers — pick the right one

| Tier | Params | Channels | Use for |
|---|---|---|---|
| **Durable nav** | `view`, `feature` | URL + localStorage + cross-tab `storage` | top-level location shared across tabs |
| **URL-only** | `run`, `dialog`, `flight`, and their qualifiers | URL only | run selection (two tabs may compare runs) + dialog open-state (a dialog open in one tab must NOT pop open in another) + stage, tab, review, and drill-through context |

A new dialog is almost always **URL-only** (the `dialog` param). Do not mirror
dialog open-state to localStorage or broadcast it cross-tab.

## Current URL schema

```
?view=coverage&feature=checkout                    → coverage page
?feature=checkout&run=7cvh                          → run selected in detail pane
?feature=checkout&dialog=config                     → feature config (Playwright — the no-tab default)
?feature=checkout&dialog=config&tab=ports           → feature config, on a named tab
?feature=checkout&dialog=verification               → Verify-config dialog
?feature=checkout&dialog=flight-start               → flight stage-entry launcher (feature-scoped)
?feature=checkout&dialog=flight-fresh               → same launcher in START-FRESH intent
?dialog=flight-new                                  → new-flight launcher (intent + repo picker)
?dialog=demo                                        → demo chooser (needs only GET /api/onboarding)
?dialog=settings                                    → Project Settings (needs only GET /api/project-config)
?view=flights&flight=fl_abc                         → flight detail (omit flight = flights list)
?view=flights&flight=fl_abc&stage=docs              → that flight, on a named stage (omit = follow-mode)
?dialog=notifications                               → notifications center
?dialog=tests-review&reviewFile=e2e/cart.spec.ts    → changed-tests review focused on a file
?dialog=settings&models=codex                      → Project Settings with Codex models open
?feature=checkout&run=7cvh&test=cart%20fails        → run detail focused on a failure
?feature=checkout&run=7cvh&tests=recorded           → recorded tests for that run
?feature=checkout&run=7cvh&runtab=changes           → run detail arrival on Changes
```

`RouteDialog = 'config' | 'verification' | 'flight-start' | 'flight-fresh' |
'flight-new' | 'demo' | 'settings' | 'tests-review' | 'notifications'`.
`flight` only qualifies `view=flights` (absent = the flights landing list), and
`stage` only qualifies an open flight. `tab` only qualifies `dialog=config`;
`models` only qualifies `dialog=settings`; `review*` params only qualify
`dialog=tests-review`; `test`, `runtab`, and `tests` qualify a selected run.
`from` records the flight a workspace/coverage drill-through came from and is
dropped on the flights view. `persistView`/`readPersistedView` own these gates.
Because the config dialog is qualified by the DURABLE `feature` param, any opener
that opens it for a feature other than the selected one must `setSelectedFeature`
too — otherwise the deep link names the wrong suite.
`wf`, `task` and `draft` are tombstoned qualifiers (see Gotchas). Unknown
dialog values are ignored on read.

## Checklist — adding a new page

1. Add the value to the `WorkspaceView` union in `workspace-view-state.ts` and the
   `VIEWS` array.
2. Render it from `App.tsx` and add the nav entry that calls `setView(...)` from
   `use-workspace-navigation.ts`.
3. The hook's persist effect already serializes `view` — nothing else to wire.
4. Confirm refresh restores it (it reads from the URL on load).

## Checklist — adding a new routed dialog

1. **Add it to the enum** — `RouteDialog` + `DIALOGS` array in
   `workspace-view-state.ts`. If it needs an id qualifier, follow the live
   precedent — `flight` qualifying `view=flights` — add a param and gate it in
   `persistView`/`readPersistedView` so it's dropped unless your dialog/view is
   active. Don't reuse `wf`, `task` or `draft` — all three are tombstoned (see Gotchas).
2. **Hydrate on mount** — add the dialog to `initialNavState` in `nav-state.ts`
   and seed its open-state from `SEED` in `use-workspace-navigation.ts`.
3. **Derive it into the route** — add it to `routedDialog` in `nav-state.ts`
   (precedence = z-order), and expose its setter from the hook so the persist
   effect writes the `dialog` param when it is open.
4. **Where does the open-state live?**
   - **Navigation-owned** (like config and settings): seed it in the navigation
     hook and render from `App.tsx`.
   - **In a context:** hydrate the navigation state first, then pass its open
     flag to the context instead of adding a second URL writer.
   - **In a child component** (like the Verify dialog in `RunsColumn`): make the
     child's open-state a **controlled/uncontrolled hybrid** — accept
     `open?`/`onOpenChange?` props, fall back to internal state when absent (keeps
     the child's own unit tests working), and have the navigation hook own the
     state + drive the route. Lift, don't duplicate.
5. **Add a round-trip test** to `workspace-view-state.test.ts` (URL round-trip +
   the URL-only/localStorage-exclusion assertion).

## Gotchas

- **Hook order** — keep any state the persist effect reads in
  `use-workspace-navigation.ts` before that effect and include its primitive
  fields in the dependency list. A dialog can stay open while a qualifier
  changes, so depending only on `dialog` leaves its URL stale.
- **Stale-run guard wipes a hydrated run** — the run-selection reconciliation
  effect clears `selectedRunId` to "latest" before runs arrive over the WS. Seed
  `pendingRunSelectionRef` with the persisted run so the hydrated run survives
  until its run loads.
- **Cross-tab scope** — `onViewChangedInOtherTab` emits the **durable tier only**
  (view/feature). Never push run/dialog through it.
- **Qualifiers belong to their dialog/view only** — `persistView` drops `flight`
  unless `view === 'flights'` (the live precedent to copy — same
  drop-unless-active gate). `wf` (old portify-revisit id), `task` (old
  evaluation-dialog id) and `draft` (old external-authoring id) are tombstoned:
  `persistView` force-deletes all three on every write regardless of state, so
  stale deep links don't carry them forward. If your dialog needs its own id,
  add a new param with the flight-style gate; never reuse `wf`, `task` or `draft`.

## Deliberately NOT done (don't "fix" these without a reason)

- **Back-button closes dialog** — would need user-vs-programmatic transition
  tracking (auto-select-first-feature would spam history). The goal is *revisit*
  (deep-link + refresh), which `replaceState` delivers. Left out on purpose.
- **Pretty paths** (`/coverage/checkout`) — query-param style is intentional; a
  router buys nothing for a single-screen internal tool.

## Relationship to neighbours

- [[cl_reuse-shared-logic]] — routing has ONE home (`workspace-view-state.ts`);
  extend it, never add a second URL-writing path or a router lib.
- [[cl_ui-design-philosophy]] — a new surface's *look* is governed here; its
  *route* is governed by this skill.
- [[cl_ws-driven-state]] — that skill keeps UI state live after a server mutation;
  this skill keeps UI state addressable in the URL. Different axes, both required
  for a surface to feel native.
- [[cl_verify-changes]] — `apps/web/**` changes need the canary-apply cycle (Tier 3
  says who runs it) to confirm refresh/deep-link behaviour end-to-end; unit tests
  cover the serialization.
