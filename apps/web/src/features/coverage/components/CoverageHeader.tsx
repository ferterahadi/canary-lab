import { type ReactNode, useState } from 'react'
import type { CoverageLedger, GapType, TestCoverage, TestStrength } from '@/shared/api/types'
import { EmptyGlyph } from '@/shared/ui/EmptyState'
import { CoverageFreshnessIndicator, coverageWarning } from '@/shared/ui/CoverageFreshnessIndicator'
import { GAP_META, STRENGTH_META, STRENGTH_ORDER, countFor } from './CoverageCards'

// Empty main (summary ABSENT). The rail owns the docs and the Generate button, so
// this pane's job is to say what the exercise IS — a paragraph floating in a
// full-screen void said only that something was missing. It reads as the app's own
// register: a left-aligned block of hairline-separated NAMED bands, the same shape
// the requirement detail uses, with the shared empty-state mark on top.
//
// Not the shared `EmptyState`: that primitive is deliberately actionless and
// height-locked so side-by-side run panes match, which is the opposite of a
// full-column takeover that has to teach a three-step flow and offer a way in.
// It still borrows that component's glyph set and mark treatment, so the two read
// as one family (cl_reuse-shared-logic).
export function CoverageEmptyMain({ railOpen, onOpenRail }: { railOpen: boolean; onOpenRail: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto" style={{ scrollbarGutter: 'stable' }} data-testid="coverage-empty-main">
      <div className="clcov-empty">
        <span aria-hidden="true" className="clcov-empty-mark">{EmptyGlyph.journal}</span>
        <h2 className="clcov-empty-h">Find out what your tests actually prove</h2>
        <p className="clcov-empty-p">
          Canary has nothing to check your tests against yet. Give it the docs that say how
          this suite is meant to behave, and it works out the rest.
        </p>
        <ol className="cl-ladder clcov-empty-steps">
          <li className="cl-ladder-step">
            <span className="cl-bead" aria-hidden="true">1</span>
            <div className="cl-ladder-body">
              <span className="clcov-empty-name">Add your docs</span>
              <p className="clcov-empty-say">
                Drop a spec, a ticket, or a page of notes into Source docs
                {railOpen ? ' on the left' : ''}. Markdown, plain text, PDF and Word all work.
              </p>
              {!railOpen && (
                <button
                  type="button"
                  data-testid="coverage-empty-open-rail"
                  onClick={onOpenRail}
                  className="cl-button clcov-empty-act"
                >
                  Open Source docs
                </button>
              )}
            </div>
          </li>
          <li className="cl-ladder-step">
            <span className="cl-bead" aria-hidden="true">2</span>
            <div className="cl-ladder-body">
              <span className="clcov-empty-name">Press Generate</span>
              <p className="clcov-empty-say">
                Canary reads them and writes down what this suite promises, one numbered
                requirement at a time. You can watch it work.
              </p>
            </div>
          </li>
          <li className="cl-ladder-step">
            <span className="cl-bead" aria-hidden="true">3</span>
            <div className="cl-ladder-body">
              <span className="clcov-empty-name">Read the results</span>
              <p className="clcov-empty-say">
                Every requirement gets a line here: which of your tests cover it, which
                behaviour nothing tests yet, and how much each test really checks.
              </p>
            </div>
          </li>
        </ol>
        <p className="cl-aside clcov-empty-foot">
          Nothing is run — this is read from the words in your docs and the tests already on disk.
        </p>
      </div>
    </div>
  )
}

// Hero gauge: a small donut whose arc is the requirement coverage %. It carries no
// text of its own — the percentage and the sentence sit beside it, where a reader
// can take them in at reading size instead of squinting into a dial. Static SVG —
// headless preview forces reduced-motion. Hue tracks the number: green high, amber
// mid, rose low — the colour reads the health at a glance.
//
// The ring is a PARTITION of every requirement, never two measurements stacked:
// the grey track is what no test covers, the dimmed arc what a test claims but no
// run has proved, and the solid arc the proof. Hue carries coverage health, opacity
// carries proof — two encodings on one shape, so a badly-covered suite still goes
// rose and a fully-written-but-never-run one reads as a full pale ring, which a
// single solid arc could not say at all. Concentric arcs were the alternative and
// lose: at 40px two 3px strokes read as decoration, and their denominators (covered
// vs total) are invisible. A second radius would also need its own health hue.
const RING_R = 18
const RING_STROKE = 4
// The box hugs the stroke, so the ring carries no invisible padding: 40px of ink used to
// sit in a 44px box, which made the bar's left gutter read 18px against the 16px on the
// right, where the strips end flush. Both edges are one 16px inset now.
const RING_SIZE = RING_R * 2 + RING_STROKE

