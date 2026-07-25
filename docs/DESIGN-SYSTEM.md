# Canary Lab — Design System

The **reference catalog**: every token, primitive, and pattern the web UI
(`apps/web`) is built from. Look things up here.

For *judgment* — when to reach for which precedent, why a surface is shaped the
way it is — read the `cl_ui-design-philosophy` skill. This doc says **what
exists**; the skill says **how to decide**. Neither replaces the other.

| Layer | Lives in |
| --- | --- |
| Tokens + CSS primitives | [`apps/web/src/styles.css`](../apps/web/src/styles.css) (single stylesheet, no per-component CSS) |
| React primitives | [`apps/web/src/shared/ui/`](../apps/web/src/shared/ui/) |
| Status atoms (`StatusDot`, form atoms, icons) | [`apps/web/src/features/config/components/atoms.tsx`](../apps/web/src/features/config/components/atoms.tsx) |
| Agent output | `AgentSessionView` (`features/agent-sessions/`) — the only agent renderer |

Styling stack: **Tailwind v4** (CSS-first, `@import "tailwindcss"`) + hand-written
`.cl-*` component classes. No UI kit, no CSS-in-JS runtime, no `tailwind.config.js`.

---

## 1. Color tokens

Every colour is a CSS variable defined twice — `:root` (light) and `.dark`.
Nothing else should introduce a colour. Dark mode is a class variant
(`@custom-variant dark (&:where(.dark, .dark *))`), so both themes come free
from tokens.

### Surfaces

| Token | Light | Dark | Use for |
| --- | --- | --- | --- |
| `--bg-base` | `#fafafa` | `#0a0a0a` | App backdrop. Never inside a modal. |
| `--bg-surface` | `#ffffff` | `#141414` | Panels, cards, rows, bars |
| `--bg-elevated` | `#f5f5f5` | `#1c1c1c` | Inset wells, count chips, segmented-control track |
| `--bg-overlay` | `#ffffff` | `#1c1c1c` | Popovers |
| `--bg-input` | `#ffffff` | `#0a0a0a` | Inputs, code shells |
| `--bg-hover` | `#f5f5f5` | `#1f1f1f` | Row / menu-item hover |
| `--bg-selected` | `#ededed` | `#262626` | Selected row, id badges |
| `--overlay-backdrop` | `rgba(15,23,42,.32)` | `rgba(0,0,0,.66)` | Modal scrim (with `blur(8px)`) |

### Borders

| Token | Light | Dark | Use for |
| --- | --- | --- | --- |
| `--border-subtle` | `#f0f0f0` | `#1c1c1c` | Hairline row dividers |
| `--border-default` | `#e5e5e5` | `#262626` | Standard panel / card / input edge |
| `--border-strong` | `#d4d4d4` | `#3a3a3a` | Hover-raised edge, dividers |
| `--border-focus` | `#2563eb` | `#3b82f6` | Focused input edge |

### Text

| Token | Light | Dark | Use for |
| --- | --- | --- | --- |
| `--text-primary` | `#0a0a0a` | `#fafafa` | Titles, values, active labels |
| `--text-secondary` | `#525252` | `#a3a3a3` | Body, button labels |
| `--text-muted` | `#a3a3a3` | `#737373` | Kickers, captions, resting icons |

### Brand + status hues

| Token | Light | Dark | **Means** |
| --- | --- | --- | --- |
| `--accent` | `#2563eb` | `#3b82f6` | **Interactive** — "you can click this". Never a status. |
| `--accent-strong` | `#1d4ed8` | `#60a5fa` | Accent hover/active |
| `--accent-soft` | `accent @10%` | `accent @14%` | Focus ring, recommended-option wash |
| `--running` | `#0ea5e9` | `#38bdf8` | **Running / in progress** (sky) |
| `--success` | `#10b981` | `#34d399` | **Passed / verified** (emerald) |
| `--warning` | `#f59e0b` | `#fbbf24` | **Healing / stale / shallow** (amber) |
| `--danger` | `#ef4444` | `#f87171` | **Failed / integrity risk** (rose) |
| `--boot` | `#0891b2` | `#22d3ee` | **Boot-only session, services up** (teal) |
| `--boot-soft` | `boot @12%` | `boot @18%` | Boot tint fills |
| `--assistant` | `#7c3aed` | `#a78bfa` | **"The model speaks"** (violet) — agent timeline only, deliberately outside the status vocabulary |

