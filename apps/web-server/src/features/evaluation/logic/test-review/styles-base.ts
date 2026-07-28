// Design tokens, the light and dark palettes, the status-hue vocabulary, and the
// document reset plus reading typography.
export const CSS_BASE = `
/* ------------------------------------------------------------------ *
   Canary Lab evaluation report — "editorial"

   A printed document, not a dashboard. Prose is set in a text serif at
   reading size; the sans and the monospace are chrome — labels, identifiers,
   numbers, anything the machine produced. Cards are dissolved into rules, so
   structure comes from typography and whitespace rather than from boxes.
   Saturated colour is reserved entirely for test status, which makes a glance
   at the page read as results rather than decoration.

   Every tone clears a measured floor: body text and the smallest labels at
   4.5:1 against their own surface, hairlines at 1.8:1, status pills at 4.5:1
   against their own tint — in BOTH modes.

   Both palettes are declared twice on purpose — once under
   prefers-color-scheme (so a JS-less open still respects the OS) and once
   under [data-theme] (so the switch wins in both directions).
 * ------------------------------------------------------------------ */
:root {
  color-scheme: light;

  /* Charter is the text face — a Bitstream serif designed for low-resolution
     printing, so it holds up at reading size on any screen. Everything after it
     is a same-shape fallback; no webfont is fetched, the report opens offline. */
  --font-serif: Charter, "Bitstream Charter", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  --font-sans: "Avenir Next", Avenir, "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", SFMono-Regular, "JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace;

  /* Reading type vs chrome type. Prose — the lede, every case explainer, the
     callouts — is serif at reading size; labels and data stay sans/mono. */
  --size-prose: 16.5px;
  --leading-prose: 1.72;
  --size-label: 11px;
  --track-label: 0.04em;
  --radius: 2px;
  /* One height for every control in the topbar, so pills sitting side by side
     line up on both edges instead of each sizing itself from its own contents. */
  --tool-height: 30px;

  --paper: #f6f4ef;
  --surface: #fffefb;
  --surface-2: #f0ede5;
  --surface-3: #e6e2d8;
  --ink: #1b1a17;
  --ink-2: #4a4842;
  --ink-3: #6c6a62;
  --rule: #c0b8a5;
  --rule-2: #a29982;
  --accent: #1f5b52;
  --accent-soft: #e0ecea;

  --ok: #1a6b44;        --ok-soft: #e0efe5;
  --bad: #a3241a;       --bad-soft: #f9e3e0;
  --warn: #82530a;      --warn-soft: #f7e9d1;
  --skip: #565349;      --skip-soft: #eae7de;
  --none: #6b675d;      --none-soft: #ece9e1;

  --flow-bg: #fffefb;
  --flow-line: #8c8677;
  --flow-shadow: rgba(40, 36, 28, 0.08);
  --flow-neutral-fill: #f0ede5;  --flow-neutral-line: #a8a08c;  --flow-neutral-text: #3a3833;
  --flow-action-fill: #e6ecf2;   --flow-action-line: #4e7391;   --flow-action-text: #223a4a;
  --flow-helper-fill: #ece7f0;   --flow-helper-line: #7c6b91;   --flow-helper-text: #3d3247;
  --flow-assert-fill: #f7edd8;   --flow-assert-line: #ad8534;   --flow-assert-text: #533c0e;
  --flow-pass-fill: #e0efe5;     --flow-pass-line: #2f7d55;     --flow-pass-text: #14472e;
  --flow-fail-fill: #f9e3e0;     --flow-fail-line: #b04034;     --flow-fail-text: #6d1d16;
  --flow-detail-text: #5c5a52;
}

:root[data-theme="dark"] { color-scheme: dark; }

/* The dark palette, declared once per signal. The OS block is scoped with
   :not([data-theme="light"]) so an explicit "light" choice still wins on a
   dark-mode machine. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #121210;
    --surface: #1a1a17;
    --surface-2: #22221e;
    --surface-3: #2c2c27;
    --ink: #f2efe7;
    --ink-2: #b3afa4;
    --ink-3: #95917f;
    --rule: #47473d;
    --rule-2: #5b5b4f;
    --accent: #69cfbe;
    --accent-soft: #12302c;

    --ok: #63c98d;        --ok-soft: #14271c;
    --bad: #f78d7e;       --bad-soft: #2f1712;
    --warn: #e5b565;      --warn-soft: #2d2312;
    --skip: #b0aba0;      --skip-soft: #242420;
    --none: #8b877d;      --none-soft: #1f1f1b;

    --flow-bg: #1a1a17;
    --flow-line: #6d6a5f;
    --flow-shadow: rgba(0, 0, 0, 0.5);
    --flow-neutral-fill: #22221e;  --flow-neutral-line: #5f5c52;  --flow-neutral-text: #d5d1c6;
    --flow-action-fill: #1c2733;   --flow-action-line: #5b829e;   --flow-action-text: #b9cddb;
    --flow-helper-fill: #241f2b;   --flow-helper-line: #8a789e;   --flow-helper-text: #cfc3dc;
    --flow-assert-fill: #2c2413;   --flow-assert-line: #b99340;   --flow-assert-text: #ecd6a2;
    --flow-pass-fill: #14271c;     --flow-pass-line: #3f9c68;     --flow-pass-text: #a9e6c1;
    --flow-fail-fill: #2f1712;     --flow-fail-line: #c25748;     --flow-fail-text: #f5b8ae;
    --flow-detail-text: #a09c90;
  }
}

:root[data-theme="dark"] {
  --paper: #121210;
  --surface: #1a1a17;
  --surface-2: #22221e;
  --surface-3: #2c2c27;
  --ink: #f2efe7;
  --ink-2: #b3afa4;
  --ink-3: #95917f;
  --rule: #47473d;
  --rule-2: #5b5b4f;
  --accent: #69cfbe;
  --accent-soft: #12302c;

  --ok: #63c98d;        --ok-soft: #14271c;
  --bad: #f78d7e;       --bad-soft: #2f1712;
  --warn: #e5b565;      --warn-soft: #2d2312;
  --skip: #b0aba0;      --skip-soft: #242420;
  --none: #8b877d;      --none-soft: #1f1f1b;

  --flow-bg: #1a1a17;
  --flow-line: #6d6a5f;
  --flow-shadow: rgba(0, 0, 0, 0.5);
  --flow-neutral-fill: #22221e;  --flow-neutral-line: #5f5c52;  --flow-neutral-text: #d5d1c6;
  --flow-action-fill: #1c2733;   --flow-action-line: #5b829e;   --flow-action-text: #b9cddb;
  --flow-helper-fill: #241f2b;   --flow-helper-line: #8a789e;   --flow-helper-text: #cfc3dc;
  --flow-assert-fill: #2c2413;   --flow-assert-line: #b99340;   --flow-assert-text: #ecd6a2;
  --flow-pass-fill: #14271c;     --flow-pass-line: #3f9c68;     --flow-pass-text: #a9e6c1;
  --flow-fail-fill: #2f1712;     --flow-fail-line: #c25748;     --flow-fail-text: #f5b8ae;
  --flow-detail-text: #a09c90;
}

/* One line per status; every dot, pill, chip, bar segment and matrix cell
   reads --st / --st-soft, so a status never needs its own component rule. */
.dot-passed, .pill-passed, .chip-passed, .bar-passed, .cell-passed { --st: var(--ok); --st-soft: var(--ok-soft); }
.dot-failed, .pill-failed, .chip-failed, .bar-failed, .cell-failed { --st: var(--bad); --st-soft: var(--bad-soft); }
.dot-interrupted, .pill-interrupted, .chip-interrupted, .bar-interrupted, .cell-interrupted { --st: var(--warn); --st-soft: var(--warn-soft); }
.dot-skipped, .pill-skipped, .chip-skipped, .bar-skipped, .cell-skipped { --st: var(--skip); --st-soft: var(--skip-soft); }
.dot-notrun, .pill-notrun, .chip-notrun, .bar-notrun, .cell-notrun { --st: var(--none); --st-soft: var(--none-soft); }
.dot-all, .chip-all { --st: var(--ink-2); --st-soft: var(--surface-2); }

* { box-sizing: border-box; }

html { scroll-behavior: smooth; scroll-padding-top: 84px; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 400 15px/1.6 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

h1, h2, h3, p, ol, ul, dl, figure, pre { margin-top: 0; }

/* Reading type. Anything a person reads in sentences gets the serif at reading
   size; everything else stays sans/mono chrome. */
.lede, .case-explainer, .notice p, .confidence-note, .coverage > .muted {
  font-family: var(--font-serif);
  font-size: var(--size-prose);
  line-height: var(--leading-prose);
}

a { color: var(--accent); text-underline-offset: 2px; }

code, kbd { font-family: var(--font-mono); font-size: 0.9em; }

.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.skip-link {
  position: absolute; left: 12px; top: -60px; z-index: 60;
  padding: 9px 14px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--rule-2);
  font-weight: 600; text-decoration: none;
  transition: top .16s ease;
}
.skip-link:focus { top: 12px; }

:where(a, button, input, summary):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 6px;
}
`
