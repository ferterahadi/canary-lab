import path from 'path'
import { codeToHtml } from 'shiki'
import { formatCodeForDisplay } from '../../../../../../../shared/code-display-format'
import type { CoverageLedger, TestCoverage, TestStrength } from '../../../../../../../shared/coverage/types'
import { qualitySummaryForAudience } from './assertions'
import { displayCaseTitle, shortLocation, specFileLabel } from './audience'
import { createFlowcharts } from './flowchart'
import { statusBucket, testStatusCounts } from './packet'
import { ASSERTION_HTML_SCRIPT } from './report-script'
import { ASSERTION_HTML_CSS } from './report-styles'
import { THEME_BOOT_SCRIPT, THEME_SWITCH_HTML } from './report-theme'
import { flattenHelpers } from './source-analysis'
import { comparableTitle, dedupe, escapeAttr, escapeHtml, formatMs, inline, splitAnnotations, statusClass, titleCaseFeatureName, uniqueSectionIds } from './text'
import type { AssertionHtmlOptions, AssertionQuality, EvaluationRewrite, HelperDefinition, NavGroup, TestFlowchart, TestReviewAssertion, TestReviewCase, TestReviewPacket, TestStatusCounts } from './types'

// Display labels for coverage's per-test STRENGTH (depth axis), used when a feature
// has a generated coverage ledger. Distinct vocabulary from AssertionQuality
// ("specificity" axis) so the report carries two non-competing signals.
export const STRENGTH_LABEL: Record<TestStrength, string> = {
  strong: 'Strong',
  solid: 'Solid',
  basic: 'Basic',
  shallow: 'Shallow',
}

