import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useState } from 'react'
import type { CoverageLedger, CoverageStatus, EnforcementState, ExtractedTest, GapType, RequirementCoverage, RequirementEnforcement, TestCoverage, TestStrength } from '@/shared/api/types'
import { TestPresentation } from '@/shared/ui/TestPresentation'
import { TestIdBadge } from '@/shared/ui/TestIdBadge'
import { stripLeadingTestOrdinal } from '@/shared/test-numbering'

// Each gap class gets a stable label + colour. Coverage is semantic (run-free):
// `untested` (no test maps to it) is the gap; `path-incomplete` (some declared
// paths unclaimed) is partial; `covered` (every path claimed) is the good state.
// The label is the legend's word and the row tooltip's first word; the row itself
// shows the gap as segments (one per path, or per path×variant cell) + a fraction.
export const GAP_META: Record<GapType, { label: string; color: string }> = {
  covered: { label: 'Covered', color: 'var(--success)' },
  // Short labels keep the legend from crushing the layout at narrow widths; the
  // glossary `i` still spells out the full meaning.
  'path-incomplete': { label: 'Path gap', color: 'var(--accent)' },
  // A requirement that spans a variant dimension (channel/tenant/…) but is only
  // tested on some values. Amber = the breadth warning: it claims more than it proves.
  'variant-incomplete': { label: 'Variant gap', color: 'var(--warning)' },
  untested: { label: 'Untested', color: 'var(--text-muted)' },
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

// Plain-language gloss for the path a test row claims (tooltip only — the row
// itself stays terse). These mirror a requirement's declared happy/sad/edge.
export const PATH_DESC: Record<string, string> = { happy: 'happy', sad: 'failure', edge: 'edge-case' }

// Requirements list is ordered worst-first (uncovered → partial → covered) so the
// gaps that need work sit at the top — the whole point of the ledger.
export const STATUS_RANK: Record<CoverageStatus, number> = { uncovered: 0, partial: 1, covered: 2 }

// The time axis (D11): one dot per requirement row, shown only while the proof
// is unhealthy — a healthy proof earns no mark. The copy is the 2026-09-03
// mockup's; the hues follow the status vocabulary (rose = the proof is
// undermined, amber = the proof is behind, green = proven and current — the
// green is still used by the flight band, never by the row).
export const ENFORCEMENT_META: Record<EnforcementState, { label: string; color: string; rank: number; help: string }> = {
  'tests-weakened': { label: 'Tests weakened since proof', color: 'var(--danger)', rank: 0, help: 'A mapped test was made weaker after the run that proved this requirement — that proof never saw the weaker test.' },
  'proof-stale': { label: 'Proof stale', color: 'var(--warning)', rank: 1, help: 'A mapped test changed after the proof (or the requirement was never proven) and no green run has followed.' },
  'wording-ahead': { label: 'Wording ahead of tests', color: 'var(--warning)', rank: 2, help: 'The requirement\'s wording changed after its tests and its proof — the tests may no longer test what it says.' },
  'proven-unchanged': { label: 'Proven, unchanged', color: 'var(--success)', rank: 3, help: 'A green run over every mapped test is newer than both the tests\' and the wording\'s last change.' },
}

/** Worst-first row order: a weakened test outranks any claim status (the proof
 *  is undermined, whatever the tags claim), then claim status, then the time
 *  axis. Stable within a rank; a ledger without the axis sorts by claim alone. */
export function compareRequirements(a: RequirementCoverage, b: RequirementCoverage): number {
  const weakened = (rc: RequirementCoverage): number => (rc.enforcement?.state === 'tests-weakened' ? 0 : 1)
  const axis = (rc: RequirementCoverage): number => (rc.enforcement ? ENFORCEMENT_META[rc.enforcement.state].rank : 0)
  return weakened(a) - weakened(b)
    || STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)]
    || axis(a) - axis(b)
}

/** ISO instant → calendar day; the axis is about ORDER, and a day is the grain a
 *  reader compares by (three full timestamps on one line are noise). */
const day = (iso: string): string => iso.slice(0, 10)

