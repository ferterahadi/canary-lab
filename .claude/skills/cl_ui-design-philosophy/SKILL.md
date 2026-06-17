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

## Principles that make it feel designed

- **Meaning carries the style, not decoration.** Prefer a status dot, a coloured
  border-inset, or a typed chip over a heavy accent. (R9 dropped the TestCard's
  decorative left-accent — the verified dot + `@req-*` chips already say it.)
- **Worst-first ordering.** Lists of work (gaps, failures) sort the items that need
  attention to the top; "all good" sinks to the bottom.
- **Never dead-end, never blank.** Every state has a rendering with a next action
  (a `Setup needed` empty state offers Generate; a regen keeps the last result
  visible, dimmed, rather than blanking — see the coverage state model).
- **Density with breathing room.** Tight vertical rhythm (8–12px gaps), small type
  (10–13px), monospace for ids/tags/paths. Information-rich, not cramped.
- **Restrained motion.** Subtle opacity/background transitions (~120ms) for
  hover/active; a pulse for "live". Headless preview forces reduced-motion — don't
  rely on animation to convey state (use static SVG for the coverage ring).
- **Two-way affordances.** Hovering one side of a relation lights the other and
  dims the rest (the ledger's test↔requirement highlight) — makes structure legible.

## Verify

Component behaviour is happy-dom-tested (`*.test.tsx`); the live look is the user's
`canary-apply` trial (never run it — see `cl_verify-changes`). Typecheck with
`tsconfig.build.json`.