// The rewrite is a parameter rather than a field on `options`: both callers
// normalize (falling back to the deterministic rewrite) before building the
// flowcharts from it, so re-deriving it here only re-ran an idempotent
// normalize on an already-normalized value and left two arms that could never
// be taken.
export async function renderHtml(
  packet: TestReviewPacket,
  options: AssertionHtmlOptions,
  rewrite: EvaluationRewrite,
  flowcharts: TestFlowchart[],
): Promise<string> {
  const displayFeature = rewrite.featureTitle?.trim() || titleCaseFeatureName(packet.feature)
  const testIds = uniqueSectionIds(packet.tests.map((test, idx) => `${idx + 1}-${test.title}`))
  const flowchartByTestName = new Map(flowcharts.map((flowchart) => [flowchart.testName, flowchart]))
  // Coverage strength is keyed by the source test title (== ledger test name).
  const coverageByTitle = new Map<string, TestCoverage>()
  if (options.coverage) for (const t of options.coverage.tests) coverageByTitle.set(t.name, t)
  const implementationId = 'local-codebase-implementations'
  const counts = testStatusCounts(packet.tests)
  const groups = groupTestsBySpec(packet.tests, testIds, rewrite)
  const externalImports = dedupe(packet.tests.flatMap((test) => test.externalImports)).sort()
  const helpers = flattenHelpers(packet.tests.flatMap((test) => test.helperDefinitions))

  const caseCards = await Promise.all(packet.tests.map(async (test, idx) => {
    const videoLinks = options.videoLinksByTestName?.[test.name] ?? []
    // Always present: `createFlowcharts` emits one entry per packet test keyed
    // by `test.name`, and it is the only thing renderHtml is ever called with.
    const flowchart = flowchartByTestName.get(test.name)!
    const audienceCase = rewrite.cases[idx]
    const cov = coverageByTitle.get(test.title)
    const bucket = statusBucket(test.status)
    const reqs = cov?.requirements ?? []
    const raw = splitAnnotations(test.title)
    const headline = displayCaseTitle(audienceCase.title, test.title)
    // The raw Playwright title only earns a line when it says something the
    // headline doesn't — otherwise it is the same sentence twice.
    const showSubline = comparableTitle(test.title) !== comparableTitle(headline)
    // When coverage exists it's the headline (depth); specificity is demoted to a
    // secondary, clearly-different axis. Without coverage, specificity stands alone.
    return `
      <article class="case" id="${escapeAttr(testIds[idx])}" data-status="${escapeAttr(bucket)}" data-open="true" data-search="${escapeAttr(searchIndexFor(test, audienceCase.title, reqs))}">
        <div class="case-head">
          <button class="case-toggle" type="button" aria-expanded="true" aria-controls="${escapeAttr(testIds[idx])}-body">
            <span class="case-index">${String(idx + 1).padStart(2, '0')}</span>
            <span class="case-headline">
              <span class="case-title">${escapeHtml(headline)}</span>
              ${showSubline ? `<span class="case-subline">${escapeHtml(raw.text)}</span>` : ''}
              ${raw.tags.length ? `<span class="tags">${raw.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
            </span>
            <span class="case-head-right">
              ${renderStatusPill(test.status)}
              ${typeof test.durationMs === 'number' ? `<span class="case-duration">${escapeHtml(formatMs(test.durationMs))}</span>` : ''}
              <span class="case-chevron" aria-hidden="true"></span>
            </span>
          </button>
        </div>
        <div class="case-body" id="${escapeAttr(testIds[idx])}-body">
          <dl class="facts">
            ${cov ? `<div><dt>Coverage strength</dt><dd>${renderCoverageStrength(cov)}</dd></div>` : ''}
            <div><dt>${cov ? 'Assertion specificity' : 'Check specificity'}</dt><dd>${escapeHtml(qualitySummaryForAudience(test.assertions))}</dd></div>
            ${test.location ? `<div><dt>Declared at</dt><dd><code>${escapeHtml(shortLocation(test.location))}</code></dd></div>` : ''}
          </dl>
          <p class="case-explainer">${escapeHtml(audienceCase.whatWasChecked)}</p>
          ${bucket === 'notRun' ? NEVER_RAN_CALLOUT : ''}
          ${renderFailureDetail(test)}
          ${renderFlowchartSection(flowchart, audienceCase.title)}
          <div class="drawers">
            <details class="drawer test-code-details">
              <summary>Test code</summary>
              <div class="drawer-body">${test.testBody ? await renderTestCode(test.testBody) : '<p class="muted">Source unavailable.</p>'}</div>
            </details>
            <details class="drawer checks-details">
              <summary>Checks</summary>
              <div class="drawer-body">
                <p class="confidence-note">${escapeHtml(audienceCase.confidence)}</p>
                <ul class="assertions">${test.assertions.map(renderAssertionHtml).join('')}</ul>
              </div>
            </details>
          </div>
          ${videoLinks.length ? renderVideoSection(videoLinks) : ''}
        </div>
      </article>
    `
  }))

  const caseSections = groups.map((group) => `
    <section class="spec-group" data-group>
      <h2 class="spec-heading" id="${escapeAttr(group.id)}">
        <span class="spec-name">${escapeHtml(group.label)}</span>
        <span class="spec-count">${group.items.length} ${group.items.length === 1 ? 'test' : 'tests'}</span>
      </h2>
      ${group.items.map((item) => caseCards[item.index]).join('')}
    </section>
  `).join('')

  const implementations = await renderImplementations(externalImports, helpers, implementationId)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Evaluation Report: ${escapeHtml(displayFeature)}</title>
  <style>${ASSERTION_HTML_CSS}</style>
  <script>${THEME_BOOT_SCRIPT}</script>
</head>
<body>
  <a class="skip-link" href="#report">Skip to report</a>
  <header class="topbar">
    <div class="topbar-inner">
      <span class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-text">Canary Lab<span class="brand-sub">Evaluation report</span></span>
      </span>
      <span class="topbar-now" data-topbar-now aria-live="polite"></span>
      <div class="topbar-tools">
        <code class="run-chip" title="Run id">${escapeHtml(packet.runId)}</code>
        ${THEME_SWITCH_HTML}
      </div>
    </div>
  </header>
  <div class="shell">
    <aside class="rail">
      <nav class="nav" aria-label="Test cases">
        <div class="nav-search">
          <input type="search" id="case-search" placeholder="Search tests…" autocomplete="off" aria-label="Search test cases">
        </div>
        ${renderFilterChips(counts)}
        <p class="nav-count" data-nav-count>${packet.tests.length} of ${packet.tests.length} shown</p>
        <div class="nav-actions">
          <button type="button" data-expand-all>Expand all</button>
          <button type="button" data-collapse-all>Collapse all</button>
        </div>
        ${renderNavGroups(groups)}
        <p class="nav-empty" data-nav-empty hidden>No test matches this filter.</p>
      </nav>
    </aside>
    <main id="report">
      <header class="masthead">
        <p class="eyebrow">Evaluation report</p>
        <h1>${escapeHtml(displayFeature)}</h1>
        <p class="lede">${escapeHtml(rewrite.summary)}</p>
        ${renderVerdict(packet, counts)}
        ${counts.notRun > 0 ? renderNeverRanNotice(counts.notRun, packet.tests.length) : ''}
        <dl class="run-meta">
          <div><dt>Run</dt><dd><code>${escapeHtml(packet.runId)}</code></dd></div>
          <div><dt>Status</dt><dd>${renderStatusPill(packet.status)}</dd></div>
          <div><dt>Result</dt><dd>${packet.passed}/${packet.total} passed</dd></div>
          <div><dt>Started</dt><dd>${escapeHtml(packet.startedAt)}</dd></div>
          ${packet.endedAt ? `<div><dt>Ended</dt><dd>${escapeHtml(packet.endedAt)}</dd></div>` : ''}
        </dl>
      </header>
      ${options.coverage ? renderCoverageOverview(options.coverage, packet.runId) : ''}
      ${renderMatrix(groups, packet.tests)}
      <section id="test-cases" aria-label="Test cases">
        <h2 class="rule-heading">Test cases<span>${packet.tests.length}</span></h2>
        ${caseSections}
      </section>
      ${implementations}
      <footer class="report-foot">
        <span>Generated by Canary Lab from run <code>${escapeHtml(packet.runId)}</code>.</span>
        <span>Every case below is a test declared by this feature — including the ones this run never reached.</span>
      </footer>
    </main>
  </div>
  <button class="to-top" type="button" data-to-top aria-label="Back to top"></button>
  <script>${ASSERTION_HTML_SCRIPT}</script>
</body>
</html>
`
}

/** Cases are grouped by the spec file they're declared in — with 20+ tests a flat
 *  list stops being navigable, and the spec file is the grouping a reader already
 *  has in their head. Tests with no known location fall into one trailing group. */
export function groupTestsBySpec(tests: TestReviewCase[], testIds: string[], rewrite: EvaluationRewrite): NavGroup[] {
  const groups = new Map<string, NavGroup>()
  tests.forEach((test, index) => {
    const label = test.location ? specFileLabel(test.location) : 'Other tests'
    let group = groups.get(label)
    if (!group) {
      group = { id: `spec-${statusClass(label)}`, label, items: [] }
      groups.set(label, group)
    }
    group.items.push({
      index,
      id: testIds[index],
      label: displayCaseTitle(rewrite.cases[index].title, test.title),
      status: statusBucket(test.status),
      rawTitle: test.title,
    })
  })
  return [...groups.values()]
}

export function searchIndexFor(test: TestReviewCase, audienceTitleText: string, requirements: string[]): string {
  return [audienceTitleText, test.title, test.status, ...requirements.map((id) => `@req-${id}`)]
    .join(' ')
    .toLowerCase()
}

export const VERDICT_SEGMENTS: Array<{ key: keyof TestStatusCounts; label: string }> = [
  { key: 'passed', label: 'Passed' },
  { key: 'failed', label: 'Failed' },
  { key: 'interrupted', label: 'Interrupted' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'notRun', label: 'Never ran' },
]

/** The headline the old report couldn't show: every declared test placed in exactly
 *  one bucket, summing to the declared total. The pass fraction is read straight
 *  off the run summary — never derived as `total - failed`. */
export function renderVerdict(packet: TestReviewPacket, counts: TestStatusCounts): string {
  const declared = packet.tests.length || 1
  const bar = VERDICT_SEGMENTS
    .filter((segment) => counts[segment.key] > 0)
    .map((segment) => `<span class="bar-seg bar-${escapeAttr(statusClass(segment.key))}" style="flex-grow:${counts[segment.key]}" title="${escapeAttr(`${segment.label}: ${counts[segment.key]}`)}"></span>`)
    .join('')
  const legend = VERDICT_SEGMENTS
    .map((segment) => `<li class="legend-item${counts[segment.key] === 0 ? ' is-zero' : ''}" data-legend="${escapeAttr(segment.key)}">
      <span class="legend-dot dot-${escapeAttr(statusClass(segment.key))}"></span>
      <span class="legend-value">${counts[segment.key]}</span>
      <span class="legend-label">${escapeHtml(segment.label)}</span>
    </li>`)
    .join('')
  return `<section class="verdict" aria-label="Run verdict">
    <div class="verdict-figure">
      <span class="verdict-ratio"><strong>${packet.passed}</strong><span class="verdict-slash">/</span>${packet.total}</span>
      <span class="verdict-caption">tests passed of ${packet.total} declared</span>
    </div>
    <div class="verdict-chart">
      <div class="bar" role="img" aria-label="${escapeAttr(VERDICT_SEGMENTS.map((s) => `${s.label} ${counts[s.key]}`).join(', '))}">${bar}</div>
      <ul class="legend">${legend}</ul>
    </div>
  </section>`
}

export function renderNeverRanNotice(notRun: number, declared: number): string {
  return `<aside class="notice notice-notrun" role="note">
    <span class="notice-badge">Incomplete run</span>
    <p><strong>${notRun} of ${declared} declared tests never ran.</strong> Execution stopped before reaching them, so they carry no result in either direction — they are listed below as evidence of what this run did <em>not</em> verify, not as passes.</p>
  </aside>`
}

export const NEVER_RAN_CALLOUT = `<div class="case-notrun">This test was declared but never executed in this run. Everything shown below is read from its source — there is no recorded result.</div>`

export function renderFailureDetail(test: TestReviewCase): string {
  if (!test.error) return ''
  return `<section class="failure">
    <h3>Why it failed</h3>
    <pre class="failure-message">${escapeHtml(test.error.message.trim())}</pre>
    ${test.error.snippet ? `<pre class="failure-snippet">${escapeHtml(test.error.snippet.replace(/\s+$/, ''))}</pre>` : ''}
  </section>`
}

export function renderStatusPill(status: string): string {
  return `<span class="pill pill-${escapeAttr(statusClass(statusBucket(status)))}">${escapeHtml(status)}</span>`
}

export function renderFilterChips(counts: TestStatusCounts): string {
  const chips = [
    { key: 'all', label: 'All', count: Object.values(counts).reduce((a, b) => a + b, 0) },
    ...VERDICT_SEGMENTS.map((segment) => ({ key: segment.key as string, label: segment.label, count: counts[segment.key] })),
  ].filter((chip) => chip.count > 0)
  return `<div class="filters" role="group" aria-label="Filter by result">
    ${chips.map((chip) => `<button type="button" class="chip chip-${escapeAttr(statusClass(chip.key))}" data-filter="${escapeAttr(chip.key)}"${chip.key === 'all' ? ' aria-pressed="true"' : ' aria-pressed="false"'}>
      <span class="chip-dot dot-${escapeAttr(statusClass(chip.key))}"></span>${escapeHtml(chip.label)}<span class="chip-count">${chip.count}</span>
    </button>`).join('')}
  </div>`
}

export function renderNavGroups(groups: NavGroup[]): string {
  return `<div class="nav-groups">
    ${groups.map((group) => `<section class="nav-group" data-nav-group>
      <h3>${escapeHtml(group.label)}</h3>
      <ol>
        ${group.items.map((item) => `<li data-nav-item data-status="${escapeAttr(item.status)}">
          <a href="#${escapeAttr(item.id)}" data-section-id="${escapeAttr(item.id)}">
            <span class="nav-dot dot-${escapeAttr(statusClass(item.status))}"></span>
            <span class="nav-num">${String(item.index + 1).padStart(2, '0')}</span>
            <span class="nav-label">${escapeHtml(item.label)}</span>
          </a>
        </li>`).join('')}
      </ol>
    </section>`).join('')}
  </div>`
}

/** A one-screen map of the whole suite: one cell per declared test, coloured by
 *  result. With 23 cases this is the fastest read in the document — and the only
 *  place the never-ran block is visible as a block. */
export function renderMatrix(groups: NavGroup[], tests: TestReviewCase[]): string {
  if (tests.length < 2) return ''
  return `<section class="matrix" aria-label="Result map">
    <h2 class="rule-heading">Result map<span>${tests.length}</span></h2>
    <div class="matrix-groups">
      ${groups.map((group) => `<div class="matrix-group">
        <p class="matrix-label">${escapeHtml(group.label)}</p>
        <div class="matrix-cells">
          ${group.items.map((item) => `<a class="cell cell-${escapeAttr(statusClass(item.status))}" href="#${escapeAttr(item.id)}" data-matrix-cell data-status="${escapeAttr(item.status)}" title="${escapeAttr(`${item.index + 1}. ${item.rawTitle} — ${item.status === 'notRun' ? 'never ran' : item.status}`)}"><span>${item.index + 1}</span></a>`).join('')}
        </div>
      </div>`).join('')}
    </div>
  </section>`
}

// Per-test coverage strength (depth) + the requirements it maps to. The headline
// quality signal when a coverage ledger exists.
export function renderCoverageStrength(tc: TestCoverage): string {
  const strength = tc.strength ?? 'shallow'
  const label = STRENGTH_LABEL[strength]
  const reqs = tc.requirements.length
    ? `covers ${tc.requirements.map((id) => `@req-${id}`).join(', ')}`
    : 'unmapped'
  return `<strong class="strength strength-${escapeAttr(strength)}">${escapeHtml(label)}</strong> <span class="muted">${escapeHtml(reqs)}</span>`
}

// Feature-level Semantic Coverage banner: breadth (mapped) vs depth-by-paths
// (covered), independent of whether the run passed — plus `proven`, the one axis
// that is not.
//
// Proven is what the workspace's Evaluation Report stage leads with, and this
// report used to omit it entirely: the panel said "0/6 proven" while the zip it
// handed over opened with "100% covered" and never mentioned proof. A recipient
// who only ever sees the file got the claim without the correction.
//
// It renders ONLY when the ledger's joined run is this report's run. The coverage
// engine joins the feature's LATEST recorded run, so on a suite that has run
// again since the export, `proven` describes a different run than the masthead
// names — and a percentage under the wrong run id is worse than no percentage.
export function renderCoverageOverview(coverage: CoverageLedger, runId: string): string {
  const t = coverage.totals
  const proven = coverage.provenRunId === runId && t.proven != null && coverage.provenPct != null
    ? { count: t.proven, pct: coverage.provenPct }
    : null
  return `<section class="coverage" aria-label="Semantic coverage">
    <h2 class="rule-heading">Semantic coverage<span>${proven ? 'claimed vs proven' : 'run-free'}</span></h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-value">${coverage.coveragePct}<span class="stat-unit">%</span></span><span class="stat-label">covered · every path</span></div>
      <div class="stat"><span class="stat-value">${coverage.mappedPct}<span class="stat-unit">%</span></span><span class="stat-label">mapped · has a test</span></div>
      ${proven ? `<div class="stat"><span class="stat-value">${proven.pct}<span class="stat-unit">%</span></span><span class="stat-label">proven · this run passed it</span></div>` : ''}
      <div class="stat"><span class="stat-value">${t.covered}<span class="stat-unit">/${t.total}</span></span><span class="stat-label">requirements covered</span></div>
    </div>
    <p class="muted">Coverage measures whether a test maps to each requirement's declared paths. It is independent of this run — a requirement can be fully covered by a test that never executed (${t.untested} untested, ${t.pathIncomplete} path-incomplete).</p>
    ${proven
      ? `<p class="muted"><strong>${proven.count} of ${t.total}</strong> requirements are <em>proven</em>: covered <em>and</em> confirmed by a test that passed in this run. ${coverage.coveragePct}% claimed → ${proven.pct}% proven is the distance between what this suite says it covers and what this run actually demonstrated.</p>`
      : ''}
  </section>`
}

export function renderFlowchartSection(flowchart: TestFlowchart, title: string): string {
  return `<section class="subsection flow-section">
    <h3>How the test runs</h3>
    <figure class="flow-frame" aria-label="Flow diagram for ${escapeAttr(title)}">
      ${flowchart.svg}
    </figure>
  </section>`
}

export async function renderTestCode(source: string): Promise<string> {
  const highlighted = await highlightCode(source)
  return addCodeLineMarkers(highlighted)
}

export function renderVideoSection(videoLinks: string[]): string {
  return `<section class="subsection video-section">
    <h3>Video</h3>
    ${videoLinks.map((video) => `<figure class="video-frame"><video controls preload="metadata" src="${escapeAttr(video)}"></video><figcaption><a href="${escapeAttr(video)}">${escapeHtml(video)}</a></figcaption></figure>`).join('')}
  </section>`
}

export async function renderImplementations(externalImports: string[], helpers: HelperDefinition[], id: string): Promise<string> {
  if (!externalImports.length && !helpers.length) return ''
  const source = [
    ...externalImports,
    ...helpers.map((helper) => helper.snippet),
  ].join('\n\n')
  return `<section class="implementations" id="${escapeAttr(id)}">
    <details class="drawer">
      <summary>Helper functions used</summary>
      <div class="drawer-body">${await highlightCode(source)}</div>
    </details>
  </section>`
}

export function renderAssertionHtml(assertion: TestReviewAssertion): string {
  const nested = (assertion.nested ?? [])
    .map((item) => `<li>nested ${escapeHtml(qualityLabel(item.quality))}: <code>${escapeHtml(inline(item.snippet))}</code></li>`)
    .join('')
  return `<li>
    <div><span class="quality quality-${escapeAttr(assertion.quality)}">${escapeHtml(qualityLabel(assertion.quality))}</span> ${escapeHtml(rationaleForAudience(assertion.rationale))}</div>
    <details class="check-code"><summary>show code</summary><code>${escapeHtml(inline(assertion.snippet))}</code></details>
    ${assertion.helperSnippet ? `<div class="helper-ref">helper: <code>${escapeHtml(assertion.helperName ?? '')}</code></div>` : ''}
    ${nested ? `<ul>${nested}</ul>` : ''}
  </li>`
}

// Specificity vocabulary — deliberately NOT "strong/solid/…" so it never reads as
// a rival to coverage's per-test STRENGTH. This axis is "how exact is the check".
export function qualityLabel(quality: AssertionQuality): string {
  if (quality === 'strict') return 'exact'
  if (quality === 'moderate') return 'behavioral'
  if (quality === 'shallow') return 'surface-level'
  return 'not graded'
}

export function rationaleForAudience(rationale: string): string {
  if (rationale.startsWith('Uses ')) return 'Confirms the exact expected value or behavior.'
  if (rationale === 'Static analysis could not confidently classify this assertion.') {
    return "We couldn't auto-rate how strong this check is."
  }
  return rationale
}

export async function highlightCode(source: string): Promise<string> {
  const formatted = formatCodeForDisplay(source)
  try {
    // `defaultColor: false` makes shiki emit both palettes as --shiki-light /
    // --shiki-dark custom properties instead of baking one in, so the report's
    // theme switch recolors the code with it. Offline-safe: no runtime shiki.
    return await codeToHtml(formatted, {
      lang: 'typescript',
      themes: { light: 'one-light', dark: 'one-dark-pro' },
      defaultColor: false,
    })
  } catch {
    return `<pre class="fallback-code"><code>${escapeHtml(formatted)}</code></pre>`
  }
}

export function addCodeLineMarkers(html: string): string {
  const match = html.match(/^([\s\S]*?<code[^>]*>)([\s\S]*?)(<\/code>[\s\S]*)$/)
  if (!match) return html
  const [, before, code, after] = match
  const lines = code.split('\n')
  const marked = lines.map((line, idx) => {
    const lineNo = idx + 1
    return `<span class="code-line" data-code-line="${lineNo}"><span class="line-number">${lineNo}</span><span class="line-source">${line || ' '}</span></span>`
  }).join('')
  return `${before}${marked}${after}`
}
