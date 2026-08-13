// Persistent chrome: the top bar, the two-column shell, and the sticky nav rail
// (search box, filter chips, per-spec groups).
export const CSS_CHROME = `
/* ---------------------------------------------------------------- topbar */

.topbar {
  position: sticky; top: 0; z-index: 40;
  background: color-mix(in srgb, var(--paper) 84%, transparent);
  backdrop-filter: saturate(1.4) blur(12px);
  -webkit-backdrop-filter: saturate(1.4) blur(12px);
  border-bottom: 1px solid var(--rule);
}
.topbar-inner {
  display: flex; align-items: center; gap: 16px;
  width: min(1420px, 100% - 40px); margin: 0 auto;
  height: 56px;
}
.brand { display: flex; align-items: center; gap: 10px; flex: none; }
.brand-mark {
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent);
}
.brand-text {
  display: flex; flex-direction: column; line-height: 1.15;
  font-family: var(--font-mono); font-size: 12px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
}
.brand-sub { color: var(--ink-3); font-size: 10px; letter-spacing: 0.11em; font-weight: 500; }

.topbar-now {
  flex: 1 1 auto; min-width: 0;
  color: var(--ink-2); font-size: 12.5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 0; transition: opacity .2s ease;
}
.topbar-now:not(:empty) { opacity: 1; }

.topbar-tools { display: flex; align-items: center; gap: 10px; flex: none; }

/* The run chip and the theme switch are two pills side by side, so they share one
 * explicit height — otherwise the chip is sized by its line box and the switch by
 * its buttons, and the two never agree. Worse, the chip's line box comes from
 * whichever mono font resolves on the READER's machine, so the mismatch was not
 * even a fixed 2.4px: it drifted per recipient. Height first, padding second. */
.run-chip, .theme-switch { height: var(--tool-height); }
.run-chip {
  display: inline-flex; align-items: center;
  padding: 0 10px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--rule);
  color: var(--ink-2); font-size: 11px; letter-spacing: 0.02em;
}

.theme-switch {
  display: inline-flex; align-items: center; padding: 2px; gap: 1px;
  background: var(--surface-2); border: 1px solid var(--rule);
  border-radius: 999px;
}
.theme-switch button {
  display: grid; place-items: center;
  width: 28px; height: 24px; padding: 0;
  border: 0; border-radius: 999px; background: transparent;
  color: var(--ink-3); cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.theme-switch button:hover { color: var(--ink); }
.theme-switch button[aria-checked="true"] {
  background: var(--surface); color: var(--accent);
  box-shadow: 0 1px 2px rgba(0,0,0,.12);
}
.theme-switch svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.5; }

/* ----------------------------------------------------------------- shell */

.shell {
  position: relative; z-index: 1;
  display: grid; grid-template-columns: 268px minmax(0, 1fr);
  gap: 34px;
  width: min(1420px, 100% - 40px); margin: 0 auto;
  align-items: start;
}
main { min-width: 0; padding: 40px 0 96px; }

/* ------------------------------------------------------------------ rail */

.rail { position: sticky; top: 56px; align-self: start; padding-top: 40px; }
.nav {
  max-height: calc(100vh - 112px);
  display: flex; flex-direction: column; gap: 12px;
  overflow: auto; overscroll-behavior: contain;
  padding-right: 6px;
}
.nav-search input {
  width: 100%; padding: 8px 11px;
  background: var(--surface); color: var(--ink);
  border: 1px solid var(--rule); border-radius: 9px;
  font: 400 13px var(--font-sans);
}
.nav-search input::placeholder { color: var(--ink-3); }

.filters { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 9px 4px 7px;
  background: transparent; border: 1px solid var(--rule);
  border-radius: 999px; color: var(--ink-2);
  font: 500 11.5px var(--font-sans); cursor: pointer;
  transition: border-color .15s ease, background .15s ease, color .15s ease;
}
.chip:hover { border-color: var(--rule-2); color: var(--ink); }
.chip[aria-pressed="true"] {
  background: var(--st-soft); border-color: color-mix(in srgb, var(--st) 45%, transparent);
  color: var(--ink);
}
.chip-dot, .nav-dot, .legend-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--st); flex: none;
}
.chip-count { color: var(--ink-3); font-family: var(--font-mono); font-size: 10.5px; }
.chip[aria-pressed="true"] .chip-count { color: var(--ink-2); }

.nav-count {
  margin: 0; color: var(--ink-3);
  font-family: var(--font-mono); font-size: var(--size-label);
  letter-spacing: var(--track-label);
}
.nav-actions { display: flex; gap: 6px; }
.nav-actions button {
  flex: 1; padding: 5px 8px;
  background: transparent; border: 1px solid var(--rule); border-radius: 7px;
  color: var(--ink-2); font: 500 11px var(--font-sans); cursor: pointer;
  transition: border-color .15s ease, color .15s ease;
}
.nav-actions button:hover { border-color: var(--rule-2); color: var(--ink); }

.nav-groups { display: flex; flex-direction: column; gap: 14px; }
.nav-group h3 {
  margin: 0 0 5px;
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); font-weight: 600; letter-spacing: var(--track-label);
}
.nav-group ol { list-style: none; margin: 0; padding: 0; }
.nav-group li { margin: 0; }
.nav-group a {
  display: grid; grid-template-columns: 7px 18px minmax(0, 1fr);
  align-items: baseline; gap: 8px;
  padding: 5px 8px; border-radius: 7px;
  color: var(--ink-2); text-decoration: none; font-size: 12.2px; line-height: 1.35;
  transition: background .13s ease, color .13s ease;
}
.nav-group a .nav-dot { align-self: center; }
.nav-num { font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); }
.nav-label { overflow-wrap: anywhere; }
.nav-group a:hover { background: var(--surface-2); color: var(--ink); }
/* Surface + weight carry "you are here"; the dot to its left already carries the
   status, so an accent bar would stack a second colour on the same row. */
.nav-group a[aria-current="true"] {
  background: var(--surface); color: var(--ink); font-weight: 600;
}
.nav-empty { color: var(--ink-3); font-size: 12px; font-style: italic; }
`