> **The load-bearing rule.** A hue *means* one thing everywhere. Sky is never
> "clickable", blue is never "running", teal is never "passed". Breaking this is
> the single most damaging thing you can do to the system — a person reads the
> colour before the label.

### Using a hue: the utilities

Every token above has a Tailwind utility, via the `@theme inline` bridge in
`styles.css`. **Use these — never a raw palette class like `bg-rose-500`.**

| Utility family | Names |
| --- | --- |
| Status / brand | `accent` · `accent-strong` · `running` · `success` · `warning` · `danger` · `boot` · `assistant` · `idle` |
| Text | `primary` · `secondary` · `muted` |
| Surface | `canvas` · `surface` · `elevated` · `overlay` · `input` · `hover` · `selected` |
| Border | `line` · `line-strong` · `line-subtle` · `focus` |

```jsx
// ✅ one class, flips with the theme on its own
<span className="border-danger/40 bg-danger/10 text-danger" />

// ❌ bypasses the token, and needs a hand-written twin that will drift
<span className="border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300" />
```

`inline` is what makes this work: each utility emits `var(--danger)` rather than
a snapshot of the value, so the `.dark` override still applies and **no `dark:`
variant is needed for colour**. Opacity modifiers (`bg-danger/10`) compile to
`color-mix` with a solid fallback.

> ⚠️ Never add a `--text-*` entry to the `@theme` block. `--text-*` is Tailwind's
> **font-size** namespace, and the app already declares `--text-primary` /
> `-secondary` / `-muted` as colours in `:root`. Colours go in as `--color-*`.

---

## 2. Typography

```
--font-sans: 'Inter Tight', 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif
--font-mono: 'JetBrains Mono', ui-monospace, monospace
```

**Mono is semantic, not decorative** — it marks machine identity: run ids, test
ids, tags, file paths, ports, branch names, counts.

### Size scale (as built)

The app runs a 9–13px operator-console scale. There is no `--font-size-*` token
yet, so sizes appear as Tailwind arbitrary values.

| px | Class | Role |
| --- | --- | --- |
| 9–10 | `text-[9px]` / `text-[10px]` | Micro-labels, badges, `cl-rubric` caps |
| 10.5 | `text-[10.5px]` | Chip label default, id badges, count chips |
| 11 | `text-[11px]` | **Workhorse** — the most common size in the app |
| 11.5 | `text-[11.5px]` | Step rows, denser body |
| 12 | `text-[12px]` / `text-xs` | Buttons, body, meta grid |
| 12.5 | `text-[12.5px]` | Tabs, frame headings |
| 13 | `text-[13px]` | `cl-kicker` section headings |
| 13.5 | — | Wordmark only |

### Named voices

| Class | Spec | Use |
| --- | --- | --- |
| `.cl-kicker` | sans 13px/600, `-0.005em` | Section heading |
| `.cl-frame-heading` | sans 12.5px/600 | Heading inside a framed section |
| `.cl-rubric` | **mono 10px/500 caps, `.08em`** | Sub-caption under a title, `PanelCard` kicker. Mono caps because it reads as data, not literature. |
| `.cl-wordmark` | sans 13.5px/600 | App wordmark |
| `.cl-italic-affix` | sans 10.5px caps muted | Legacy — renders as a quiet label, no italics |

---

## 3. Spacing, radius, shadow, motion

