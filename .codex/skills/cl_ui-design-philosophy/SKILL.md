---
name: cl_ui-design-philosophy
description: Use when building or restyling any Canary Lab web UI (apps/web) — a new panel, dialog, pill, card, or full-screen view. Captures the design language so new surfaces feel native instead of bolted on: reuse the token system, the established layout precedents, and the meaning-carries-the-style rule. No new component library.
---

# Canary Lab UI Design Philosophy

Canary Lab's UI is a dense, information-first operator console — not a marketing
page. New surfaces must read as part of the same tool. The bar is *intentional and
native*, not *novel*. Apply `frontend-design` polish **inside** these constraints.

## Non-negotiables

1. **Token system only.** Colour, spacing, radius, shadow, type all come from CSS
   variables: `--bg-base/-surface/-selected`, `--text-primary/-secondary/-muted`,
   `--border-default`, `--accent/--success/--warning/--danger`, `--radius-*`,
   `--shadow-*`, `--font-mono`. Never hardcode a hex that competes with a token.
   Status hues (green verified, amber stale/shallow, sky in-progress, rose danger)
   are reused consistently so a colour *means* the same thing everywhere.
2. **No new component library.** Compose from existing precedents — don't introduce
   a UI kit, CSS-in-JS runtime, or competing styling approach.
3. **Light + dark both.** Everything derives from tokens, so both themes work for
   free — verify you didn't bake in a theme-specific colour.

## Layout precedents to copy

| Need | Copy from |
| --- | --- |
| Full-screen workspace view | `CoverageLedgerPage`, `LogCleanupPage` (`fixed inset-0`, header bar + panes) |
| Modal with tabs | `FeatureConfigEditor` (`.cl-modal-backdrop` + `.cl-modal` + `<nav>` tabs) |
| Status-bar launcher | the `*Pill` components in `GlobalStatusBar` |
| Background-task surface | the Portify pill + dialog (see `cl_async-task-ux`) |
| Long async generation | the Coverage **Generating** screen — a dedicated full pane (phase stepper + live agent log) that OWNS the view while a job runs; not a banner over a dimmed result |
| Live agent progress / CLI output | **`AgentSessionView`** — never a raw log `<pre>` |

## Principles that make it feel designed

- **One agent timeline everywhere.** Any surface that shows an agent's progress —
  run heal, draft planning/generating, coverage, portify, benchmark, evaluation
  export — renders through `AgentSessionView`, never a hand-rolled raw-log `<pre>`.
  Reaching for `AgentSessionView` means the producer must pin a session ref (claude
  `--session-id`; codex located by cwd + start) and expose the REST snapshot +
  `/ws/.../agent-session` tail, exactly like the coverage job (see `cl_async-task-ux`).
  A new `kind` on `AgentSessionSource` is the whole UI cost; the win is structured
  thinking/tool/result rows, collapse, model+session header, and live tail for free.
- **A live UI transition needs a reliable trigger, not just a push.** When a panel
  must flip state mid-job (text progress → `AgentSessionView` once the rewrite agent
  pins its session), don't gate it solely on a one-shot broadcast like a
  workspace-event push — that channel can silently fail to deliver while the
  per-task log WS (the one already streaming the agent's lines) keeps working. Back
  the transition off the proven stream: when the log marks the agent starting and
  the task still lacks its session ref, refetch the task once (self-limiting — stop
  refetching the moment the ref lands). Symptom this prevents: "only swaps after I
  refresh the page" — refresh works because the REST list carries the ref the lost
  push didn't. The full pattern + diagnostic fingerprint lives in [[cl_live-state-sync]].
- **Meaning carries the style, not decoration.** Prefer a status dot, a coloured
  border-inset, or a typed chip over a heavy accent. (R9 dropped the TestCard's
  decorative left-accent — the verified dot + `@req-*` chips already say it.)
- **Worst-first ordering.** Lists of work (gaps, failures) sort the items that need
  attention to the top; "all good" sinks to the bottom.
- **Never dead-end, never blank.** Every state has a rendering with a next action
  (a `Setup needed` empty state offers Generate). While a long job runs, give it a
  dedicated screen that owns the view (the Coverage Generating pane) instead of a
  stale/empty ledger behind a banner — the work-in-progress IS the content.
- **One exercise, not exposed seams.** When two steps are really one user goal
  (PRD summary → coverage mapping), present one flow with chained progress and one
  set of actions (Regenerate summary / Regenerate coverage) — don't leak the
  internal two-job boundary or a per-item review gate the user must babysit.
- **Durable selection survives refresh + tabs.** UI selection the user would expect
  to persist (which feature, which full-screen view, which sub-tab) lives in the URL
  (source of truth) + `localStorage`, NOT only React state — so a refresh restores
  it and a second tab reflects it. Broadcast cross-tab changes via `storage` events;
  see `lib/workspace-view-state.ts`. Ephemeral UI (hover, transient filters) stays
  in React state.
- **One owner for a long-lived lifecycle; don't split it across views.** A background
  job (or any cross-view live state) must be owned ONCE at the screen level — one
  poller, rehydrated on open — and every panel reads from it. The Coverage dialog's
  worst bug came from two tabs each owning their own job + poller that unmounted on
  switch (orphaned jobs, "nothing happened", raw 409s). The fix wasn't more hydration
  — it was collapsing the tabs into one never-unmounting view. **Prefer one view with
  panels/rails over tabs when the tabs share live state.** Treat a "already running"
  conflict as *attach to the existing*, never an error in the user's face.
- **Distinct view per lifecycle state.** Empty / generating / final each get their own
  rendering off the single derived state — not one layout that's half-populated. A
  long-running job earns a full-screen takeover (you watch the agent); the resting
  states show the working surface.
- **Density with breathing room.** Tight vertical rhythm (8–12px gaps), small type
  (10–13px), monospace for ids/tags/paths. Information-rich, not cramped.
- **Restrained motion.** Subtle opacity/background transitions (~120ms) for
  hover/active; a pulse for "live". Headless preview forces reduced-motion — don't
  rely on animation to convey state (use static SVG for the coverage ring).
- **Two-way affordances.** Hovering one side of a relation lights the other and
  dims the rest (the ledger's test↔requirement highlight) — makes structure legible.
- **No layout shift from a scrollbar.** On any scroller whose content grows/shrinks
  with a toggle or filter (a disclosure, a gap filter, the generating "show agent
  activity"), set `scrollbar-gutter: stable` so the appearing scrollbar doesn't eat
  content width and jump the layout sideways.

## Verify

Component behaviour is happy-dom-tested (`*.test.tsx`); the live look is the user's
`canary-apply` trial (never run it — see `cl_verify-changes`). Typecheck with
`tsconfig.build.json`.
