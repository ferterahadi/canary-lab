---
name: cl_route-every-surface
description: Use whenever you add a new page/view OR a dialog/modal to the web UI (apps/web) — a new full-screen view, a new dialog rendered from App.tsx, a wizard, a config/settings panel, anything a user opens. Also use when a user says "I want to link to X", "refresh loses my place", "make this bookmarkable", or "this dialog doesn't survive reload". The rule: every page and every cold-load-coherent dialog gets a URL param so it is deep-linkable, refresh-survivable, and revisitable. New surface with no route → it vanishes on refresh, always.
---

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
| Pages/views (coverage, cleanup) | Collision-confirm (fires off a live run event) |
| Selected run | Services / Runs-list / Portify-picker (transient pickers) |
| Config / settings panels | Any modal that reacts to a momentary event you can't reconstruct |
| Wizards (open-state, not per-step) | Confirmation prompts |
| Verify-config, portify | |

Pages always route. Dialogs route selectively. When unsure, ask: *if I paste this
URL into a clean browser, does the dialog have everything it needs?* If it depends
on live in-memory state, leave it ephemeral.

## The one home — extend, don't fork

All route serialization lives in **one module**:
`apps/web/src/shared/lib/workspace-view-state.ts` (`readPersistedView` /
`persistView` / `onViewChangedInOtherTab`). Adding a routed surface means adding a
field/param there and hydrating it in `App.tsx` — **never** a second URL-writing
mechanism, and **never** react-router (deliberate: query-param style, no router
dependency). See [[cl_reuse-shared-logic]].

The server already serves `index.html` for any deep link (catch-all in
`apps/web-server/server.ts`) — refreshing `/?...` never 404s. No server change is
needed for new routes.

## Two tiers — pick the right one

| Tier | Params | Channels | Use for |
|---|---|---|---|
| **Durable nav** | `view`, `feature` | URL + localStorage + cross-tab `storage` | top-level location shared across tabs |
| **URL-only** | `run`, `dialog`, `wf` | URL only | run selection (two tabs may compare runs) + dialog open-state (a dialog open in one tab must NOT pop open in another) |

A new dialog is almost always **URL-only** (the `dialog` param). Do not mirror
dialog open-state to localStorage or broadcast it cross-tab.

## Current URL schema

```
?view=coverage&feature=checkout                    → coverage page
?feature=checkout&run=7cvh                          → run selected in detail pane
?feature=checkout&dialog=config                     → Playwright settings
?dialog=add-test                                    → Add-Test wizard
?feature=checkout&dialog=portify&wf=wf_abc          → portify revisit (omit wf = start-new)
?feature=checkout&dialog=verification               → Verify-config dialog
```

`RouteDialog = 'config' | 'portify' | 'add-test' | 'verification'`. `wf` only
qualifies `dialog=portify` (present = revisit, absent = start-new); it is dropped
for any other dialog. Unknown dialog values are ignored on read.

## Checklist — adding a new page

1. Add the value to the `WorkspaceView` union in `workspace-view-state.ts` and the
   `VIEWS` array.
2. In `App.tsx`, render it off `view` (the `view === 'cleanup' ? … : view ===
   'coverage' ? … : <workspace>` ladder) and add the nav entry that calls
   `setView(...)`.
3. The persist effect already serializes `view` — nothing else to wire.
4. Confirm refresh restores it (it reads from the URL on load).

## Checklist — adding a new routed dialog

1. **Add it to the enum** — `RouteDialog` + `DIALOGS` array in
   `workspace-view-state.ts`. If it needs an id qualifier (like portify's `wf`),
   reuse `wf` or add a param and gate it the same way.
2. **Hydrate on mount in `App.tsx`** — seed the dialog's open-state from
   `PERSISTED_VIEW.dialog` in the relevant `useState` initializer.
3. **Derive it into the route** — add it to the `routedDialog` ternary
   (precedence = z-order: full-screen overlays above in-column dialogs), so the
   persist effect writes the `dialog` param when it's open.
4. **Where does the open-state live?**
   - **App-level** (rendered directly in `App.tsx`, like config/portify): seed its
     `useState` from `PERSISTED_VIEW` and you're done.
   - **In a context** (like the Add-Test wizard's `WizardDraftContext`): add a
     mount `useEffect` that calls the context's open fn when
     `PERSISTED_VIEW.dialog === '<yours>'`.
   - **In a child component** (like the Verify dialog in `RunsColumn`): make the
     child's open-state a **controlled/uncontrolled hybrid** — accept
     `open?`/`onOpenChange?` props, fall back to internal state when absent (keeps
     the child's own unit tests working), and have App own the state + drive the
     route. Lift, don't duplicate.
5. **Add a round-trip test** to `workspace-view-state.test.ts` (URL round-trip +
   the URL-only/localStorage-exclusion assertion).

## Gotchas (each one bit during the 1.4.0 build)

- **TDZ / hook order** — the persist effect reads values from context hooks
  (`useWizardDrafts`, etc.). Declare those hooks **above** the persist effect, or
  you get a use-before-declaration error.
- **Stale-run guard wipes a hydrated run** — the run-selection reconciliation
  effect clears `selectedRunId` to "latest" before runs arrive over the WS. Seed
  `pendingRunSelectionRef` with `PERSISTED_VIEW.run` so the hydrated run survives
  until its run loads.
- **Cross-tab scope** — `onViewChangedInOtherTab` emits the **durable tier only**
  (view/feature). Never push run/dialog through it.
- **`wf` belongs to portify only** — `persistView` drops `wf` unless
  `dialog === 'portify'`. If your dialog needs its own id, don't piggyback on `wf`.

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
- [[cl_verify-changes]] — `apps/web/**` changes need the canary-apply cycle (the
  user runs it) to confirm refresh/deep-link behaviour end-to-end; unit tests cover
  the serialization.
