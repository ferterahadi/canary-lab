import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useState } from 'react'
import type { CoverageLedger, CoverageStatus, EnforcementState, ExtractedTest, GapType, PathType, RequirementCoverage, RequirementEnforcement, TestCoverage, TestStrength } from '@/shared/api/types'
import { TestPresentation } from '@/shared/ui/TestPresentation'
import { TestIdBadge } from '@/shared/ui/TestIdBadge'
import { Tooltip } from '@/shared/ui/Tooltip'
import { stripLeadingTestOrdinal } from '@/shared/test-numbering'

// Each gap class gets a stable label + colour. Coverage is semantic (run-free):
// `untested` (no test maps to it) is the gap; `path-incomplete` (some declared
// paths unclaimed) is partial; `covered` (every path claimed) is the good state.
// The label is the legend's word and the row tooltip's first word; the row itself
// shows the gap as segments (one per path, or per path×variant cell) + a fraction.
export const GAP_META: Record<GapType, { label: string; color: string }> = {
  // Sky, not green: `covered` means every path has a TEST, which is a claim, and
  // sky is this system's hue for in-progress. Green stays reserved for "a run
  // passed it" — the distinction the product exists to make, and one this legend
  // used to erase by wearing the passing hue. Bleaching it to grey was the
  // over-correction: it removed the good state from a measure whose whole job is
  // to report claim completeness.
  covered: { label: 'Covered', color: 'var(--running)' },
  // Short labels keep the legend from crushing the layout at narrow widths; the
  // glossary `i` still spells out the full meaning.
  //
  // Amber leaning to rose — the hotter of the two gap hues, because a path gap is
  // the worse gap: a declared behaviour (happy/sad/edge) has NO test at all, where
  // a variant gap only means the test it has is narrow. Both gaps wore the exact
  // same `--warning` before, on the theory that one `partial` tier should read as
  // one colour; in a suite whose gaps are lopsided (2 path vs 21 variant) that made
  // the bar a single undifferentiated amber run — the legend named the two kinds,
  // but the shape could not. A derived shade, not a new hue: the design system's
  // rule is that a hue means one thing, and this stays inside warning→danger,
  // which is exactly the direction of the extra severity. It held `--accent` before
  // that, which the design system reserves for "you can click this, never a status".
  'path-incomplete': { label: 'Path gap', color: 'color-mix(in srgb, var(--warning) 50%, var(--danger))' },
  // A requirement that spans a variant dimension (channel/tenant/…) but is only
  // tested on some values. Plain amber — the token's own stated meaning is
  // "stale / shallow", and a variant gap is precisely shallowness: it claims more
  // breadth than it proves, but every declared path does have a test.
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

/** The segment strip's hover label: the verdict and the count, then the strip
 *  itself KEYED — one line per square, in the same order, naming the case that
 *  square stands for. The mark mirrors the square's own fill, so the reader maps
 *  line to square by position and by shape; nothing has to explain the symbols,
 *  because the only thing missing from an anonymous square was its name. */
const SEGMENT_MARK: Record<SegmentState, string> = { off: '□', claimed: '■', proven: '▣' }
function segmentTooltip(verdict: string, segments: CoverageSegment[]): string {
  const claimed = segments.filter((s) => s.covered).length
  const proven = segments.filter((s) => s.proven).length
  const key = segments.map((s) => `${SEGMENT_MARK[segmentState(s)]} ${s.label} — ${SEGMENT_WORD[segmentState(s)]}`)
  // Both numbers, because they are the two different questions the strip answers.
  // "mapped" rather than "covered": the good state's verdict word IS "Covered", and
  // "Covered — 3 of 3 covered" reads as a stutter. Mapped is the ledger's own verb.
  return [`${verdict} — ${claimed} of ${segments.length} mapped, ${proven} proven`, ...key].join('\n')
}

// Requirements list is ordered worst-first (uncovered → partial → covered) so the
// gaps that need work sit at the top — the whole point of the ledger.
export const STATUS_RANK: Record<CoverageStatus, number> = { uncovered: 0, partial: 1, covered: 2 }

// The time axis (D11) as a SORT key. The four state ids are the derivation and
// stay verbatim on the agent surfaces (docs/FEATURES.md); what a human reads is
// `verdictView`, which branches on facts the id cannot carry. Worst-first.
export const ENFORCEMENT_RANK: Record<EnforcementState, number> = {
  'tests-weakened': 0,
  'proof-stale': 1,
  'wording-ahead': 2,
  'proven-unchanged': 3,
}

/** Worst-first row order: a weakened test outranks any claim status (the proof
 *  is undermined, whatever the tags claim), then claim status, then the time
 *  axis. Stable within a rank; a ledger without the axis sorts by claim alone. */
export function compareRequirements(a: RequirementCoverage, b: RequirementCoverage): number {
  const weakened = (rc: RequirementCoverage): number => (rc.enforcement?.state === 'tests-weakened' ? 0 : 1)
  const axis = (rc: RequirementCoverage): number => (rc.enforcement ? ENFORCEMENT_RANK[rc.enforcement.state] : 0)
  return weakened(a) - weakened(b)
    || STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)]
    || axis(a) - axis(b)
}

