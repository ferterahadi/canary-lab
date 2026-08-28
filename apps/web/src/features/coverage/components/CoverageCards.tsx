import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react'
import type { CoverageLedger, CoverageStatus, ExtractedTest, GapType, RequirementCoverage, TestCoverage, TestStrength } from '@/shared/api/types'
import { TestPresentation } from '@/shared/ui/TestPresentation'
import { TestIdBadge } from '@/shared/ui/TestIdBadge'
import { stripLeadingTestOrdinal } from '@/shared/test-numbering'

// Each gap class gets a stable label + colour. Coverage is semantic (run-free):
// `untested` (no test maps to it) is the gap; `path-incomplete` (some declared
// paths unclaimed) is partial; `covered` (every path claimed) is the good state.
// `abbr` is the single-letter form the card status chips collapse to when the card
// is too narrow for the full label (container query); the colour dot + a hover title
// keep it decipherable.
export const GAP_META: Record<GapType, { label: string; abbr: string; color: string }> = {
  covered: { label: 'Covered', abbr: 'C', color: 'var(--success)' },
  // Short labels keep the legend + card status from crushing the layout at narrow
  // widths; the glossary `i` still spells out the full meaning.
  'path-incomplete': { label: 'Path gap', abbr: 'P', color: 'var(--accent)' },
  // A requirement that spans a variant dimension (channel/tenant/…) but is only
  // tested on some values. Amber = the breadth warning: it claims more than it proves.
  'variant-incomplete': { label: 'Variant gap', abbr: 'V', color: 'var(--warning)' },
  untested: { label: 'Untested', abbr: 'U', color: 'var(--text-muted)' },
}

// Per-test coverage strength — graded off the strongest stack layer a test's
// assertions touch (tier classifier), independent of runs. A four-step ramp on
// the system hues: rose weakest → amber → blue → green strong.
//
// The titles are the ONE definition of the four words, shared with the flight
// band's Test depth tooltip (STRENGTH_TIER_HELP below) — plain outcomes, not
// the internal Tier 1-4 numbering, which appeared nowhere else in the product.
export const STRENGTH_TIER_HELP: Record<TestStrength, string> = {
  strong: 'a real browser or an outside system confirmed the effect',
  solid: "the app's own API or a check on its UI said it worked",
  basic: 'internal state changed — a database row or fixture',
  shallow: "only the app's own log says so (or nothing gradeable was found)",
}

export const STRENGTH_META: Record<TestStrength, { label: string; color: string; title: string }> = {
  strong: { label: 'Strong', color: 'var(--success)', title: `Strong — ${STRENGTH_TIER_HELP.strong}` },
  solid: { label: 'Solid', color: 'var(--accent)', title: `Solid — ${STRENGTH_TIER_HELP.solid}` },
  basic: { label: 'Basic', color: 'var(--warning)', title: `Basic — ${STRENGTH_TIER_HELP.basic}` },
  shallow: { label: 'Shallow', color: 'var(--danger)', title: `Shallow — ${STRENGTH_TIER_HELP.shallow}` },
}

// Worst-first: the weakest tests sort to the front of the filter.
export const STRENGTH_ORDER: TestStrength[] = ['shallow', 'basic', 'solid', 'strong']

// Plain-language gloss for the `@path-*` tags on a test card (tooltip only — the
// tag itself stays terse). These mirror a requirement's declared happy/sad/edge.
export const PATH_DESC: Record<string, string> = { happy: 'happy', sad: 'failure', edge: 'edge-case' }

// Requirements list is ordered worst-first (uncovered → partial → covered) so the
// gaps that need work sit at the top — the whole point of the ledger.
export const STATUS_RANK: Record<CoverageStatus, number> = { uncovered: 0, partial: 1, covered: 2 }

// Golden-angle hue rotation gives each test a distinct, stable colour regardless
// of how many there are. Mid lightness reads on both light and dark themes.
export function testColor(index: number): string {
  return `hsl(${Math.round((index * 137.508) % 360)}, 65%, 55%)`
}

export interface Hovered {
  kind: 'test' | 'req'
  key: string
}