// The claimed-but-unproven arc: the same hue at a third of its weight. Not amber —
// a suite that simply has not run yet is not in trouble, and saying so in a warning
// colour is the same false alarm `verdictView` exists to avoid. Amber stays on the
// per-requirement dot, where it can tell a stale proof from a weakened test.
const CLAIMED_OPACITY = 0.3

export function CoverageRing({ pct, provenPct }: { pct: number; provenPct?: number }) {
  const mid = RING_SIZE / 2
  const c = 2 * Math.PI * RING_R
  const clamp = (n: number) => Math.max(0, Math.min(100, n))
  const covered = clamp(pct)
  // A proof slice can never outrun the covered sweep it sits inside. Omitted ⇒ one
  // solid arc, exactly the pre-proof-axis rendering (a ledger with no enforcement).
  const proven = provenPct === undefined ? undefined : Math.min(clamp(provenPct), covered)
  const hue = covered >= 80 ? 'var(--success)' : covered >= 40 ? 'var(--warning)' : covered > 0 ? 'var(--danger)' : 'var(--text-muted)'
  // One slice, `from`→`to` as shares of the whole circle. No gap is cut between
  // slices: the arcs stay exactly proportional, and the opacity step reads as the
  // boundary on its own. The round caps do overlap there, so the caller draws the
  // dimmed slice first and the solid one covers its cap.
  const slice = (from: number, to: number, opacity: number) => (
    <circle
      cx={mid} cy={mid} r={RING_R} fill="none" stroke={hue} strokeOpacity={opacity}
      strokeWidth={RING_STROKE} strokeLinecap="round"
      strokeDasharray={c} strokeDashoffset={c * (1 - (to - from) / 100)}
      transform={`rotate(${Math.round((-90 + (from * 360) / 100) * 1000) / 1000} ${mid} ${mid})`}
    />
  )
  const label = proven === undefined ? `${pct}% covered` : `${pct}% covered, ${Math.round(proven * 10) / 10}% proven`
  return (
    <div style={{ width: RING_SIZE, height: RING_SIZE, flexShrink: 0 }} data-testid="coverage-ring" role="img" aria-label={label}>
      {/* `overflow:visible` because the stroke now ends exactly on the viewBox edge — the
          default clip would shave its outermost antialiased row on all four sides. */}
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} style={{ overflow: 'visible' }} aria-hidden="true">
        <circle cx={mid} cy={mid} r={RING_R} fill="none" stroke="var(--border-default)" strokeWidth={RING_STROKE} />
        {proven === undefined ? slice(0, covered, 1) : (
          <>
            {covered - proven > 0 && slice(proven, covered, CLAIMED_OPACITY)}
            {proven > 0 && slice(0, proven, 1)}
          </>
        )}
      </svg>
    </div>
  )
}

// One-line headline pill (Generating / Setup needed / Stale / No coverage / Covered N%).
// A coloured dot carries the state; the dot pulses while generating.
export function HeadlinePill({ headline }: { headline: string }) {
  // The coverage ring now carries the "Covered N%" headline, so the pill would just
  // repeat it — suppress it in that state. Non-covered states (Stale / Generating /
  // Setup needed / No coverage) still need the badge as the only signal of that state.
  if (headline.startsWith('Covered')) return null
  const generating = headline === 'Generating'
  const tone = headline.startsWith('Covered')
    ? 'var(--success)'
    : generating
      ? 'var(--running)'
      : headline === 'Stale'
        ? 'var(--warning)'
        : 'var(--text-muted)'
  return (
    <span
      data-testid="coverage-state-headline"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 11.5, fontWeight: 600, color: tone,
        border: `1px solid color-mix(in srgb, ${tone} 55%, transparent)`,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
        borderRadius: 999, padding: '3px 10px',
      }}
    >
      <span
        className={generating ? 'cl-pulse' : undefined}
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: tone, boxShadow: generating ? `0 0 8px ${tone}` : 'none' }}
      />
      {headline}
    </span>
  )
}