**Spacing** — no token scale; Tailwind's 4px-based utilities. Vertical rhythm is
tight: **8–12px gaps** (`gap-2` / `gap-2.5` / `gap-3`), panel padding `px-3 py-2.5`.

**Radius**

| Token | px | Tailwind twin | Note |
| --- | --- | --- | --- |
| `--radius-sm` | 4 | `rounded` | |
| `--radius-md` | 6 | `rounded-md` | Buttons, inputs, rows, code shells |
| `--radius-lg` | 8 | `rounded-lg` | Cards, popovers, framed sections |
| `--radius-xl` | 10 | `rounded-xl` | Modals |

These token names are **deliberately identical to Tailwind's own theme variables**,
and `:root` is declared *after* `@import "tailwindcss"` — so `.rounded-xl`, which
compiles to `border-radius: var(--radius-xl)`, picks up our 10px instead of
Tailwind's 12px. The utility and the token can't drift. `--font-sans` /
`--font-mono` work the same way: `font-mono` already means JetBrains Mono.

Pills / dots / halos use `9999px` (`rounded-full`).

**Shadow** — two levels only.

| Token | Use |
| --- | --- |
| `--shadow-panel` | Resting card / frame. Barely there. |
| `--shadow-popover` | Popovers, modals, hover-raised cards |

**Motion** — restrained; `120ms ease` is the house transition.

| Name | Duration | Signals |
| --- | --- | --- |
| hover/active transitions | 120ms | background, border, color |
| `fm-fade-up` | 140ms popover / 180ms modal | entry |
| `.cl-flash-fade` | 2s once | self-dismissing confirmation |
| `.canary-pulse` / `animate-pulse` | 1.1s loop | running |
| `.cl-pulse` | 1.4s loop | live work-in-progress label (**respects `prefers-reduced-motion`**) |
| `.cl-dot-breathe` | 2.4s loop | alive but idle (boot) |
| `cl-edge-breathe` | 3s (run/heal) / 4s (dirty) | live row edge |
| `.cl-boot-pill-pulse` | 1.4s once | a boot just landed |
| `cl-indeterminate` | sweep | unmeasured progress |

> Headless preview forces reduced-motion. **Never** let animation be the only
> carrier of state — the coverage ring is a static SVG for exactly this reason.

---

## 4. Component catalog — CSS primitives (`.cl-*`)

### Shell & containers
| Class | What it is |
| --- | --- |
| `.cl-shell-bar` | Top bar: surface + bottom border + a faint accent gradient hairline |
| `.cl-panel` / `.cl-panel-header` / `.cl-panel-footer` | Pane chrome |
| `.cl-card` (+ `.cl-card-hover`) | Bordered surface, `--radius-lg`, `--shadow-panel` |
| `.cl-frame` | Framed section inside modals/wizard |
| `.cl-code-shell` | Mono inset well on `--bg-input` |
| `.cl-divider` | `--border-strong` rule |

### Overlays
| Class | What it is |
| --- | --- |
| `.cl-modal-backdrop` | Scrim + `blur(8px)` |
| `.cl-modal` | `--radius-xl`, popover shadow, `fm-fade-up` 180ms |
| `.cl-popover` | `--bg-overlay`, `--radius-lg`, `fm-fade-up` 140ms |
| `.cl-dialog-header` | Flex header, 0.75/1rem padding, bottom border |

