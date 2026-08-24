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

// Hero gauge: the requirement coverage %, as a donut to the left of the breakdown bar
// (the donut is the headline number; the bar is the 3-way composition). Static SVG —
// headless preview forces reduced-motion. Hue tracks the number: green high, amber
// mid, rose low — the colour reads the health at a glance.
//
// Geometry is a clearance problem, not a taste one. The label sits on a CHORD of the
// inner circle, so the room it gets shrinks the further it is from the centre: at 82px
// across with a 6px stroke, "COVERED" (~52px at 10px caps) was wider than the ~48px
// chord it sat on and crowded the stroke. The dial is sized from that constraint —
// inner radius 38.5px puts ~66px of chord under both lines, so the widest reading
// ("100%") and the label each clear the ring by ~7px instead of touching it.
const RING_SIZE = 104
const RING_R = 42
const RING_STROKE = 7

export function CoverageRing({ pct }: { pct: number }) {
  const mid = RING_SIZE / 2
  const c = 2 * Math.PI * RING_R
  const clamped = Math.max(0, Math.min(100, pct))
  const offset = c * (1 - clamped / 100)
  const hue = clamped >= 80 ? 'var(--success)' : clamped >= 40 ? 'var(--warning)' : clamped > 0 ? 'var(--danger)' : 'var(--text-muted)'
  return (
    <div style={{ position: 'relative', width: RING_SIZE, height: RING_SIZE, flexShrink: 0 }} data-testid="coverage-ring" aria-label={`${pct}% covered`}>
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
        <circle cx={mid} cy={mid} r={RING_R} fill="none" stroke="var(--border-default)" strokeWidth={RING_STROKE} />
        <circle
          cx={mid} cy={mid} r={RING_R} fill="none" stroke={hue} strokeWidth={RING_STROKE}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${mid} ${mid})`}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
        <span style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{Math.round(pct)}<span style={{ fontSize: 12, fontWeight: 600 }}>%</span></span>
        <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 6 }}>covered</span>
      </div>
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
  return (
    <div className="clcov-statbar shrink-0">
      {/* Donut headline % to the left of the bar — balances the row and replaces the
          "Covered N%" pill (which is suppressed in the covered state, see HeadlinePill). */}
      <CoverageRing pct={ledger.coveragePct} />
      <div className="clcov-breakdown">
        {/* One proportional bar makes the nesting self-evident: covered ⊂ mapped ⊂ total. */}
        <div className="clcov-bar" data-testid="coverage-breakdown" role="img" aria-label={`${covered} covered, ${countFor(ledger, 'path-incomplete')} path-incomplete, ${countFor(ledger, 'variant-incomplete')} variant-incomplete, ${untested} untested of ${total}`}>
          {total === 0
            ? <span className="clcov-bar-seg" style={{ flexGrow: 1, background: 'var(--border-default)' }} />
            : SEG_ORDER.map((g) => {
                const count = countFor(ledger, g)
                return count === 0 ? null : <span key={g} className="clcov-bar-seg" style={{ flexGrow: count, background: GAP_META[g].color }} />
              })}
        </div>
        {/* Legend = filter. Clicking a class isolates those requirements. */}
        <div className="clcov-legend">
          {SEG_ORDER.map((g) => {
            const count = countFor(ledger, g)
            const meta = GAP_META[g]
            const on = gapFilter === g
            return (
              <button
                key={g}
                type="button"
                className="clcov-legend-item"
                data-testid={`gap-badge-${g}`}
                aria-pressed={on}
                data-on={on ? 'true' : 'false'}
                data-empty={count === 0 ? 'true' : 'false'}
                onClick={() => onToggleGap(g)}
                style={{ ['--seg' as string]: meta.color }}
              >
                <span className="clcov-legend-dot" style={{ background: meta.color }} />
                {meta.label}
                <span className="clcov-legend-n">{count}</span>
              </button>
            )
          })}
          <CoverageGlossary />
        </div>
        {/* Plain-language ratios — the two headline numbers, side by side, so the
            "32 mapped but 27 covered" gap reads itself. */}
        <div className="clcov-cap">
          {/* Two concrete ratios; the % lives once, in the state pill. The mapped %
              just restated the 32/49 ratio, so it's dropped. */}
          <span title="Requirements where every declared path has a mapped test"><strong>{covered}/{total}</strong> covered</span>
          <span className="clcov-cap-sep" aria-hidden="true">·</span>
          <span data-testid="mapped-stat" title="Requirements with at least one test mapped to them"><strong>{mapped}/{total}</strong> mapped</span>
          {orphans > 0 && (
            <span data-testid="orphan-note" className="clcov-stale" title={`These test tags point at requirements that no longer exist — re-map to clear:\n${ledger.orphanRequirementIds.join(', ')}`}>
              ⚠ {orphans} stale tag{orphans > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      {/* Test strength summary/filter — right-aligned so it sits above the tests
          column, the way the gap legend sits above the requirements column. */}
      <StrengthFilter tests={ledger.tests} value={strengthFilter} onToggle={onToggleStrength} />
    </div>
  )
}

// Per-test strength summary + filter (moved out of the Tests pane into the stat
// header). Each chip toggles the tests-pane filter; the count is the tally per tier.
export function StrengthFilter({ tests, value, onToggle }: { tests: TestCoverage[]; value: TestStrength | null; onToggle: (s: TestStrength) => void }) {
  if (tests.length === 0) return null
  return (
    <div className="clcov-chips clcov-strength" data-testid="strength-filter">
      {STRENGTH_ORDER.map((s) => {
        const count = tests.filter((t) => (t.strength ?? 'shallow') === s).length
        const meta = STRENGTH_META[s]
        const on = value === s
        return (
          <button
            key={s}
            type="button"
            className="clcov-chip"
            data-testid={`strength-badge-${s}`}
            aria-pressed={on}
            data-on={on ? 'true' : 'false'}
            data-empty={count === 0 ? 'true' : 'false'}
            title={meta.title}
            onClick={() => onToggle(s)}
            style={{ ['--chip' as string]: meta.color }}
          >
            <span className="clcov-chip-dot" style={{ background: meta.color }} />
            {meta.label}
            <strong className="clcov-chip-n">{count}</strong>
          </button>
        )
      })}
    </div>
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