// Persisted Docs-rail open/closed state (R12/R22) — reopening/refresh keeps it.
export const RAIL_PREF_KEY = 'cl.coverage.rail'

export function readRailPref(): boolean {
  try { return localStorage.getItem(RAIL_PREF_KEY) !== 'closed' } catch { return true }
}

export function writeRailPref(open: boolean): void {
  try { localStorage.setItem(RAIL_PREF_KEY, open ? 'open' : 'closed') } catch { /* ignore */ }
}

// Bar/legend order reads good → gap: the sky of `covered` leads, the work sinks
// right, and the two gap kinds sit hottest-first (path gap, then variant gap). The
// legend doubles as the requirement filter.
export const SEG_ORDER: GapType[] = ['covered', 'path-incomplete', 'variant-incomplete', 'untested']

// Legend items read number-first in plain words ("2 path gaps"), so the count and
// its meaning are one phrase rather than a label with a badge hung on it.
const GAP_WORDS: Record<GapType, [one: string, many: string]> = {
  covered: ['covered', 'covered'],
  'path-incomplete': ['path gap', 'path gaps'],
  'variant-incomplete': ['variant gap', 'variant gaps'],
  untested: ['untested', 'untested'],
}

export function gapWord(g: GapType, n: number): string {
  return GAP_WORDS[g][n === 1 ? 0 : 1]
}