### Controls
| Class | Variants / states |
| --- | --- |
| `.cl-button` | default · hover (raised border) · focus-visible · `:disabled` (0.5 opacity, `not-allowed`) |
| `.cl-button-primary` | Accent fill + glow; dark mode adds a gradient + inset highlight |
| `.cl-icon-button` | Muted → primary on hover, `--bg-hover` fill |
| `.cl-run-menu-button` (+ `-compact`) | Primary launcher; `[aria-expanded="true"]` reads as hover |
| `.cl-mode-toggle` / `-btn` | Segmented control; `[data-active="true"]` lifts to surface + shadow; `[data-mode="boot"]` colours teal, `verify` accent |
| `.cl-input` | Focus = `--border-focus` + 3px `--accent-soft` ring |
| `.themed-select` / `.numeric-input` | Native controls, chrome stripped |
| `.cl-tab` / `.cl-tab-active` | Muted label → primary; 2px accent underline (dark adds a glow) |
| `.cl-branch-option` / `-rec` / `.cl-branch-chevron` | Whole-card choice button; `-rec` = accent wash for the recommended pick |
| `.cl-menu-item` / `.cl-run-env-option` | Menu rows |
| `.cl-run-link` | Bare button that reads as a link (underline on hover) |

### Rows & badges
| Class | What it is |
| --- | --- |
| `.cl-row` | Hairline-divided table row |
| `.cl-list-row` (+ `-selected`) | Rounded soft list row, no resting border |
| `.cl-hover-row` | Theme-safe hover for hand-composed rows — **use instead of `hover:bg-white/[0.03]`**, which vanishes in light mode |
| `.cl-count-chip` | Mono numeral on `--bg-elevated`, pill |
| `.cl-badge-accent` | 10px uppercase accent badge ("Recommended") |
| `.cl-status-dot` (+ `--running`) | 0.55rem circle; dark mode adds a soft halo per hue |

### Row-state stack — precedence matters

Live rows tint their background and animate an inset `::after` ring. Declared in
this order so the later rule wins when a row is in two states at once:

| Class | Tint | Edge | Meaning |
| --- | --- | --- | --- |
| `.cl-list-row-running` | accent 16% | breathe 3s | test run in flight |
| `.cl-list-row-healing` | warning 18% | breathe 3s | heal loop active |
| `.cl-list-row-booted` | boot 14% | **steady** 0.7 | services up, idle — calmer on purpose |
| `.cl-list-row-dirty` | danger 14% | breathe **4s** | test files modified — **wins over all of the above**; an integrity warning outranks activity. Slower breathe because the cue is held until resolved. |

All motion is opacity on a fully-inset `::after`, so nothing spills into row
gaps. The running/healing edge keeps animating under `prefers-reduced-motion`
**by deliberate product decision**.

### Scrollbars
`--scrollbar-size: 10px` with token-derived thumb; `.scrollbar-thin`,
`.scrollbar-none`. On any scroller whose content grows with a toggle or filter,
set `scrollbar-gutter: stable` so the appearing bar doesn't jump the layout.

---

## 5. Component catalog — React primitives

`apps/web/src/shared/ui/`

| Component | Anatomy / API |
| --- | --- |
| **`StatusDot`** (`atoms.tsx`) | States `idle · running · success · failed · warning · booted`. `running` pulses, `booted` breathes, `pulse` overrides, `halo` adds an `animate-ping` ring. |
| **`Chip`** (`StatusChip.tsx`) | The one read-only status badge. `chrome: none \| fill \| border`, `tone`, `labelColor`, `background`, `icon`, `label`, `detail`, `uppercase`, `fontSize` (10.5), `width`. Backs `ConnectionBadge`, `RunStatusChip`, `StageStatusChip`, `FlightStatusChip`. |
| **`StatusPill`** | The one *clickable* status-bar pill. Anatomy: `[dot] [name] [· detail — xl+ only] [count]`. `countTone: neutral \| accent \| boot \| danger`, `emphasis` (accent/danger border+text), `freshPulseKey`, `overlayDot`. |
| **`PanelCard`** | The one stage-panel slab: `PANEL_CARD_CLASS` + `PANEL_CARD_STYLE` + `cl-rubric` kicker + optional right-aligned `aside`. |
| **`StepList` / `StepRow`** | Vertical rail + beads. States `done · active · pending · warn · failed`; 15px indicator cell masks the rail. |
| **`TestIdBadge`** | `#N` mono badge on `--bg-selected` — source-order identity, rendered identically in every view. |
| **`Tooltip`**, **`DiffView`**, **`TestCodeBlock`** (Shiki), **`ResizablePanels`** / **`VerticalSplit`**, **`ThemeToggle`** | |

