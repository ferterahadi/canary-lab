import { type ReactNode, useState } from 'react'
import type { CoverageLedger, GapType, TestCoverage, TestStrength } from '@/shared/api/types'
import { GAP_META, STRENGTH_META, STRENGTH_ORDER, countFor } from './CoverageCards'

// Empty main (summary ABSENT) — the rail holds the docs + Generate CTA, so the
// main area just points there. Never a dead-end (cl_ui-design-philosophy).
export function CoverageEmptyMain({ railOpen }: { railOpen: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto" style={{ scrollbarGutter: 'stable' }} data-testid="coverage-empty-main">
      <div style={{ maxWidth: 440, margin: '64px auto 0', padding: '0 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
          No coverage yet
        </div>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 8px' }}>
          A requirement coverage ledger in one exercise
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {railOpen ? '← Add source docs' : 'Open the Docs rail to add source docs'} in the rail, then <strong style={{ color: 'var(--text-primary)' }}>Generate</strong>.
          Canary extracts requirements with stable ids and maps your tests to them — summary and coverage together.
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
const RING_SIZE = 44
const RING_R = 18
const RING_STROKE = 4

export function CoverageRing({ pct }: { pct: number }) {
  const mid = RING_SIZE / 2
  const c = 2 * Math.PI * RING_R
  const clamped = Math.max(0, Math.min(100, pct))
  const offset = c * (1 - clamped / 100)
  const hue = clamped >= 80 ? 'var(--success)' : clamped >= 40 ? 'var(--warning)' : clamped > 0 ? 'var(--danger)' : 'var(--text-muted)'
  return (
    <div style={{ width: RING_SIZE, height: RING_SIZE, flexShrink: 0 }} data-testid="coverage-ring" role="img" aria-label={`${pct}% covered`}>
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
        <circle cx={mid} cy={mid} r={RING_R} fill="none" stroke="var(--border-default)" strokeWidth={RING_STROKE} />
        <circle
          cx={mid} cy={mid} r={RING_R} fill="none" stroke={hue} strokeWidth={RING_STROKE}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${mid} ${mid})`}
        />
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

// Bar/legend order reads good → gap: the green of `covered` leads, the work sinks
// right. The legend doubles as the requirement filter.
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
export function CoverageHeader({ ledger, gapFilter, onToggleGap, strengthFilter, onToggleStrength }: {
  ledger: CoverageLedger
  gapFilter: GapType | null
  onToggleGap: (g: GapType) => void
  strengthFilter: TestStrength | null
  onToggleStrength: (s: TestStrength) => void
}) {
  const { total, untested } = ledger.totals
  const covered = countFor(ledger, 'covered')
  const mapped = total - untested
  const orphans = ledger.orphanRequirementIds.length
  // The wrapper is a size container so the bar's breakpoints follow the width the
  // main column actually has (the Docs rail can take a third of the viewport).
  return (
    <div className="clcov-statwrap shrink-0">
    <div className="clcov-statbar">
      {/* Headline at rest: ring · % · "n of N covered". The breadth ratios and the proof
          roll-up sit in the same hover card the strips use; a stale-tag warning keeps an
          amber dot at rest so it is never fully hidden (status = dot + tooltip). */}
      <div className="clcov-hero clcov-strip" tabIndex={0} data-testid="coverage-hero">
        <CoverageRing pct={ledger.coveragePct} />
        <div className="clcov-hero-text">
          <div className="clcov-pct" data-testid="coverage-pct" aria-hidden="true">{Math.round(ledger.coveragePct)}%</div>
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
        </div>
        <div className="clcov-card clcov-sub" data-testid="coverage-sub" role="group" aria-label="Coverage breadth and proof">
          <span data-testid="mapped-stat" title="Requirements with at least one test mapped to them">{mapped}/{total} mapped</span>
          {ledger.enforcement && (
            <>
              <span className="clcov-sub-sep" aria-hidden="true">·</span>
              <span data-testid="proven-stat" title="Requirements whose proof — a green run over every mapped test — is newer than both their tests' and their wording's last change">
                {ledger.enforcement.provenUnchanged}/{ledger.enforcement.total}
                {ledger.enforcement.runId ? <> proven in run <code className="clcov-sub-run">{ledger.enforcement.runId}</code></> : ' proven · no run yet'}
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
        <span><strong style={{ color: GAP_META.covered.color }}>Covered</strong> — every path the requirement declares (happy/sad/edge) has a mapped test.</span>
        <span><strong style={{ color: GAP_META['path-incomplete'].color }}>Path gap</strong> — a test exists, but some declared path has none.</span>
        <span><strong style={{ color: GAP_META['variant-incomplete'].color }}>Variant gap</strong> — a test exists, but the requirement spans a dimension (e.g. channel) only partly exercised.</span>
        <span><strong style={{ color: 'var(--text-secondary)' }}>Untested</strong> — no test maps to the requirement.</span>
        <span><strong>Mapped</strong> — has ≥1 test (covered + path/variant-incomplete). Coverage is decoupled from test runs.</span>
      </span>
    </span>
  )
}
