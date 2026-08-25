import path from 'path'

/** Runs before first paint so a dark-mode reader never sees a white flash, and so
 *  a stored preference wins over the OS setting. Kept tiny and dependency-free —
 *  the report is a single file that has to work from a zip, offline. */
export const THEME_BOOT_SCRIPT = `
(() => {
  try {
    const stored = localStorage.getItem('canary-evaluation-theme')
    if (stored === 'light' || stored === 'dark') document.documentElement.setAttribute('data-theme', stored)
  } catch (err) { /* private mode / file:// with storage blocked — fall back to the OS setting */ }
})()
`

/** Two rules keep these three icons on one line, and neither is visible in source
 *  review — both were found by measuring the rendered switch.
 *
 *  1. Every glyph's ink box is centred on (10,10) in its 20x20 viewBox, at a
 *     comparable size: sun 15.6, moon 15.0, monitor 15.2 x 13.2. The monitor's
 *     detached stand and the moon's crescent both make this easy to get wrong by
 *     eye — the moon used to be 13.5 and sat 0.57 units down-and-left, which
 *     rendered visibly small and low beside the sun. Verify a glyph edit with
 *     `getBBox()`, not by looking at it.
 *  2. The SVGs contain nothing but SVG elements. `span` (and `div`, `p`, `code`, …)
 *     sit on the HTML parser's foreign-content breakout list: written inside an
 *     `<svg>`, one silently CLOSES the svg and re-parents itself into the button,
 *     adding a second in-flow item to the button's `place-items: center` grid. That
 *     splits its single 24px row in two and lifts the icon — a stray `<span></span>`
 *     in the sun cost it 2.25px. Pinned by test-review-export.test.ts. */
export const THEME_SWITCH_HTML = `<div class="theme-switch" role="radiogroup" aria-label="Colour theme">
  <button type="button" data-theme-set="light" role="radio" aria-checked="false" title="Light"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.6"/><g stroke-linecap="round"><path d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4"/></g></svg><span class="sr-only">Light</span></button>
  <button type="button" data-theme-set="auto" role="radio" aria-checked="true" title="Match system"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.4" y="3.4" width="15.2" height="10.4" rx="1.6"/><path d="M6.5 16.6h7" stroke-linecap="round"/></svg><span class="sr-only">System</span></button>
  <button type="button" data-theme-set="dark" role="radio" aria-checked="false" title="Dark"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a5 5 0 0 0 7.5 7.5a7.5 7.5 0 1 1-7.5-7.5Z"/></svg><span class="sr-only">Dark</span></button>
</div>`