**Chip vs Pill:** `Chip` is read-only, `StatusPill` is a clickable action with a
count. Different interaction models — don't merge them.

---

## 6. Patterns

| Need | Copy from |
| --- | --- |
| Full-screen workspace view | `CoverageLedgerPage`, `LogCleanupPage` — `fixed inset-0`, header bar + panes |
| Modal with tabs | `FeatureConfigEditor` — `.cl-modal-backdrop` + `.cl-modal` + `<nav>` tabs |
| Status-bar launcher | `*Pill` components in `GlobalStatusBar` |
| Background-task surface | `FlightsPill` + `FlightPage` (see `cl_async-task-ux`) |
| Long async generation | Coverage **Generating** pane — a dedicated screen that *owns* the view (phase stepper + agent timeline), not a banner over a dimmed result |
| Any agent progress / CLI output | **`AgentSessionView`** — never a raw log `<pre>` |
| Metric tiles | `FactsGrid` + `StageFact` (`big` / `stepper` / `bar` / `sub`) |
| Paused / errored step | `StagePausedPanel` / `StageErrorPanel` |

### Non-negotiables

1. **Tokens only.** Never a hex that competes with a token, and never a raw
   Tailwind palette class (`bg-rose-500`, `text-amber-300`) — use the semantic
   utility. A colour utility needs no `dark:` twin.
2. **No new component library.** Compose from what's here.
3. **Both themes.** Verify you didn't bake in a theme-specific colour.
4. **Meaning carries the style.** A status dot or coloured border-inset beats a
   decorative accent. Don't stack accents (border + badge + toggle).
5. **Neutral surfaces, one accent.** Rows inside modals stay transparent with
   dividers — never `--bg-base` slabs.
6. **Worst-first ordering.** Items needing attention sort to the top.
7. **Never dead-end, never blank.** Every state renders, with a next action.
8. **Distinct view per lifecycle state** — empty / generating / final each get
   their own rendering, not one half-populated layout.

---

## 7. Audit — current state

Measured across 83 components in `apps/web/src`.

| Category | Tokenized | Notes |
| --- | --- | --- |
| Surfaces / borders / text | ✅ | Token vars + utilities |
| Radius / fonts | ✅ | Token names match Tailwind's theme vars, so the utilities resolve to them automatically |
| Shadow / overlay | ✅ | Two shadow levels, one backdrop |
| **Status hues** | ✅ | **Was 210 raw palette classes; all rewritten to token utilities.** Zero raw palette classes remain outside the xterm theme. |
| Typography size | 🔥 None | **413** arbitrary `text-[Npx]` across 11 distinct sizes; no `--text-*` step defined |
| Spacing | ➖ Tailwind only | 51 arbitrary `p-[…]` / `gap-[…]` values |
| Hardcoded hex | ✅ Contained | 20 total — 9 are the xterm terminal theme (legitimate, xterm takes hex), 8 are `#fff` on accent/danger fills, 2 are external-client brand colours |

### Remaining work

**Fold the type scale into named steps.** Eleven distinct sizes between 9 and
13.5px is more resolution than the design needs. The fix mirrors what the colour
bridge did: pick ~5 steps, add them to `@theme` under **`--text-*`** — but note
that namespace currently holds three colour tokens in `:root`
(`--text-primary/-secondary/-muted`), so the type steps need names that can't
collide with them, or those three need renaming first. That coupling is why this
wasn't done alongside the colour pass.

Spacing is intentionally left on Tailwind's own 4px scale — there is no
competing project scale for it to drift from.