// The stat bar reads as a sentence, then two strips. Headline block: the small ring,
// the percentage at reading size, and "n of N covered" — the breadth ratios and the
// proof roll-up wait in its hover card, like the strips' figures do. Strips: Requirements and Test depth, each resting as ONE eyebrow line (name ·
// total) over its stacked bar — that is all the resting bar shows, which is what keeps
// it ~90px tall. The detail is one hover away: resting on (or focusing) a strip drops a
// card with the number-first figures, and the figures are the filters (see Strip). The strips
// sit beside the headline at every usable width — a narrow bar tightens the headline instead
// of moving it — and only drop under it when the bar is genuinely cramped.
export function CoverageHeader({ ledger, gapFilter, onToggleGap, strengthFilter, onToggleStrength, confirmed = true }: {
  ledger: CoverageLedger
  confirmed?: boolean
  gapFilter: GapType | null
  onToggleGap: (g: GapType) => void
  strengthFilter: TestStrength | null
  onToggleStrength: (s: TestStrength) => void
}) {
  const { total, untested } = ledger.totals
  const covered = countFor(ledger, 'covered')
  const mapped = total - untested
  const orphans = ledger.orphanRequirementIds.length
  const current = confirmed && ledger.freshness?.state === 'current'
  const warning = coverageWarning(ledger.freshness, confirmed)
  const latestFailed = ledger.tests.filter((test) => test.lastRun?.passed === false).length
  const latestPassed = ledger.tests.filter((test) => test.lastRun?.passed === true).length
  // The ring and both text readouts share one CURRENT proof view. Enforcement can
  // still carry proof from an earlier run while a newer run has no results yet;
  // showing that historical count beside "no run yet" was the source of three
  // contradictory labels for the same state.
  const enf = total > 0 ? ledger.enforcement : undefined
  const proofRunId = ledger.provenRunId ?? enf?.runId
  const proofNeedsRun = ledger.freshness?.proofNeedsRun === true
  const hasCurrentProof = Boolean(proofRunId) && !proofNeedsRun
  const proven = enf === undefined ? undefined : hasCurrentProof ? enf.provenUnchanged : 0
  const claimedOnly = proven === undefined ? 0 : covered - proven
  const latestRunId = ledger.freshness?.latestRunId
  const latestRunStatus = ledger.freshness?.latestRunStatus
  const runInProgress = latestRunStatus === 'queued' || latestRunStatus === 'running' || latestRunStatus === 'healing'
  const pendingProofCopy = runInProgress
    ? 'run in progress — nothing proven yet'
    : proofNeedsRun && proofRunId
      ? 'current tests need verification — nothing proven'
      : latestRunId
        ? `latest run ${latestRunStatus ?? 'has no readable results'} — nothing proven`
        : 'no run yet — nothing proven'
  const proofCardSuffix = hasCurrentProof && proofRunId
    ? <> proven in run <code className="clcov-sub-run">{proofRunId}</code></>
    : runInProgress
      ? ' proven · run in progress'
      : proofNeedsRun && proofRunId
        ? ' proven · current tests need verification'
        : latestRunId
          ? ` proven · latest run ${latestRunStatus ?? 'has no readable results'}`
          : ' proven · no run yet'
  // The wrapper is a size container so the bar's breakpoints follow the width the
  // main column actually has (the Docs rail can take a third of the viewport).
  return (
    <div className="clcov-statwrap shrink-0">
    <div className="clcov-statbar">
      {/* Headline at rest: ring · % · "n of N covered". The breadth ratios and the proof
          roll-up sit in the same hover card the strips use; a stale-tag warning keeps an
          amber dot at rest so it is never fully hidden (status = dot + tooltip). */}
      <div className="clcov-hero clcov-strip" tabIndex={0} data-testid="coverage-hero">
        <CoverageRing pct={ledger.coveragePct} provenPct={proven === undefined ? undefined : (proven / total) * 100} />
        <div className="clcov-hero-text">
          <div className="flex items-center gap-2">
            <div className="clcov-pct" data-testid="coverage-pct">{Math.round(ledger.coveragePct)}%</div>
            <CoverageFreshnessIndicator message={warning ? [warning,
              ledger.provenRunId ? `Last run: ${latestPassed} passed · ${latestFailed} failed · ${ledger.tests.length - latestPassed - latestFailed} not run.` : undefined,
            ].filter(Boolean).join(' ') : undefined} />
          </div>
          <div className="clcov-sentence" data-testid="coverage-sentence">
            {covered} of {total} covered
            {orphans > 0 && (
              <span
                className="clcov-alert clcov-hero-alert"
                data-testid="orphan-dot"
                role="img"
                aria-label={`${orphans} stale tag${orphans > 1 ? 's' : ''}`}
                title={`${orphans} stale tag${orphans > 1 ? 's' : ''} — test tags that point at requirements that no longer exist`}
                style={{ background: 'var(--warning)' }}
              />
            )}
          </div>
          {/* The proof readout at rest. It names the ring's two coloured slices in
              words, so the reader never has to decode an arc — and "claimed only" is
              opaque enough to earn a gloss. The run id and the day stay in the hover
              card below: takeaway at rest, provenance one hover away. */}
          {proven !== undefined && (
            <div
              className="clcov-proof"
              data-testid="coverage-proof"
              title={hasCurrentProof
                ? 'Proven — a run passed every test mapped to the requirement, and neither the tests nor the wording have changed since. Unproven — a test covers it, but nothing has proved it yet.'
                : runInProgress
                  ? 'The latest run is still in progress. Its results do not count as proof until the run reports them.'
                  : proofNeedsRun
                    ? 'The current tests need verification, so earlier results do not count as proof of the current inputs.'
                    : 'No run has been recorded for this suite, so nothing is proven yet — every covered requirement is a claim.'}
            >
              {latestFailed ? `${latestFailed} failed in latest run` : !hasCurrentProof
                ? pendingProofCopy
                : claimedOnly > 0
                  ? `${proven} proven · ${claimedOnly} unproven`
                  : `${proven} proven`}
            </div>
          )}
          {current && ledger.provenRunId && <div className="clcov-proof sr-only" data-testid="coverage-latest-run">
            Latest run {ledger.provenRunId}: {latestPassed} passed · {latestFailed} failed · {ledger.tests.length - latestPassed - latestFailed} not run
          </div>}
        </div>
        <div className="clcov-card clcov-sub" data-testid="coverage-sub" role="group" aria-label="Coverage breadth and proof">
          <span data-testid="mapped-stat" title="Requirements with at least one test mapped to them">{mapped}/{total} mapped</span>
          {ledger.enforcement && (
            <>
              <span className="clcov-sub-sep" aria-hidden="true">·</span>
              <span data-testid="proven-stat" title="Requirements whose proof — a green run over every mapped test — is newer than both their tests' and their wording's last change">
                {proven}/{ledger.enforcement.total}
                {proofCardSuffix}
              </span>
            </>
          )}
          {orphans > 0 && (
            <>
              <span className="clcov-sub-sep" aria-hidden="true">·</span>
              <span data-testid="orphan-note" className="clcov-stale" title={`These test tags point at requirements that no longer exist — re-map to clear:\n${ledger.orphanRequirementIds.join(', ')}`}>
                {orphans} stale tag{orphans > 1 ? 's' : ''}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="clcov-groups">
        <Strip
          testId="requirements-group"
          labelTestId="requirements-group-label"
          barTestId="coverage-breakdown"
          name="Requirements"
          total={total}
          barLabel={`${covered} covered, ${countFor(ledger, 'path-incomplete')} path-incomplete, ${countFor(ledger, 'variant-incomplete')} variant-incomplete, ${untested} untested of ${total}`}
          cardLabel="Requirement classes — click one to filter the requirements"
          items={SEG_ORDER.map((g) => {
            const count = countFor(ledger, g)
            return { key: g, count, word: gapWord(g, count), color: GAP_META[g].color, title: GAP_META[g].label, testId: `gap-badge-${g}` }
          })}
          active={gapFilter}
          onToggle={(k) => onToggleGap(k as GapType)}
          cardExtra={<CoverageGlossary />}
        />
        <StrengthFilter tests={ledger.tests} orphanTests={ledger.totals.orphanTests} value={strengthFilter} onToggle={onToggleStrength} />
      </div>
    </div>
    </div>
  )
}

// One strip = eyebrow · bar · hover card. The resting state is the eyebrow line and the
// bar; while a filter is on, the eyebrow also names it (dot · count · word) so the
// resting state never hides an active filter. The card is an overlay — it never pushes
// the ledgers down — and opens on hover or focus-within (the strip is focusable, so a
// keyboard user opens it without filtering). Hovering a bar segment lights its figure
// and dims the rest, hovering a figure does the same to the bar: the ledger's own
// two-way affordance, so the shapes and the words are visibly one thing.
export type StripItem = { key: string; count: number; word: string; color: string; title: string; testId: string }

export function Strip({ testId, labelTestId, barTestId, name, total, barLabel, cardLabel, items, active, onToggle, cardExtra }: {
  testId: string
  labelTestId: string
  barTestId: string
  name: string
  total: ReactNode
  barLabel: string
  cardLabel: string
  items: StripItem[]
  active: string | null
  onToggle: (key: string) => void
  cardExtra?: ReactNode
}) {
  const [lit, setLit] = useState<string | null>(null)
  const sum = items.reduce((n, it) => n + it.count, 0)
  const activeItem = active ? items.find((it) => it.key === active) : undefined
  const dim = (key: string) => (lit !== null && lit !== key ? 'true' : 'false')
  return (
    <div className="clcov-strip" data-testid={testId} tabIndex={0} onMouseLeave={() => setLit(null)}>
      <div className="clcov-grp-label" data-testid={labelTestId}>
        <span className="clcov-grp-name">{name}</span>
        {activeItem && (
          <span className="clcov-strip-on" data-testid={`${testId}-active`} title="Filter on — open the strip to change it">
            <span className="clcov-legend-dot" style={{ background: activeItem.color }} />
            {activeItem.count} {activeItem.word}
          </span>
        )}
        <i>{total}</i>
      </div>
      {/* One proportional bar; each segment is a click target for its class. */}
      <div className="clcov-bar" data-testid={barTestId} role="group" aria-label={barLabel}>
        {sum === 0
          ? <span className="clcov-bar-seg" style={{ flexGrow: 1, background: 'var(--border-default)' }} />
          : items.map((it) => it.count === 0 ? null : (
              <button
                key={it.key}
                type="button"
                className="clcov-bar-seg"
                data-seg={it.key}
                data-dim={dim(it.key)}
                aria-label={`${it.count} ${it.word}`}
                aria-pressed={active === it.key}
                title={`${it.count} ${it.word}`}
                style={{ flexGrow: it.count, background: it.color }}
                onMouseEnter={() => setLit(it.key)}
                onFocus={() => setLit(it.key)}
                onClick={() => onToggle(it.key)}
              />
            ))}
      </div>
      <div className="clcov-card" role="group" aria-label={cardLabel}>
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className="clcov-fig"
            data-testid={it.testId}
            aria-pressed={active === it.key}
            data-on={active === it.key ? 'true' : 'false'}
            data-empty={it.count === 0 ? 'true' : 'false'}
            data-dim={dim(it.key)}
            title={it.title}
            onMouseEnter={() => setLit(it.key)}
            onFocus={() => setLit(it.key)}
            onClick={() => onToggle(it.key)}
          >
            <span className="clcov-fig-n">{it.count}</span>{' '}
            <span className="clcov-fig-w"><span className="clcov-legend-dot" style={{ background: it.color }} />{it.word}</span>
          </button>
        ))}
        {cardExtra}
      </div>
    </div>
  )
}