// The dot has no words of its own, so the tooltip leads with the verdict.
function enforcementTooltip(e: RequirementEnforcement): string {
  return [
    ENFORCEMENT_META[e.state].label,
    ENFORCEMENT_META[e.state].help,
    e.provenAt ? `Proven in run ${e.provenAt.runId} · ${day(e.provenAt.at)}` : 'Never proven — no run has passed every mapped test',
    e.testsChangedAt ? `Tests changed ${day(e.testsChangedAt.at)} (${e.testsChangedAt.verdict})` : 'No recorded test change',
    `Wording changed ${day(e.wordingChangedAt)}`,
  ].join('\n')
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

// The time axis inside a requirement's detail: the proof run, the last test
// change with its verdict, the last wording change, where the wording came from,
// and the Accept lever. Facts as a `·`-separated strip in the muted hue — the
// row's dot already carries the verdict colour, so the strip stays neutral.

/** One segment per unit of coverage the row promises: the declared paths, or —
 *  for a variant requirement — every APPLICABLE path×variant cell (a variant the
 *  ledger marked not-applicable anywhere is left out, matching VariantCoverage's
 *  per-variant N/A rule, so the row and the accordion agree on the denominator).
 *  Declared order, not worst-first: the segments are a map, not a queue. */
export function coverageSegments(rc: RequirementCoverage): boolean[] {
  const cells = rc.variantCoverage ?? []
  if (cells.length === 0) return rc.pathCoverage.map((p) => p.covered)
  const na = new Set(cells.filter((c) => c.applicable === false).map((c) => c.variant))
  return cells.filter((c) => !na.has(c.variant)).map((c) => c.covered)
}
function EnforcementStrip({ rc, enforcement: e, onAccept }: { rc: RequirementCoverage; enforcement: RequirementEnforcement; onAccept?: () => void }) {
  const id = rc.requirement.id
  const source = rc.requirement.source
  const acceptedAt = rc.requirement.acceptedAt
  const items: Array<{ key: string; node: ReactNode; title?: string }> = [
    e.provenAt
      ? { key: 'proven', node: <>proven in run <code>{e.provenAt.runId}</code></>, title: `Every mapped test passed in run ${e.provenAt.runId} on ${day(e.provenAt.at)}` }
      : { key: 'proven', node: 'never proven', title: 'No recorded run has passed every test mapped to this requirement' },
  ]
  if (e.testsChangedAt) {
    items.push({
      key: 'tests',
      node: <>tests changed {day(e.testsChangedAt.at)} ({e.testsChangedAt.verdict})</>,
      title: `${e.testsChangedAt.tests.join(', ')}${e.testsChangedAt.runId ? ` — recorded by run ${e.testsChangedAt.runId}` : ' — edited between runs'}`,
    })
  }
  items.push({ key: 'wording', node: <>wording changed {day(e.wordingChangedAt)}</> })
  if (source) {
    items.push({
      key: 'source',
      node: <code>{source.heading ? `${source.doc} § ${source.heading}` : source.doc}</code>,
      title: `Where this wording came from${source.line ? ` (line ${source.line})` : ''}`,
    })
  }
  if (e.accepted === 'current' && acceptedAt) {
    items.push({ key: 'accepted', node: <>accepted {day(acceptedAt)}</>, title: 'A human accepted this exact wording from the ledger' })
  }
  return (
    <div className="clcov-enf" data-testid={`enf-strip-${id}`}>
      {items.map((item, i) => (
        <span key={item.key} className="clcov-enf-item">
          {i > 0 && <span className="clcov-enf-sep" aria-hidden="true">·</span>}
          <span title={item.title}>{item.node}</span>
        </span>
      ))}
      {onAccept && e.accepted !== 'current' && (
        <button
          type="button"
          className="clcov-enf-accept"
          data-testid={`accept-${id}`}
          title={e.accepted === 'outdated' && acceptedAt
            ? `The wording moved since it was accepted on ${day(acceptedAt)} — accept the current wording`
            : 'Mark this wording as accepted (recorded with its fingerprint, so a later change shows)'}
          onClick={(ev) => { ev.stopPropagation(); onAccept() }}
        >
          {e.accepted === 'outdated' ? 'Re-accept wording' : 'Accept wording'}
        </button>
      )}
    </div>
  )
}

export function RequirementCard({ rc, active, focused, dimmed, onHover, onAccept }: {
  rc: RequirementCoverage
  active: boolean
  focused: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
  /** The human-only Accept-wording lever (D11). Absent on read-only embeds. */
  onAccept?: () => void
}) {
  const { id, title, text, kind, happyPath, unhappyPath, deprecated } = rc.requirement
  const meta = GAP_META[rc.gapType]
  const enf = rc.enforcement
  const hasVariants = Boolean(rc.variantCoverage && rc.variantCoverage.length > 0)
  const segments = coverageSegments(rc)
  const claimed = segments.filter(Boolean).length
  const happyText = meaningfulPath(happyPath)
  const unhappyText = meaningfulPath(unhappyPath)
  // The row at rest is id · title · segments · a dot only when the proof is
  // unhealthy. Everything else — the requirement text, the per-path detail, the
  // history line, the happy/unhappy prose — waits behind the caret, so every
  // requirement is disclosable (the text alone earns it).
  const [expanded, setExpanded] = useState(false)
  const toggle = () => setExpanded((c) => !c)
  const unhealthy = enf && enf.state !== 'proven-unchanged' ? enf : null
  return (
    <div
      className="clcov-row"
      data-testid={`req-${id}`}
      data-active={active ? 'true' : 'false'}
      data-focus={focused ? 'true' : 'false'}
      data-dimmed={dimmed ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div
        className="clcov-rowhead"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid={`req-toggle-${id}`}
        onClick={toggle}
        onKeyDown={(e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
      >
        <span aria-hidden="true" className="clcov-caret">{expanded ? '▾' : '▸'}</span>
        <span className="clcov-rowid">{id}</span>
        <span className="clcov-rowtitle">
          {title}
          {deprecated && <span className="clcov-rownote">(deprecated)</span>}
          {/* Functional is the default and says nothing; only the exception earns a word. */}
          {kind === 'non-functional' && <span className="clcov-rownote" data-testid={`kind-${id}`}>Non-functional</span>}
        </span>
        <span
          className="clcov-segs"
          data-testid={`cov-${id}`}
          title={`${meta.label} — ${claimed} of ${segments.length} ${hasVariants ? 'path × variant cells' : segments.length === 1 ? 'path' : 'paths'} ${claimed === 1 ? 'has' : 'have'} a mapped test`}
        >
          {segments.map((on, i) => <span key={i} className="clcov-seg" data-seg={on ? 'on' : 'off'} />)}
          <span className="clcov-segn">{claimed}/{segments.length}</span>
        </span>
        {unhealthy ? (
          <span className="clcov-alert" data-testid={`enf-${id}`} title={enforcementTooltip(unhealthy)} style={{ background: ENFORCEMENT_META[unhealthy.state].color }} />
        ) : (
          <span className="clcov-alert" aria-hidden="true" />
        )}
      </div>
      {expanded && (
        <div className="clcov-rowdetail" data-testid={`req-detail-${id}`}>
          <div className="clcov-req-text">{text}</div>
          {hasVariants ? (
            // Variant requirement: the path×variant accordion is the source of truth —
            // the 1-axis path chips would only duplicate it, so they're dropped here.
            <VariantCoverage rc={rc} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {rc.pathCoverage.map((p) => (
                p.covered ? (
                  <span key={p.path} data-testid={`path-${id}-${p.path}`} title={`${p.path} path has a mapped test`} className="clcov-vchip clcov-vchip-on">
                    {p.path} ✓
                  </span>
                ) : (
                  // No test for this path — the dashed/muted treatment carries that.
                  <span key={p.path} data-testid={`path-${id}-${p.path}`} title={`No test maps to the ${p.path} path`} className="clcov-vchip">
                    {p.path}
                  </span>
                )
              ))}
            </div>
          )}
          {enf && <EnforcementStrip rc={rc} enforcement={enf} onAccept={onAccept} />}
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

// A test row at rest: caret · #N · name · the requirement and path it claims (mono,
// muted; the requirement id is the jump link) · a dot in the strength hue. No
// decorative accent, no run-coupled "verified" dot (coverage is semantic). Click
// the row to disclose the actual test source (lazily fetched by the parent).
export function TestCard({ test, testNumber, active, dimmed, onHover, onExpand, source, sourceLoading, sourceError, onReqClick }: {
  test: TestCoverage
  testNumber?: number
  active: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
  onExpand: () => void
  source: { test: ExtractedTest; absFile: string } | null
  sourceLoading: boolean
  sourceError: string | null
  onReqClick: (id: string) => void
}) {
  const cardName = source?.test.name ?? test.name
  const [expanded, setExpanded] = useState(false)
  const toggle = () => {
    setExpanded((cur) => {
      if (!cur) onExpand() // trigger the lazy source fetch on first open
      return !cur
    })
  }
  const strength = test.strength ? STRENGTH_META[test.strength] : null
  return (
    <div
      className="clcov-row"
      data-testid={`test-${cardName}`}
      data-active={active ? 'true' : 'false'}
      data-dimmed={dimmed ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div
        className="clcov-rowhead"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid={`test-toggle-${cardName}`}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
      >
        <span aria-hidden="true" className="clcov-caret">{expanded ? '▾' : '▸'}</span>
        <span className="clcov-rowid"><TestIdBadge n={testNumber} /></span>
        {/* Name is the identity; the expanded shared presentation owns the
            file:line locator and Code mode's editor action. */}
        <span className="clcov-rowtitle">{stripLeadingTestOrdinal(cardName)}</span>
        <span className="clcov-rowfacts">
          {test.requirements.length === 0 ? (
            <span data-testid={`orphan-${cardName}`} className="clcov-orphan" title="No requirement tag — regenerate coverage to map this test">orphan</span>
          ) : (
            test.requirements.map((id, i) => (
              <span key={id} className="clcov-rowfact">
                {i > 0 && <span className="clcov-rowsep" aria-hidden="true">·</span>}
                <button
                  type="button"
                  className="clcov-reqtag"
                  data-testid={`reqtag-${cardName}-${id}`}
                  title={`Jump to requirement ${id}`}
                  onClick={(e) => { e.stopPropagation(); onReqClick(id) }}
                >{id}</button>
              </span>
            ))
          )}
          {test.pathTypes.map((p) => (
            <span key={p} className="clcov-rowfact">
              <span className="clcov-rowsep" aria-hidden="true">·</span>
              <span title={`Exercises the ${PATH_DESC[p] ?? p} path`}>{p}</span>
            </span>
          ))}
        </span>
        {strength ? (
          <span className="clcov-alert" data-testid={`strength-${cardName}`} title={strength.title} style={{ background: strength.color }} />
        ) : (
          <span className="clcov-alert" aria-hidden="true" />
        )}
      </div>
      {expanded && (
        <div className="clcov-rowdetail clcov-source" data-testid={`test-source-${cardName}`}>
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

// Placeholder row shown in the Tests pane while a coverage job runs. Same shell as
// TestCard (so it resolves into the real row in place), but every meaningful bit —
// caret, id, name, facts, dot — is a skeleton: the pane is honestly loading, not
// half-revealing the test set against the middle pane's "Mapping…". Widths vary
// per index so the column reads as a list of real rows, not a grid.
export const SKEL_NAME_W = [172, 132, 198, 150, 116, 184, 142, 164]

export function TestCardSkeleton({ index }: { index: number }) {
  return (
    <div className="clcov-row" data-testid="test-skeleton" aria-hidden="true">
      <div className="clcov-rowhead" style={{ cursor: 'default' }}>
        <span className="clcov-skel cl-skeleton" style={{ width: 10, height: 10 }} />
        <span className="clcov-skel cl-skeleton" style={{ width: 22, height: 12 }} />
        <span className="clcov-skel cl-skeleton" style={{ width: SKEL_NAME_W[index % SKEL_NAME_W.length], height: 12 }} />
        <span className="clcov-skel cl-skeleton" style={{ marginLeft: 'auto', width: 64, height: 10 }} />
        <span className="clcov-skel cl-skeleton" style={{ width: 6, height: 6, borderRadius: '50%' }} />
      </div>
    </div>
  )
}
