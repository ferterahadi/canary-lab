// Per-case cards and everything inside them — failure detail, subsections,
// drawers, checks, code blocks — plus the motion, responsive and print rules.
export const CSS_CASE = `
/* ------------------------------------------------------------ case cards */

.case {
  margin-bottom: 0;
  border-top: 1px solid var(--rule);
  scroll-margin-top: 76px;
}
/* The status edge is an inset shadow rather than a border so it can sit on a
   borderless entry without shifting the text off the column. */
.case[data-status="failed"] { box-shadow: inset 3px 0 0 var(--bad); }
.case[data-status="interrupted"] { box-shadow: inset 3px 0 0 var(--warn); }
.case[data-status="notRun"] { color: var(--ink-2); }
.case[data-status="notRun"] .case-title { color: var(--ink-2); }
.case.is-target { border-color: var(--accent); }

.case-toggle {
  display: grid; grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center; gap: 14px; width: 100%;
  padding: 17px 18px 14px; border: 0; background: transparent;
  color: inherit; text-align: left; cursor: pointer; font: inherit;
}
.case-toggle:hover { background: var(--surface-2); }
.case-index {
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  color: var(--ink-3); font-variant-numeric: tabular-nums;
}
.case-headline { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.case-title {
  font-family: var(--font-serif); font-size: 20px; line-height: 1.3;
  letter-spacing: -0.004em; overflow-wrap: anywhere;
}
.case-subline {
  color: var(--ink-3); font-family: var(--font-mono); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.tag {
  padding: 1px 6px; border-radius: var(--radius);
  background: var(--surface-2); border: 1px solid var(--rule);
  color: var(--ink-3); font-family: var(--font-mono); font-size: 10.5px;
}
.case-head-right { display: flex; align-items: center; gap: 10px; flex: none; }
.case-duration {
  color: var(--ink-3); font-family: var(--font-mono); font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.case-chevron {
  width: 8px; height: 8px; border-right: 1.6px solid var(--ink-3); border-bottom: 1.6px solid var(--ink-3);
  transform: rotate(45deg) translate(-2px, -2px);
  transition: transform .18s ease;
}
.case[data-open="false"] .case-chevron { transform: rotate(-45deg) translate(-2px, 2px); }
.case[data-open="false"] .case-body { display: none; }

.pill {
  display: inline-flex; align-items: center;
  padding: 3px 9px; border-radius: 999px;
  background: var(--st-soft); color: var(--st);
  border: 1px solid color-mix(in srgb, var(--st) 38%, transparent);
  font-family: var(--font-mono); font-size: 10px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase; white-space: nowrap;
}

.case-body { padding: 0 18px 26px; }

.facts {
  display: flex; flex-wrap: wrap; gap: 0;
  margin: 16px 0 14px;
}
.facts div {
  display: flex; flex-direction: column; gap: 3px;
  padding-right: 20px; margin-right: 20px;
  border-right: 1px solid var(--rule);
}
.facts div:last-child { border-right: 0; margin-right: 0; padding-right: 0; }

.case-explainer { margin-bottom: 16px; max-width: 74ch; font-size: 14px; }

.case-notrun {
  margin-bottom: 16px; padding: 11px 14px;
  border-left: 2px solid var(--none); border-radius: 0 8px 8px 0;
  background: var(--none-soft); color: var(--ink-2); font-size: 12.5px;
}

.strength {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-family: var(--font-mono); font-size: 10px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; border: 1px solid;
}
.strength-strong  { color: var(--ok);   background: var(--ok-soft);   border-color: color-mix(in srgb, var(--ok) 38%, transparent); }
.strength-solid   { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 38%, transparent); }
.strength-basic   { color: var(--warn); background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 38%, transparent); }
.strength-shallow { color: var(--bad);  background: var(--bad-soft);  border-color: color-mix(in srgb, var(--bad) 38%, transparent); }

/* --------------------------------------------------------------- failure */

.failure {
  margin: 0 0 18px; padding: 14px 16px;
  background: var(--bad-soft);
  border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent);
  border-left-width: 3px;
  border-radius: var(--radius);
}
.failure h3 {
  margin: 0 0 9px; color: var(--bad);
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.09em; text-transform: uppercase;
}
.failure-message, .failure-snippet {
  margin: 0; padding: 10px 12px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--bad) 18%, transparent);
  border-radius: var(--radius);
  font-family: var(--font-mono); font-size: 11.5px; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: auto;
}
.failure-snippet { margin-top: 8px; white-space: pre; overflow-wrap: normal; color: var(--ink-2); }

/* ------------------------------------------------------------ subsection */

.subsection { margin-top: 18px; }
.subsection h3 {
  margin-bottom: 9px; color: var(--ink-3);
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.09em; text-transform: uppercase;
}
.flow-frame { margin: 0; }
.flow-frame svg {
  display: block; width: 100%; height: auto; max-height: 340px;
  background: var(--flow-bg);
  border: 1px solid var(--rule); border-radius: var(--radius);
}

.video-frame { margin: 0 0 12px; }
video {
  display: block; width: 100%; max-height: 520px;
  background: #05070a; border: 1px solid var(--rule); border-radius: 10px;
}
figcaption { margin-top: 6px; font-size: 12px; color: var(--ink-2); }

/* --------------------------------------------------------------- drawers */

.drawers { display: flex; flex-direction: column; gap: 0; margin-top: 18px; }
.drawer { border-top: 1px solid var(--rule); }
.drawer > summary {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 0; list-style: none; cursor: pointer; user-select: none;
  color: var(--ink-2); font-family: var(--font-mono);
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase;
}
.drawer > summary::-webkit-details-marker { display: none; }
.drawer > summary::before {
  content: ""; flex: none;
  width: 6px; height: 6px;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform .18s ease;
}
.drawer[open] > summary::before { transform: rotate(45deg); }
.drawer > summary:hover { color: var(--ink); }
.drawer-body { padding-bottom: 14px; }

.implementations { margin-top: 34px; }
.implementations .drawer { border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }

/* ---------------------------------------------------------------- checks */

.assertions { margin: 0; padding-left: 18px; }
.assertions li { margin: 9px 0; }
.confidence-note { margin-bottom: 10px; color: var(--ink-2); font-size: 13px; }
.quality {
  display: inline-flex; align-items: center;
  padding: 1px 7px; border-radius: 999px; border: 1px solid;
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase;
}
.quality-strict   { color: var(--ok);     background: var(--ok-soft);     border-color: color-mix(in srgb, var(--ok) 36%, transparent); }
.quality-moderate { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 36%, transparent); }
.quality-shallow  { color: var(--warn);   background: var(--warn-soft);   border-color: color-mix(in srgb, var(--warn) 36%, transparent); }
.quality-unknown  { color: var(--skip);   background: var(--skip-soft);   border-color: color-mix(in srgb, var(--skip) 36%, transparent); }

.assertions code, dd code {
  background: var(--surface-2); border: 1px solid var(--rule);
  border-radius: 4px; padding: 1px 4px; font-size: 11.5px;
}
.check-code { display: block; margin-top: 5px; }
.check-code > summary {
  display: inline-block; list-style: none; cursor: pointer;
  color: var(--ink-3); font-size: 11px;
}
.check-code > summary::-webkit-details-marker { display: none; }
.check-code > summary::before { content: "+ "; }
.check-code[open] > summary::before { content: "- "; }
.check-code code { display: inline-block; margin-top: 5px; }
.helper-ref { margin-top: 4px; color: var(--ink-3); font-size: 12px; }

/* ------------------------------------------------------------------ code */

.shiki, .fallback-code {
  border: 1px solid var(--rule); border-radius: var(--radius);
  overflow: auto; padding: 12px !important; margin: 0 !important;
  font-size: 12px; line-height: 1.6;
}
.shiki code, .fallback-code code { font-family: var(--font-mono); font-size: inherit; }
/* Shiki emits both palettes as custom properties (defaultColor:false), so the
   theme switch recolours the highlighted code with everything else. */
.shiki, .shiki span { color: var(--shiki-light); }
:root[data-theme="dark"] .shiki, :root[data-theme="dark"] .shiki span { color: var(--shiki-dark); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .shiki, :root:not([data-theme="light"]) .shiki span { color: var(--shiki-dark); }
}
/* Syntax colours come from shiki; the panel itself takes the report's surface so
   a code block doesn't punch a differently-tinted hole in the page. */
.shiki, .fallback-code { background: var(--surface-2) !important; }

.code-line { display: grid; grid-template-columns: 34px minmax(0, 1fr); min-width: max-content; }
.line-number { padding-right: 10px; color: var(--ink-3); text-align: right; user-select: none; opacity: .7; }
.line-source { white-space: pre; }
.code-line.is-highlighted {
  background: color-mix(in srgb, var(--warn) 20%, transparent) !important;
  box-shadow: inset 2px 0 0 var(--warn);
}

/* ----------------------------------------------------------------- misc. */

.report-foot {
  display: flex; flex-direction: column; gap: 4px;
  margin-top: 48px; padding-top: 18px;
  border-top: 1px solid var(--rule);
  color: var(--ink-3); font-size: 12px;
}

.to-top {
  position: fixed; right: 22px; bottom: 22px; z-index: 30;
  width: 38px; height: 38px; padding: 0;
  display: grid; place-items: center;
  background: var(--surface); color: var(--ink-2);
  border: 1px solid var(--rule-2); border-radius: 50%;
  cursor: pointer;
  opacity: 0; pointer-events: none;
  transition: opacity .2s ease, transform .2s ease;
  transform: translateY(6px);
}
.to-top::before {
  content: ""; width: 8px; height: 8px;
  border-left: 1.6px solid currentColor; border-top: 1.6px solid currentColor;
  transform: rotate(45deg) translate(1px, 1px);
}
.to-top.is-visible { opacity: 1; pointer-events: auto; transform: none; }
.to-top:hover { color: var(--accent); border-color: var(--accent); }

.is-hidden { display: none !important; }

/* --------------------------------------------------------------- motion */

@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.masthead > *, .coverage, .matrix { animation: rise .5s cubic-bezier(.2,.7,.3,1) both; }
.masthead > *:nth-child(2) { animation-delay: .04s; }
.masthead > *:nth-child(3) { animation-delay: .08s; }
.masthead > *:nth-child(4) { animation-delay: .12s; }
.masthead > *:nth-child(5) { animation-delay: .16s; }
.coverage { animation-delay: .18s; }
.matrix { animation-delay: .22s; }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
}

/* ------------------------------------------------------------ responsive */

@media (max-width: 1080px) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .rail {
    position: static; padding-top: 24px;
    border-bottom: 1px solid var(--rule); padding-bottom: 20px;
  }
  .nav { max-height: none; overflow: visible; }
  .nav-groups { display: none; }
  main { padding-top: 28px; }
}

@media (max-width: 720px) {
  .topbar-inner, .shell { width: min(100%, 100% - 24px); }
  .topbar-now { display: none; }
  .verdict { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .run-meta div { border-right: 0; margin-right: 0; padding: 8px 0; }
  .facts div { border-right: 0; margin-right: 0; padding: 6px 0; }
  .case-toggle { grid-template-columns: 24px minmax(0, 1fr); row-gap: 8px; }
  .case-head-right { grid-column: 2; justify-content: flex-start; }
  .matrix-cells { max-width: none; }
}

/* ----------------------------------------------------------------- print */

@media print {
  :root { --paper: #fff; --surface: #fff; }
  .topbar, .rail, .to-top, .skip-link { display: none !important; }
  .shell { display: block; width: 100%; }
  main { padding: 0; }
  .case { break-inside: avoid; }
  .case[data-open="false"] .case-body { display: block !important; }
  .drawer > summary { display: none; }
  .drawer-body { display: block !important; }
  .is-hidden { display: block !important; }
}
`