/** ISO instant → calendar day; the axis is about ORDER, and a day is the grain a
 *  reader compares by (three full timestamps on one line are noise). */
const day = (iso: string): string => iso.slice(0, 10)

/** What the reader is told, as opposed to what the state machine computed.
 *
 *  The four `EnforcementState` ids are a DERIVATION over three timestamps and
 *  they do not change here — the agent-facing payload keeps them verbatim. What
 *  changes is the sentence: a requirement that has never been proven has no
 *  proof to be "ahead of", so the −∞ rule that makes `wording-ahead` the default
 *  was putting "Wording ahead of tests" on the screen for every requirement in a
 *  suite that had simply never run (41 of 41 on cns-wa-merchant), inviting the
 *  entirely reasonable question "what wording changed?" — when nothing had. The
 *  display branches on the two things the state id cannot see: whether a proof
 *  exists at all, and whether the requirement is even claimable yet. */
export interface VerdictView {
  /** Takeaway first — the situation, not the derivation that produced it. */
  label: string
  /** What to do about it, or why there is nothing to do. */
  detail: string
  color: string
  /** A requirement nothing claims yet gets a hollow mark: there is no verdict to
   *  report, only a reason there isn't one. */
  hollow?: boolean
}

export function verdictView(rc: RequirementCoverage, e: RequirementEnforcement): VerdictView {
  const proof = e.provenAt
  const changed = e.testsChangedAt
  const run = proof ? `run ${proof.runId} (${day(proof.at)})` : ''
  // Nothing claims it, so nothing can prove it. Naming the missing cases beats
  // any status word: the grid above already shows which, this says why.
  if (rc.coverageStatus !== 'covered') {
    const missing = [...new Set(coverageSegments(rc).filter((seg) => !seg.covered).map((seg) => seg.variant ?? seg.path))]
    return {
      label: 'Not provable yet',
      detail: missing.length > 0 ? `${joinNatural(missing)} ${missing.length === 1 ? 'has' : 'have'} no test.` : 'No test maps to this requirement.',
      color: 'var(--text-muted)',
      hollow: true,
    }
  }
  if (e.state === 'tests-weakened' && changed) {
    return {
      label: 'A test was weakened after the proof',
      detail: `${joinNatural(changed.tests)} changed ${day(changed.at)}${proof ? `; ${run} never saw the weaker test` : ''}. Restore the assertion — rerunning won't fix this.`,
      color: 'var(--danger)',
    }
  }
  // Every remaining state needs a proof to be measured against. Without one the
  // honest reading is simply that nothing has proved it yet.
  if (!proof) {
    return {
      label: 'Not proven yet',
      detail: 'No run has passed every test mapped to this requirement.',
      color: 'var(--warning)',
      hollow: true,
    }
  }
  if (e.state === 'proven-unchanged') {
    return { label: 'Proven', detail: `Every test passed in ${run}, and nothing has changed since.`, color: 'var(--success)' }
  }
  if (e.state === 'wording-ahead') {
    return {
      label: `${rc.requirement.id} was rewritten after the proof`,
      detail: `Reworded ${day(e.wordingChangedAt)}; ${run} proved the earlier wording. Check the tests still match, then rerun.`,
      color: 'var(--warning)',
    }
  }
  return {
    label: 'Proof out of date',
    detail: changed
      ? `${joinNatural(changed.tests)} changed ${day(changed.at)}, after ${run} proved this. Rerun to re-prove.`
      : `${run} no longer covers the current tests. Rerun to re-prove.`,
    color: 'var(--warning)',
  }
}