// A path prose value is effectively "absent" when the summary couldn't state one —
// the agent often returns "N/A — …" rather than omitting the field. Treat those as no
// path so the block hides instead of rendering a hollow "N/A".
export function meaningfulPath(s?: string): string | null {
  const t = s?.trim()
  if (!t) return null
  if (/^(n\/?a|none|not applicable)\b/i.test(t)) return null
  return t
}

export function statusOf(rc: RequirementCoverage): CoverageStatus {
  if (rc.coverageStatus) return rc.coverageStatus
  if (rc.gapType === 'covered') return 'covered'
  if (rc.gapType === 'untested') return 'uncovered'
  return 'partial'
}

export function countFor(ledger: CoverageLedger, g: GapType): number {
  switch (g) {
    case 'untested': return ledger.totals.untested
    case 'path-incomplete': return ledger.totals.pathIncomplete
    case 'variant-incomplete': return ledger.totals.variantIncomplete
    case 'covered': return ledger.totals.covered
  }
}

export function RequirementCard({ rc, colors, active, focused, dimmed, onHover }: {
  rc: RequirementCoverage
  colors: string[]
  active: boolean
  focused: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
}) {
  const meta = GAP_META[rc.gapType]
  // The which-paths / which-variants detail is no longer crammed into the gap pill —
  // the path chips (1-axis) or the path×variant matrix below name the exact gaps,
  // so the status reads as just a dot + short label and never crushes the title.
  const hasVariants = Boolean(rc.variantCoverage && rc.variantCoverage.length > 0)
  const { kind, happyPath, unhappyPath } = rc.requirement
  const happyText = meaningfulPath(happyPath)
  const unhappyText = meaningfulPath(unhappyPath)
  // Only offer expansion when the summary carried meaningful path prose. `kind` is now
  // shown in the always-visible header, so it no longer makes a card disclosable alone.
  const hasDetail = Boolean(happyText || unhappyText)
  const [expanded, setExpanded] = useState(false)
  const toggle = () => { if (hasDetail) setExpanded((c) => !c) }
  return (
    <div
      className="clcov-card"
      data-testid={`req-${rc.requirement.id}`}
      data-active={active ? 'true' : 'false'}
      data-focus={focused ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        position: 'relative',
        marginBottom: 8,
        padding: '11px 13px 11px 15px',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--bg-selected)' : 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderLeft: `3px solid ${colors[0] ?? 'var(--border-default)'}`,
        opacity: dimmed ? 0.4 : 1,
        transition: 'opacity 120ms, background 120ms, border-color 140ms, box-shadow 140ms',
      }}
    >
      {/* Header is ONE inline-flow line: caret · id · title · kind · gap status all
          flow and wrap together as a single run, so the tags read as part of the
          title and tuck after its last word instead of reserving a column or
          block-stacking below it. */}
      <div
        className={hasDetail ? 'clcov-disclose clcov-reqhead' : 'clcov-reqhead'}
        style={{ marginBottom: 5 }}
        {...(hasDetail
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-expanded': expanded,
              'data-testid': `req-toggle-${rc.requirement.id}`,
              onClick: toggle,
              onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
            }
          : {})}
      >
        {hasDetail && <span aria-hidden="true" className="clcov-caret">{expanded ? '▾' : '▸'}</span>}
        <span className="clcov-reqid">{rc.requirement.id}</span>
        <strong className="clcov-req-title">{rc.requirement.title}</strong>
        {rc.requirement.deprecated && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> (deprecated)</span>}
        {kind && (
          <span className="clcov-kind-tag" data-testid={`kind-${rc.requirement.id}`} title={kind === 'non-functional' ? 'Non-functional' : 'Functional'}>
            <span className="clcov-cq-full">{kind === 'non-functional' ? 'Non-functional' : 'Functional'}</span>
            <span className="clcov-cq-abbr" aria-hidden="true">{kind === 'non-functional' ? 'N' : 'F'}</span>
          </span>
        )}
        <span className="clcov-gap" data-testid={`gap-${rc.requirement.id}`} title={meta.label} style={{ color: meta.color }}>
          <span className="clcov-gap-dot" style={{ background: meta.color }} />
          <span className="clcov-cq-full">{meta.label}</span>
          <span className="clcov-cq-abbr" aria-hidden="true">{meta.abbr}</span>
        </span>
      </div>
      <div className="clcov-req-text">{rc.requirement.text}</div>
      {hasVariants ? (
        // Variant requirement: the path×variant matrix (or a single inline row when
        // there's one path) is the source of truth — the 1-axis path chips would
        // only duplicate it, so they're dropped here.
        <VariantCoverage rc={rc} />
      ) : (
        <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 7 }}>
          {rc.pathCoverage.map((p) => (
            p.covered ? (
              <span key={p.path} data-testid={`path-${rc.requirement.id}-${p.path}`} title={`${p.path} path has a mapped test`} className="clcov-vchip clcov-vchip-on">
                {p.path} ✓
              </span>
            ) : (
              // No test for this path — the dashed/muted treatment carries that.
              <span key={p.path} data-testid={`path-${rc.requirement.id}-${p.path}`} title={`No test maps to the ${p.path} path`} className="clcov-vchip">
                {p.path}
              </span>
            )
          ))}
        </div>
      )}
      {hasDetail && expanded && (
        <div className="clcov-reqdetail" data-testid={`req-detail-${rc.requirement.id}`}>
          {happyText && (
            <div className="clcov-path-block">
              <span className="clcov-path-label clcov-path-happy">Happy path</span>
              <p className="clcov-path-text">{happyText}</p>
            </div>
          )}
          {unhappyText && (
            <div className="clcov-path-block">
              <span className="clcov-path-label clcov-path-unhappy">Unhappy path</span>
              <p className="clcov-path-text">{unhappyText}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Variant coverage for a variant-bearing requirement, as an accordion: a compact row
// of clickable path pills (`happy 1/4` = covered/total variants, count coloured by
// state), and — for the one pill you click — its per-variant chips below. Only one
// path's variants show at a time, so a requirement spanning many paths/variants stays
// scannable: you read the gap per path on demand instead of all cells at once.
export function VariantCoverage({ rc }: { rc: RequirementCoverage }) {
  const cells = rc.variantCoverage ?? []
  const paths = [...new Set(cells.map((c) => c.path))]
  const variants = [...new Set(cells.map((c) => c.variant))]
  const covered = (path: string, variant: string) =>
    cells.find((c) => c.path === path && c.variant === variant)?.covered ?? false
  // A variant is Not-Applicable when it has no testable surface (ledger marked
  // every cell applicable:false). N/A is excluded from the counts/gaps and shown
  // with its reason — an impossible cell is N/A, never a phantom gap.
  const isNA = (variant: string) =>
    cells.some((c) => c.variant === variant && c.applicable === false)
  const naReason = (variant: string) =>
    cells.find((c) => c.variant === variant && c.applicable === false)?.reason ?? 'not applicable'
  const applicable = (variant: string) => !isNA(variant)
  // Worst-first: most-uncovered applicable variant leads; N/A sinks to the bottom.
  const vGaps = (v: string) => (isNA(v) ? -1 : paths.filter((p) => !covered(p, v)).length)
  const variantOrder = [...variants].sort((a, b) => vGaps(b) - vGaps(a))
  const pGaps = (p: string) => variants.filter((v) => applicable(v) && !covered(p, v)).length
  const pathOrder = [...paths].sort((a, b) => pGaps(b) - pGaps(a))
  const naCount = variants.filter(isNA).length
  const applicableCount = variants.length - naCount
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div data-testid={`variant-grid-${rc.requirement.id}`} className="clcov-vgrid">
      <div className="clcov-vpaths">
        {pathOrder.map((path) => {
          // Counts are over APPLICABLE variants only; N/A never adds to the denominator.
          const missing = variantOrder.filter((v) => applicable(v) && !covered(path, v))
          const coveredCount = applicableCount - missing.length
          const complete = missing.length === 0
          const active = open === path
          const naNote = naCount ? `, ${naCount} N/A` : ''
          return (
            <button
              key={path}
              type="button"
              data-testid={`variant-path-${rc.requirement.id}-${path}`}
              className="clcov-vpath"
              data-on={active ? 'true' : 'false'}
              aria-expanded={active}
              title={complete ? `${path}: all ${applicableCount} applicable variants covered${naNote}` : `${path}: missing ${missing.join(', ')}${naNote}`}
              onClick={(e) => { e.stopPropagation(); setOpen(active ? null : path) }}
            >
              <span aria-hidden="true" className="clcov-vpath-caret">{active ? '▾' : '▸'}</span>
              <span className="clcov-vpath-name">{path}</span>
              <span className="clcov-vpath-n" style={{ color: complete ? 'var(--success)' : GAP_META['variant-incomplete'].color }}>{coveredCount}/{applicableCount}</span>
            </button>
          )
        })}
      </div>
      {open && (() => {
        // The tray is a contained panel headed by its path, so the chips read as the
        // detail of the pill you clicked — not as belonging to whatever pill happens
        // to sit above-left of them in the wrapped row.
        const openCovered = variantOrder.filter((v) => applicable(v) && covered(open, v)).length
        return (
          <div className="clcov-vtray" data-testid={`variant-cells-${rc.requirement.id}-${open}`}>
            <div className="clcov-vtray-head">
              <span className="clcov-vtray-path">{open}</span> · {openCovered}/{applicableCount} variants covered{naCount ? ` · ${naCount} N/A` : ''}
            </div>
            <div className="clcov-vtray-chips">
              {variantOrder.map((v) => {
                if (isNA(v)) {
                  return (
                    <span
                      key={v}
                      data-testid={`cell-${rc.requirement.id}-${open}-${v}`}
                      data-covered="na"
                      title={`${v}: N/A — ${naReason(v)}`}
                      className="clcov-vchip clcov-vchip-na"
                    >
                      {v} n/a
                    </span>
                  )
                }
                const on = covered(open, v)
                return (
                  <span
                    key={v}
                    data-testid={`cell-${rc.requirement.id}-${open}-${v}`}
                    data-covered={on ? 'true' : 'false'}
                    title={on ? `${open} · ${v} has a mapped test` : `No test maps to ${open} · ${v}`}
                    className={on ? 'clcov-vchip clcov-vchip-on' : 'clcov-vchip'}
                  >
                    {v}{on ? ' ✓' : ''}
                  </span>
                )
              })}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// The test's strength chip + `@req-*` / `@path-*` tags carry the meaning — no
// decorative accent border, and no run-coupled "verified" dot (coverage is semantic).
// Click the header to disclose the actual test source (lazily fetched by the parent).
export function TestCard({ test, testNumber, color, active, dimmed, onHover, onExpand, source, sourceLoading, sourceError, onReqClick }: {
  test: TestCoverage
  testNumber?: number
  color: string
  active: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
  onExpand: () => void
  source: { test: ExtractedTest; absFile: string } | null
  sourceLoading: boolean
  sourceError: string | null
  onReqClick: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const toggle = () => {
    setExpanded((cur) => {
      if (!cur) onExpand() // trigger the lazy source fetch on first open
      return !cur
    })
  }
  return (
    <div
      className="clcov-card"
      data-testid={`test-${test.name}`}
      data-active={active ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        marginBottom: 8,
        padding: '11px 13px',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--bg-selected)' : 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        boxShadow: active ? `inset 3px 0 0 ${color}` : 'none',
        opacity: dimmed ? 0.4 : 1,
        transition: 'opacity 120ms, background 120ms, box-shadow 120ms, border-color 140ms',
      }}
    >
      {/* One inline-flow header (same as the requirement card): caret · #N · name
          flow and wrap together instead of the badge sitting in its own flex cell. */}
      <div
        className="clcov-disclose clcov-reqhead"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid={`test-toggle-${test.name}`}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
      >
        <span aria-hidden="true" className="clcov-caret">{expanded ? '▾' : '▸'}</span>
        <span className="clcov-testid"><TestIdBadge n={testNumber} /></span>
        {/* Name is the identity; the expanded shared presentation owns the
            file:line locator and Code mode's editor action. */}
        <strong className="clcov-req-title">{stripLeadingTestOrdinal(test.name)}</strong>
      </div>
      {/* One compact meta row: strength (what the test IS) + the requirement links it
          COVERS + the @path tags. Click a @req chip to jump to that requirement. */}
      <div className="flex flex-wrap items-center gap-1.5" style={{ marginTop: 7 }}>
        {test.strength && (
          <span
            data-testid={`strength-${test.name}`}
            title={STRENGTH_META[test.strength].title}
            className="flex items-center gap-1"
            style={{ fontSize: 10, fontWeight: 600, color: STRENGTH_META[test.strength].color, background: `color-mix(in srgb, ${STRENGTH_META[test.strength].color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${STRENGTH_META[test.strength].color} 45%, transparent)`, borderRadius: 999, padding: '1px 8px' }}
          >
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: STRENGTH_META[test.strength].color }} />
            {STRENGTH_META[test.strength].label}
          </span>
        )}
        {test.requirements.length === 0 ? (
          <span data-testid={`orphan-${test.name}`} style={{ fontSize: 10, fontWeight: 600, color: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', borderRadius: 999, padding: '1px 8px' }}>orphan — no covers tag</span>
        ) : (
          test.requirements.map((id) => (
            <button
              key={id}
              type="button"
              className="clcov-reqtag"
              data-testid={`reqtag-${test.name}-${id}`}
              title={`Jump to requirement ${id}`}
              onClick={(e) => { e.stopPropagation(); onReqClick(id) }}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '1px 6px', borderRadius: 5, background: `color-mix(in srgb, ${color} 11%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 30%, var(--border-default))`, color: 'var(--text-primary)' }}
            >@req-{id}</button>
          ))
        )}
        {test.pathTypes.map((p) => (
          <span key={p} title={`Exercises the ${PATH_DESC[p] ?? p} path`} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '1px 6px', borderRadius: 5, border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>@path-{p}</span>
        ))}
      </div>
      {expanded && (
        <div className="clcov-source" data-testid={`test-source-${test.name}`}>
          {source ? (
            <TestPresentation
              test={source.test}
              sourceFile={source.absFile}
            />
          ) : sourceLoading ? (
            <div className="clcov-source-note">Loading source…</div>
          ) : sourceError ? (
            <div className="clcov-source-note">Couldn’t load source: {sourceError}</div>
          ) : (
            <div className="clcov-source-note">Source not found for this test.</div>
          )}
        </div>
      )}
    </div>
  )
}

// Placeholder card shown in the Tests pane while a coverage job runs. Same shell as
// TestCard (so it resolves into the real card in place), but every meaningful bit —
// dot, id badge, name, file, mapping chips — is a skeleton: the pane is honestly
// loading, not half-revealing the test set against the middle pane's "Mapping…".
// Widths vary per index so the column reads as a list of real cards, not a grid.
export const SKEL_NAME_W = [172, 132, 198, 150, 116, 184, 142, 164]

export function TestCardSkeleton({ index }: { index: number }) {
  return (
    <div
      className="clcov-card"
      data-testid="test-skeleton"
      aria-hidden="true"
      style={{
        marginBottom: 8,
        padding: '11px 13px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="clcov-skel cl-skeleton" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }} />
        <span className="clcov-skel cl-skeleton" style={{ width: 22, height: 16, borderRadius: 5 }} />
        <span className="clcov-skel cl-skeleton" style={{ width: SKEL_NAME_W[index % SKEL_NAME_W.length], height: 13 }} />
        <span className="clcov-skel cl-skeleton" style={{ marginLeft: 'auto', width: 84, height: 10 }} />
      </div>
      <div className="flex items-center gap-1.5" style={{ marginTop: 7 }}>
        <span className="clcov-skel cl-skeleton" style={{ width: 56, height: 15 }} />
        <span className="clcov-skel cl-skeleton" style={{ width: 42, height: 15 }} />
        <span className="clcov-skel cl-skeleton" style={{ width: 68, height: 15 }} />
      </div>
    </div>
  )
}
