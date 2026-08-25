// The report body above the cases: masthead, verdict figure, notices, run meta,
// section headings, coverage overview, result matrix, spec-group headers.
export const CSS_REPORT = `
/* -------------------------------------------------------------- masthead */

.masthead { margin-bottom: 44px; }
.eyebrow {
  margin-bottom: 12px; color: var(--accent);
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.14em; text-transform: uppercase;
}
h1 {
  margin-bottom: 16px;
  font-family: var(--font-serif); font-weight: 400;
  font-size: clamp(30px, 4.4vw, 44px); line-height: 1.1;
  letter-spacing: -0.012em; text-wrap: balance;
}
.lede {
  max-width: 66ch; margin-bottom: 30px; color: var(--ink-2);
}

/* --------------------------------------------------------------- verdict */

.verdict {
  display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: 30px; align-items: center;
  padding: 22px 0;
  border-top: 1px solid var(--rule-2);
  border-bottom: 1px solid var(--rule-2);
}
.verdict-figure { display: flex; flex-direction: column; gap: 3px; }
.verdict-ratio {
  font-family: var(--font-serif); font-size: 46px; line-height: 1;
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
  color: var(--ink-2);
}
.verdict-ratio strong { font-weight: 400; color: var(--ink); }
.verdict-slash { margin: 0 2px; color: var(--ink-3); font-size: 34px; }
.verdict-caption {
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); letter-spacing: var(--track-label);
}
.verdict-chart { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.bar {
  display: flex; gap: 2px; height: 12px;
  border-radius: 999px; overflow: hidden;
  background: var(--surface-3);
}
.bar-seg {
  background: var(--st); min-width: 4px;
  transition: flex-grow .4s cubic-bezier(.2,.7,.3,1);
}
.legend {
  display: flex; flex-wrap: wrap; gap: 4px 22px;
  list-style: none; margin: 0; padding: 0;
}
.legend-item { display: flex; align-items: baseline; gap: 7px; }
.legend-item .legend-dot { align-self: center; }
.legend-item.is-zero { opacity: 0.35; }
.legend-value {
  font-family: var(--font-mono); font-size: 15px; font-weight: 600;
  font-variant-numeric: tabular-nums; color: var(--ink);
}
.legend-label {
  color: var(--ink-2); font-size: 11px;
  letter-spacing: 0.05em; text-transform: uppercase;
}

/* --------------------------------------------------------------- notices */

.notice {
  display: flex; gap: 14px; align-items: flex-start;
  margin-top: 18px; padding: 15px 18px;
  border: 1px solid color-mix(in srgb, var(--none) 40%, transparent);
  border-radius: var(--radius); background: var(--none-soft);
}
.notice p { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--ink-2); }
.notice p strong { color: var(--ink); }
.notice-badge {
  flex: none; padding: 3px 9px; border-radius: 999px;
  background: color-mix(in srgb, var(--none) 20%, transparent);
  color: var(--ink); font-family: var(--font-mono);
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  white-space: nowrap;
}

/* -------------------------------------------------------------- run meta */

.run-meta {
  display: flex; flex-wrap: wrap; gap: 0;
  margin: 22px 0 0; padding: 0;
  border-top: 1px solid var(--rule);
}
.run-meta div {
  display: flex; flex-direction: column; gap: 3px;
  padding: 12px 22px 12px 0; margin-right: 22px;
  border-right: 1px solid var(--rule);
}
.run-meta div:last-child { border-right: 0; margin-right: 0; }
dt {
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); font-weight: 600; letter-spacing: var(--track-label);
}
dd { margin: 0; font-size: 13.5px; overflow-wrap: anywhere; }

/* ------------------------------------------------------- section heading */

.rule-heading {
  display: flex; align-items: baseline; gap: 12px;
  margin: 0 0 18px; padding-bottom: 9px;
  border-bottom: 1px solid var(--rule);
  font-family: var(--font-serif); font-weight: 400; font-size: 23px;
  letter-spacing: -0.01em;
}
.rule-heading span {
  margin-left: auto;
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
}

/* -------------------------------------------------------------- coverage */

.coverage { margin-bottom: 44px; }
.stat-row { display: flex; flex-wrap: wrap; gap: 0 44px; margin-bottom: 12px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-value {
  font-family: var(--font-serif); font-size: 32px; line-height: 1.05;
  font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
}
.stat-unit { color: var(--ink-3); font-size: 20px; }
.stat-label {
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); letter-spacing: var(--track-label);
}
.muted { color: var(--ink-2); font-size: 12.5px; max-width: 78ch; }

/* ---------------------------------------------------------------- matrix */

.matrix { margin-bottom: 48px; }
.matrix-groups { display: flex; flex-wrap: wrap; gap: 22px 32px; }
.matrix-group { display: flex; flex-direction: column; gap: 7px; }
.matrix-label {
  margin: 0; color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); letter-spacing: var(--track-label);
}
.matrix-cells { display: flex; flex-wrap: wrap; gap: 4px; max-width: 260px; }
.cell {
  display: grid; place-items: center;
  width: 26px; height: 26px; border-radius: 6px;
  background: var(--st-soft);
  border: 1px solid color-mix(in srgb, var(--st) 42%, transparent);
  color: var(--st); text-decoration: none;
  font-family: var(--font-mono); font-size: 10px; font-weight: 600;
  transition: transform .13s ease, box-shadow .13s ease;
}
.cell:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 10px -4px color-mix(in srgb, var(--st) 55%, transparent);
}
.cell-notrun { border-style: dashed; }

/* ------------------------------------------------------------ spec group */

.spec-group { margin-bottom: 34px; }
.spec-heading {
  display: flex; align-items: baseline; gap: 10px;
  margin: 0 0 12px;
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3);
}
.spec-heading::after {
  content: ""; flex: 1; height: 1px; background: var(--rule);
}
.spec-count { order: 3; color: var(--ink-3); font-weight: 500; }
`