// Per-test depth strip: the same Strip as Requirements — eyebrow with its count, the
// stacked bar in strength order, figures that filter the tests pane. Orphan tests (no
// requirement tag) are named in the eyebrow because they are the one count here that is
// not a depth.
export function StrengthFilter({ tests, orphanTests, value, onToggle }: {
  tests: TestCoverage[]
  orphanTests: number
  value: TestStrength | null
  onToggle: (s: TestStrength) => void
}) {
  if (tests.length === 0) return null
  const counts = STRENGTH_ORDER.map((s) => [s, tests.filter((t) => (t.strength ?? 'shallow') === s).length] as const)
  return (
    <Strip
      testId="strength-filter"
      labelTestId="strength-group-label"
      barTestId="strength-breakdown"
      name="Test depth"
      total={(
        <>
          {tests.length} test{tests.length === 1 ? '' : 's'}
          {orphanTests > 0 && (
            <>
              {' · '}
              <span data-testid="orphan-tests-stat" className="clcov-orphan" title="Tests with no requirement tag — regenerate coverage to map them">{orphanTests} orphan</span>
            </>
          )}
        </>
      )}
      barLabel={`${counts.map(([s, n]) => `${n} ${s}`).join(', ')} of ${tests.length}`}
      cardLabel="Test depth tiers — click one to filter the tests"
      items={counts.map(([s, count]) => ({ key: s, count, word: STRENGTH_META[s].label.toLowerCase(), color: STRENGTH_META[s].color, title: STRENGTH_META[s].title, testId: `strength-badge-${s}` }))}
      active={value}
      onToggle={(k) => onToggle(k as TestStrength)}
    />
  )
}

// One-hover glossary so the vocabulary never needs to be asked about.
export function CoverageGlossary() {
  return (
    <span className="clcov-info" tabIndex={0} role="note" aria-label="What these terms mean">
      <span aria-hidden="true" className="clcov-info-i">i</span>
      <span className="clcov-info-pop" role="tooltip">
        <span><strong style={{ color: GAP_META.covered.color }}>Covered</strong> — a test covers every expected outcome.</span>
        <span><strong style={{ color: GAP_META['path-incomplete'].color }}>Path gap</strong> — tests exist, but an expected outcome has no test.</span>
        <span><strong style={{ color: GAP_META['variant-incomplete'].color }}>Variant gap</strong> — tests cover only some versions, such as one channel.</span>
        <span><strong style={{ color: 'var(--text-secondary)' }}>Untested</strong> — no test is linked to this requirement.</span>
        <span><strong>Mapped</strong> — at least one test is linked to this requirement. This shows coverage, not whether tests passed.</span>
      </span>
    </span>
  )
}