/** "a", "a and b", "a, b and c" — a list the way a sentence writes one. */
function joinNatural(items: string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// The dot has no words of its own, so the tooltip leads with the verdict.
function enforcementTooltip(rc: RequirementCoverage, e: RequirementEnforcement): string {
  const v = verdictView(rc, e)
  return [
    v.label,
    v.detail,
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

/** The three things a square can say, in the order they improve. One vocabulary
 *  for the resting strip, the per-channel grid and the band marks, so the reader
 *  learns ONE mark: hollow = nothing claims this, sky = a test claims it, green =
 *  a run passed it. The two filled states are the product's whole thesis, so they
 *  get two hues from the documented status vocabulary — sky is "in progress",
 *  which is precisely a claim awaiting its proof, and green stays the only hue
 *  that means evidence. */
export type SegmentState = 'off' | 'claimed' | 'proven'
export const segmentState = (seg: { covered: boolean; proven: boolean }): SegmentState =>
  seg.proven ? 'proven' : seg.covered ? 'claimed' : 'off'
export const SEGMENT_WORD: Record<SegmentState, string> = {
  off: 'no test',
  claimed: 'has a test · not yet passed',
  proven: 'passed',
}

/** A named unit of coverage the row promises. The NAME is what makes the strip
 *  readable: a square on its own is an anonymous mark, and the only thing worth
 *  saying about it is which case it stands for. */
export interface CoverageSegment {
  /** `happy`, or `happy · email` once a variant dimension is in play. */
  label: string
  /** The path this segment stands for. Carried so the behaviour bands can
   *  PARTITION the segments the row strip already counted, instead of walking
   *  the cells a second time — one denominator, two readings of it. */
  path: PathType
  /** The variant cell, when a variant dimension is in play. */
  variant?: string
  /** A test CLAIMS this unit — an `@requirement` tag points at it. Says nothing
   *  about whether anything ran. */
  covered: boolean
  /** A claiming test also PASSED in the feature's latest run. The distinction
   *  claim-vs-proof is the product's whole thesis, and until this landed the
   *  strip painted a claim in `--success` — the hue that means "passed"
   *  everywhere else — under a panel that said "Last proved: never". */
  proven: boolean
}

/** One segment per unit of coverage the row promises: the declared paths, or —
 *  for a variant requirement — every APPLICABLE path×variant cell (a variant the
 *  ledger marked not-applicable anywhere is left out, matching VariantCoverage's
 *  per-variant N/A rule, so the row and the accordion agree on the denominator).
 *  Declared order, not worst-first: the segments are a map, not a queue — which is
 *  also what lets the strip's hover label name them square by square. */
export function coverageSegments(rc: RequirementCoverage): CoverageSegment[] {
  const cells = rc.variantCoverage ?? []
  if (cells.length === 0) {
    return rc.pathCoverage.map((p) => ({ label: p.path, path: p.path, covered: p.covered, proven: p.proven === true }))
  }
  const na = new Set(cells.filter((c) => c.applicable === false).map((c) => c.variant))
  return cells
    .filter((c) => !na.has(c.variant))
    .map((c) => ({ label: `${c.path} · ${c.variant}`, path: c.path, variant: c.variant, covered: c.covered, proven: c.proven === true }))
}
/** The panel's conclusion, drawn under the marks it is drawn FROM. One line: a
 *  mark and the situation. The coverage bands above already name the missing
 *  cases; the three underlying dates stay on the mark's hover. */
function VerdictLine({ rc, enforcement: e }: { rc: RequirementCoverage; enforcement: RequirementEnforcement }) {
  const v = verdictView(rc, e)
  const dates = [
    e.provenAt ? `Last proved ${day(e.provenAt.at)} · run ${e.provenAt.runId}` : 'Never proved',
    e.testsChangedAt ? `Tests changed ${day(e.testsChangedAt.at)} (${e.testsChangedAt.verdict})` : 'No recorded test change',
    `Wording last written ${day(e.wordingChangedAt)}`,
  ].join('\n')
  return (
    <p className="clcov-verdict" data-testid={`proof-verdict-${rc.requirement.id}`}>
      <span
        className="clcov-verdict-dot"
        data-hollow={v.hollow ? 'true' : 'false'}
        title={dates}
        style={v.hollow ? { boxShadow: `inset 0 0 0 1px ${v.color}` } : { background: v.color }}
      />
      <span className="clcov-verdict-label">{v.label}</span>
    </p>
  )
}


/** `sad` and `edge` share ONE prose field on the requirement (`unhappyPath`), so
 *  they read as one promise with two test surfaces — never as two promises whose
 *  sentence happens to be identical. */
const PATH_BUCKET: Record<PathType, 'happy' | 'unhappy'> = { happy: 'happy', sad: 'unhappy', edge: 'unhappy' }

/** One promise the requirement makes: the sentence that states it, and every
 *  coverage segment that stands for it. */
export interface BehaviourBucket {
  key: 'happy' | 'unhappy'
  label: string
  text: string | null
  segments: CoverageSegment[]
}

/** Behaviour and coverage used to be two bands split on the SAME axis — the prose
 *  under "Expected behaviour", the chips under "Test coverage" — so a reader had
 *  to carry "Unhappy path" across a section break and match it to a pill called
 *  `sad`, in a second vocabulary, to learn whether the thing they had just read
 *  was tested. One block per promise puts the claim and its evidence in one
 *  eye-line, and the pill's name stops being a word the reader has to translate.
 *  A bucket with neither prose nor segments never renders. */
export function behaviourBuckets(rc: RequirementCoverage, happyText: string | null, unhappyText: string | null): BehaviourBucket[] {
  const segments = coverageSegments(rc)
  const bucket = (key: 'happy' | 'unhappy', label: string, text: string | null): BehaviourBucket =>
    ({ key, label, text, segments: segments.filter((seg) => PATH_BUCKET[seg.path] === key) })
  return [bucket('happy', 'Happy path', happyText), bucket('unhappy', 'Unhappy path', unhappyText)]
    .filter((b) => b.text !== null || b.segments.length > 0)
}

/** One promise: its name, its sentence, and — when the requirement has no channel
 *  dimension — the mark for the cases it covers. The per-channel grid below owns
 *  the marks whenever there IS a dimension, so nothing is said twice. */
function BehaviourBand({ rc, bucket, showMarks }: { rc: RequirementCoverage; bucket: BehaviourBucket; showMarks: boolean }) {
  const id = rc.requirement.id
  return (
    <div className="clcov-band" data-testid={`behaviour-${bucket.key}-${id}`}>
      <div className="clcov-band-head">
        <span className="clcov-band-name">{bucket.label}</span>
        {showMarks && bucket.segments.length > 0 && (
          <span className="clcov-band-marks" data-testid={`behaviour-marks-${bucket.key}-${id}`}>
            {bucket.segments.map((seg) => (
              <span key={seg.label} className="clcov-cellmark" data-seg={segmentState(seg)} title={`${seg.label} — ${SEGMENT_WORD[segmentState(seg)]}`} />
            ))}
            <span className="clcov-band-word">{SEGMENT_WORD[worstState(bucket.segments)]}</span>
          </span>
        )}
      </div>
      {bucket.text && <p className="clcov-path-text">{bucket.text}</p>}
    </div>
  )
}

/** The reading a row of marks adds up to: one bad cell makes the whole promise
 *  unproven, so the WORST state is the honest summary word. */
export function worstState(segments: CoverageSegment[]): SegmentState {
  if (segments.some((seg) => !seg.covered)) return 'off'
  return segments.every((seg) => seg.proven) ? 'proven' : 'claimed'
}

/** Channel coverage as the matrix it actually is: channels down, paths across.
 *
 *  It used to be a chip row repeated UNDER EACH promise — the same channel names
 *  printed twice in two disconnected lists, so "is `line` tested anywhere?" meant
 *  scanning both and holding the answer in your head. A channel is a property of
 *  the REQUIREMENT ("must hold across whatsapp and line"), not of one promise, so
 *  it belongs at that altitude and is read down a column instead. Paths are
 *  bounded (three declared at most) so the columns can never overflow the pane;
 *  channels are unbounded and grow downward, where there is room.
 *
 *  Rendered open, with no caret: the reader already opened the row, and "which
 *  channel" is the question that brought them here.
 *
 *  The path tracks are sized from their own content, never a fixed width: at a
 *  22px track a label as ordinary as `happy` (29px of mono) overflowed its column
 *  and ran into the next one — the head read `happyedge`, and no label sat over
 *  the marks it names. `minmax(22px,auto)` keeps a bare mark column from
 *  collapsing while letting the widest declared path name set the column. */
function ChannelGrid({ rc }: { rc: RequirementCoverage }) {
  const id = rc.requirement.id
  const cells = rc.variantCoverage ?? []
  const paths = [...new Set(cells.map((c) => c.path))]
  const naReason = (variant: string) => cells.find((c) => c.variant === variant && c.applicable === false)?.reason
  const rows = [...new Set(cells.map((c) => c.variant))].map((variant) => {
    const reason = naReason(variant)
    const segments = paths.map((path) => {
      const cell = cells.find((c) => c.path === path && c.variant === variant)
      return { label: `${path} · ${variant}`, path, variant, covered: cell?.covered ?? false, proven: cell?.proven === true }
    })
    return { variant, reason, segments }
  })
  // Worst-first: the channel with the most missing tests leads, then the least
  // proven; N/A sinks last — it is never a gap, so it never competes for the top.
  const rank = (r: typeof rows[number]) =>
    r.reason ? [2, 0, 0] : [0, -r.segments.filter((seg) => !seg.covered).length, -r.segments.filter((seg) => !seg.proven).length]
  rows.sort((x, y) => { const a = rank(x); const b = rank(y); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] })
  return (
    <div
      className="clcov-grid"
      data-testid={`channel-grid-${id}`}
      style={{ gridTemplateColumns: `minmax(64px,auto) repeat(${paths.length},minmax(22px,auto)) minmax(0,1fr)` }}
    >
      <div className="clcov-grid-head">
        <span className="clcov-grid-kicker">Per channel</span>
        {paths.map((path) => <span key={path} className="clcov-grid-col">{path}</span>)}
        <span />
      </div>
      {rows.map((row) => (
        <div
          key={row.variant}
          className="clcov-grid-row"
          data-testid={`channel-${id}-${row.variant}`}
          data-na={row.reason ? 'true' : 'false'}
        >
          <span className="clcov-grid-name">{row.variant}</span>
          {row.reason
            ? paths.map((path) => <span key={path} className="clcov-cellmark" data-seg="na" title={`${row.variant}: N/A — ${row.reason}`} />)
            : row.segments.map((seg) => (
              <span key={seg.path} className="clcov-cellmark" data-seg={segmentState(seg)} title={`${seg.label} — ${SEGMENT_WORD[segmentState(seg)]}`} />
            ))}
          {/* The trailing word is what makes a two-channel grid readable as a
              list: at that size an axis lookup costs more than the sentence. */}
          <span className="clcov-grid-word" title={row.reason}>
            {row.reason ? `n/a — ${row.reason}` : SEGMENT_WORD[worstState(row.segments)]}
          </span>
        </div>
      ))}
    </div>
  )
}

/** True while the two-line clamp is actually cutting this title. Read at hover time
 *  rather than tracked as state: at mount the pane may not have its final width (the
 *  Docs rail can take a third of it), and a later web-font swap re-cuts a title
 *  without changing any box a ResizeObserver would report. */
export const titleIsClamped = (el: Element) => el.scrollHeight > el.clientHeight + 1

// A row title: the text, clamped to two lines so every row keeps one height, plus
// whatever notes the row hangs off it. Hovering a title the clamp has CUT floats the
// whole thing — through the shared Tooltip, which portals and clamps to the viewport,
// so a row at the pane's edge isn't cut a second time by the pane's own scroller. A
// title that fits reveals nothing, which is why the slow native `title` is gone: it
// only ever repeated text already on screen.
function RowTitle({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <Tooltip label={text} showIf={titleIsClamped}>
      <span className="clcov-rowtitle">
        {text}
        {children}
      </span>
    </Tooltip>
  )
}

export function RequirementCard({ rc, active, focused, dimmed, onHover }: {
  rc: RequirementCoverage
  active: boolean
  focused: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
}) {
  const { id, title, text, kind, happyPath, unhappyPath, deprecated } = rc.requirement
  const meta = GAP_META[rc.gapType]
  const enf = rc.enforcement
  const segments = coverageSegments(rc)
  const claimed = segments.filter((s) => s.covered).length
  const buckets = behaviourBuckets(rc, meaningfulPath(happyPath), meaningfulPath(unhappyPath))
  // With a channel dimension the grid owns every mark; the bands would only
  // restate it at a coarser grain, which is how the chip rows got duplicated.
  const hasChannels = (rc.variantCoverage ?? []).length > 0
  // ...which also leaves a prose-less band with nothing to say but its own name,
  // so it stops earning the space.
  const bands = hasChannels ? buckets.filter((b) => b.text !== null) : buckets
  // The row at rest is id · title · segments · a dot only when the proof is
  // unhealthy. Everything else — the requirement text, the per-path detail, the
  // history line, the happy/unhappy prose — waits behind the caret, so every
  // requirement is disclosable (the text alone earns it).
  const [expanded, setExpanded] = useState(false)
  const toggle = () => setExpanded((c) => !c)
  // Red always for a weakened test. Amber only where there is a claim to be
  // unproven — an untested requirement's hollow squares ARE the gap, and a dot
  // beside them marks one fact twice (it put 41 amber dots on a suite whose only
  // real news was "nothing has run yet").
  const unhealthy = enf && enf.state !== 'proven-unchanged'
    && (enf.state === 'tests-weakened' || rc.coverageStatus === 'covered') ? enf : null
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
        <RowTitle text={title}>
          {deprecated && <span className="clcov-rownote">(deprecated)</span>}
          {/* Functional is the default and says nothing; only the exception earns a word. */}
          {kind === 'non-functional' && <span className="clcov-rownote" data-testid={`kind-${id}`}>Non-functional</span>}
        </RowTitle>
        {/* Through the shared Tooltip, not a native `title`: the strip is the row's
            only coverage reading and its squares are unnamed, so the key naming them
            has to arrive on hover, not after a second of waiting. */}
        <Tooltip label={segmentTooltip(meta.label, segments)}>
          <span className="clcov-segs" data-testid={`cov-${id}`}>
            {segments.map((s) => <span key={s.label} className="clcov-seg" data-seg={segmentState(s)} />)}
            <span className="clcov-segn">{claimed}/{segments.length}</span>
          </span>
        </Tooltip>
        {unhealthy ? (
          <span className="clcov-alert" data-testid={`enf-${id}`} title={enforcementTooltip(rc, unhealthy)} style={{ background: verdictView(rc, unhealthy).color }} />
        ) : (
          <span className="clcov-alert" aria-hidden="true" />
        )}
      </div>
      {expanded && (
        // Three named bands under the wording, in the order a reader asks for them:
        // what it says → what it promises → what is tested → whether it is proven.
        // The declared behaviour used to sit BELOW the proof dates, so the pane opened
        // with an audit trail and buried the prose that explains the requirement.
        <div className="clcov-rowdetail" data-testid={`req-detail-${id}`}>
          <p className="clcov-req-text">{text}</p>
          {bands.length > 0 && (
            <div className="clcov-bands" data-testid={`behaviour-${id}`}>
              {bands.map((b) => <BehaviourBand key={b.key} rc={rc} bucket={b} showMarks={!hasChannels} />)}
            </div>
          )}
          {hasChannels && <ChannelGrid rc={rc} />}
          {enf && <VerdictLine rc={rc} enforcement={enf} />}
        </div>
      )}
    </div>
  )
}


// Requirement tags shown on a test row at rest before the remainder folds into "+N".
// One, so a test that claims several requirements reads the same way as one that
// claims several paths — a count, opened by the same hover. The resting row is then
// one id and one path word wide, which is what lets the title have the rest.
const MAX_REST_TAGS = 1

// A requirement id as a jump link. One home: the resting cell and the hover reveal
// render the same tag, so a folded id behaves exactly like a shown one.
function ReqTag({ id, testId, onReqClick }: { id: string; testId: string; onReqClick: (id: string) => void }) {
  return (
    <button
      type="button"
      className="clcov-reqtag"
      data-testid={testId}
      title={`Jump to requirement ${id}`}
      onClick={(e) => { e.stopPropagation(); onReqClick(id) }}
    >{id}</button>
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
  const shownReqs = test.requirements.slice(0, MAX_REST_TAGS)
  const hiddenReqs = test.requirements.slice(MAX_REST_TAGS)
  const paths = test.pathTypes
  // "3 paths" is a fold, not a fact of its own: the row claims three of the declared
  // path kinds and has no column to name them in. The reveal spells them out.
  const pathWord = paths.length === 1 ? paths[0] : `${paths.length} paths`
  const pathGloss = paths.map((p) => PATH_DESC[p] ?? p).join(', ')
  const pathTitle = `Exercises the ${pathGloss} path${paths.length === 1 ? '' : 's'}`
  // Only a cell that is actually hiding something earns a reveal.
  const folded = hiddenReqs.length > 0 || paths.length > 1
  const toggle = () => {
    setExpanded((cur) => {
      if (!cur) onExpand() // trigger the lazy source fetch on first open
      return !cur
    })
  }
  const strength = test.strength ? STRENGTH_META[test.strength] : null
  return (
    <div
      className="clcov-row clcov-row--test"
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
        <RowTitle text={stripLeadingTestOrdinal(cardName)} />
        {/* Two fixed sub-columns — the requirement tags, then the path — so the tags of
            every row end on one edge and the paths on another. Past the second tag (and
            past one path) the cell folds to a count; hovering it floats the unfolded
            strip over the row rather than widening the cell into the title. */}
        <span className="clcov-rowfacts">
          <span className="clcov-rowreqs">
            {test.requirements.length === 0 ? (
              <span data-testid={`orphan-${cardName}`} className="clcov-orphan" title="No requirement tag — regenerate coverage to map this test">orphan</span>
            ) : (
              <>
                {shownReqs.map((id, i) => (
                  <span key={id} className="clcov-rowfact">
                    {i > 0 && <span className="clcov-rowsep" aria-hidden="true">·</span>}
                    <ReqTag id={id} testId={`reqtag-${cardName}-${id}`} onReqClick={onReqClick} />
                  </span>
                ))}
                {hiddenReqs.length > 0 && (
                  <span className="clcov-rowfact">
                    <span className="clcov-rowsep" aria-hidden="true">·</span>
                    <span className="clcov-more" data-testid={`reqtag-more-${cardName}`} title={`Also ${hiddenReqs.join(', ')} — hover to show`}>+{hiddenReqs.length}</span>
                  </span>
                )}
              </>
            )}
          </span>
          <span className="clcov-rowpath">
            {paths.length > 0 && (
              <span data-testid={`paths-${cardName}`} title={pathTitle}>{pathWord}</span>
            )}
          </span>
          {folded && (
            <span className="clcov-facts-pop" data-testid={`facts-full-${cardName}`} role="group" aria-label={`Claims ${test.requirements.join(', ')} on the ${pathGloss} path${paths.length === 1 ? '' : 's'}`}>
              {test.requirements.map((id, i) => (
                <span key={id} className="clcov-rowfact">
                  {i > 0 && <span className="clcov-rowsep" aria-hidden="true">·</span>}
                  <ReqTag id={id} testId={`reqtag-full-${cardName}-${id}`} onReqClick={onReqClick} />
                </span>
              ))}
              {paths.map((pathType) => (
                <span key={pathType} className="clcov-rowfact">
                  <span className="clcov-rowsep" aria-hidden="true">·</span>
                  <span title={`The ${PATH_DESC[pathType] ?? pathType} path`}>{pathType}</span>
                </span>
              ))}
            </span>
          )}
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
