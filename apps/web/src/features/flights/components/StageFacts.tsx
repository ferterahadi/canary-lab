import type { ReactNode } from 'react'
import type { FlightManifest, FlightStage, FlightStageKey, PortifyBootInstance, PortifyManifest } from '@/shared/api/client'
import type { CoverageLedger, EvaluationExportTask, RunDetail } from '@/shared/api/types'
import { evaluationArchiveFilename, formatBytes, formatDuration } from '@/shared/lib/format'
import { PanelCard } from '@/shared/ui/PanelCard'
import { type AwaitingState } from '@/shared/ui/Skeleton'
import { Tooltip, TOOLTIP_ANCHOR_ATTR } from '@/shared/ui/Tooltip'
import { STAGE_COLUMN, evidenceOf, num, specsCoverageProgress, str } from './stage-meta'
import { bootDurationMs, distinctRepoPaths, estimateTokens, ledgerEvidence, overlayDiffStat, stageHasEvidence, type LedgerEvidence, type StrengthCounts } from './stage-metrics'

// ─── Stage facts (R20) ──────────────────────────────────────────────────────
// One uniform template for every stage: the 2–4 things the user cares about at
// that stage, as label→value rows. Everything else is the details disclosure
// or the drill-through page's job.

export interface StageFact {
  label: string
  value: string
  /** The stage has not produced this value yet — the tile renders a static dash
   *  in place of the figure (never a bar or a sweep; the pane's status badge
   *  already says whether the stage is live). Only ever set by `awaitingFact`,
   *  so no site can hand-write a tile that carries both a value and a
   *  placeholder. */
  awaiting?: true
  tone?: 'good' | 'warn' | 'bad'
  /** Render the value in the mono face (paths, filenames, commands). */
  mono?: boolean
  /** Hover detail when the visible value is a shortened form (e.g. a path). */
  title?: string
  /** Render the value as a large metric number. Numeric/scalar facts only —
   *  sentence and path values stay in the quiet body size. */
  big?: boolean
  /** A proportional multi-segment bar under a `big` value, for a count that
   *  splits into named parts (passed/failed/aborted, strong/solid/basic/shallow).
   *  One bar shows the whole distribution, where a single fraction could only
   *  show the leading part — and the sub-line then names the parts. Zero-value
   *  segments are dropped, so a clean split doesn't render slivers.
   *
   *  Deliberately the ONLY meter kind: the single-fraction `bar` was removed —
   *  it restated the `N/M` value directly above it, one instance was hardwired
   *  full (`bar: 1`), and the coverage tile's bar measured a different fraction
   *  (progress-to-target) than the percentage it sat under. A distribution is
   *  the one thing the number alone cannot show. */
  segments?: FactSegment[]
  /** The measured second line — a breakdown the data produced (`4 failed · 17
   *  never ran`). Omitted when there is nothing measured to say, in which case
   *  `FACT_GLOSS` supplies the static line instead, so a tile is never one line
   *  shorter than its neighbour. */
  sub?: string
  /** Overrides the label-keyed `FACT_HELP` entry for a tile whose meaning differs
   *  from every other tile carrying the same label. Nothing needs it yet — the
   *  labels that repeat (`Requirements`, `Env files`) repeat the same concept. */
  help?: string
}

/** One slice of a `segments` bar. `tone` reuses the status hues so a colour means
 *  the same thing here as everywhere else; `muted` is for a neutral remainder
 *  (aborted runs, ungraded tests) that is neither good nor bad. */
export interface FactSegment {
  value: number
  tone: 'good' | 'warn' | 'bad' | 'accent' | 'muted'
}

const SEGMENT_TONE: Record<FactSegment['tone'], string> = {
  good: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--danger)',
  accent: 'var(--accent)',
  muted: 'var(--border-strong)',
}

/** The distribution bar: each segment sized by its share of the total. */
export function FactSegments({ segments }: { segments: FactSegment[] }) {
  const shown = segments.filter((s) => s.value > 0)
  const total = shown.reduce((sum, s) => sum + s.value, 0)
  if (total <= 0) return null
  return (
    <div className="mt-2 flex h-[3px] gap-[2px]" aria-hidden>
      {shown.map((s, i) => (
        <span
          key={i}
          className="rounded-full"
          style={{ width: `${(s.value / total) * 100}%`, background: SEGMENT_TONE[s.tone] }}
        />
      ))}
    </div>
  )
}

import { plural } from '@shared/lib/plural'
export { plural }

/** Everything a band needs that the flight record does NOT hold. Resolved once
 *  per visible stage by `useStageBandData` and passed in, so `stageFacts` stays
 *  a pure function of its inputs — and so a tile whose source hasn't loaded (or
 *  doesn't exist for this flight) is simply absent rather than showing a zero.
 *  Every field is optional for exactly that reason. */
export interface StageBandData {
  /** A source below is being fetched for the FIRST time. Settling is about what
   *  the STAGE produced; this is about what the PANE has read, and the two are
   *  a REST round-trip apart — so a settled stage holds its placeholders until
   *  this clears, instead of showing the record-backed tiles alone and growing
   *  the rest under the reader. Never set for a refetch that has a value in
   *  hand (see `useStageBandData`). */
  pending?: boolean
  /** The resolved export task behind an Evaluation Report stage. */
  evalTask?: EvaluationExportTask | null
  /** The feature's coverage ledger — the only source of proven coverage and
   *  per-test strength. */
  ledger?: CoverageLedger | null
  /** The dry-run boot the env-capture stage performed, for its boot span. */
  boot?: RunDetail | null
  /** The portify workflow, for attempts, instances and the overlay diff. */
  portify?: PortifyManifest | null
  /** Counts read off the on-disk feature config. */
  config?: { services: number; portSlots: number } | null
  /** The docs stage's full listing — the docs panel and the requirements fork
   *  render from it so the band's fetch is the only one. */
  docsListing?: FeatureDocsListing | null
  /** Total bytes of the requirement docs the stage collected. */
  docBytes?: number | null
  /** Bytes of the generated `_prd-summary` artifacts — the distilled output the
   *  doc bytes were reduced to. */
  summaryBytes?: number | null
}

/** Boot-proof fact from the env-capture evidence (rendered on the merged
 *  Feature setup row — R32). */
export function bootCheckFacts(envEv: Record<string, unknown>): StageFact[] {
  const captured = num(envEv, 'captured')
  const boot = envEv.boot as { services?: Array<{ name?: string; status?: string }> } | undefined
  const services = boot?.services ?? []
  const failed = services.filter((s) => s.status === 'timeout')
  return [
    ...(captured != null ? [{ label: 'Env files', value: plural(captured, 'file') }] : []),
    ...(services.length > 0
      ? [(() => {
          // A many-service stack summarizes to a count (names ride the
          // tooltip) — 20 comma-joined names is a wall, not a fact.
          const names = (list: typeof services) => list.map((s) => s.name).filter(Boolean)
          const ok = failed.length === 0
          const subject = ok ? services : failed
          const label = names(subject).length <= 3
            ? names(subject).join(', ')
            : `${subject.length} services`
          return {
            label: 'Boot check',
            value: `${label} ${ok ? 'healthy' : 'failed'}`,
            title: `${names(subject).join(', ')} ${ok ? 'healthy' : 'failed'}`,
            tone: ok ? 'good' as const : 'bad' as const,
          }
        })()]
      : []),
  ]
}


/** The export task behind an Evaluation Report stage. Recorded evidence and the
 *  read-time probe both carry the id; `links` is the resume path's only carrier
 *  (its evidence records the reused archive, not the task). Resolving the TASK is
 *  what makes the card and the download work on a derived flight, which has no
 *  record at all. */
export function evaluationTaskId(stage: FlightStage, flight: FlightManifest): string | undefined {
  if (stage.key !== 'evaluation-export') return undefined
  return str(evidenceOf(stage), 'taskId') ?? flight.links?.evaluationTaskId
}

/** The tiles a stage WILL show once it settles, in the order it shows them
 *  (R83). Labels must match the ones the stage's own branch emits exactly — the
 *  point of the list is that a value lands in the slot its placeholder held, so
 *  nothing moves under the reader when the stage finishes.
 *
 *  Three stages are deliberately absent. `run`/`heal` render as the Test Run
 *  hero, which owns every number (R80) — a band of placeholders above it would
 *  promise tiles that never arrive. `similarity` is plumbing the rail hides
 *  unless it parks or fails, and its one tile names a matched suite, which most
 *  flights never have: a placeholder would announce a match as if one were
 *  coming. */
const AWAITED_FACT_LABELS: Partial<Record<FlightStageKey, readonly string[]>> = {
  'scout': ['Repos scanned', 'Services found', 'Port slots drafted'],
  'scaffold': ['Services booted', 'Boot time', 'Env files'],
  'env-capture': ['Env files', 'Boot check'],
  'docs': ['Source docs', 'Requirements inferred', 'Distilled to'],
  'prd-summary': ['Requirements'],
  'specs-coverage': ['Requirements covered', 'Requirements', 'Tests written'],
  'portify': ['Services injectable', 'Files edited', 'Instances proven'],
  'evaluation-export': ['Requirements with tests', 'Test depth', 'Tests that passed', 'Requirements proven'],
}

/** Settled = it has produced everything it ever will, so a placeholder there
 *  would promise more. `failed` is NOT settled: the step stopped short, and the
 *  tiles it never filled are exactly what a retry would fill. */
function stageSettled(stage: FlightStage): boolean {
  return stage.status === 'done' || stage.status === 'skipped'
}

/** A tile whose value the stage hasn't produced yet. The empty `value` is never
 *  read — `FactTile` branches on `awaiting` before it looks at one.
 *
 *  No meter slot is reserved for the labels that settle WITH a `segments`
 *  distribution: an invisible spacer pushed that one tile's gloss 11px below
 *  its neighbours' for the whole wait, a visible track drew a bar for a
 *  measurement nobody made, and the alternative — the row growing once when
 *  real segments land — is a single shift at the moment new content arrives. */
export function awaitingFact(label: string): StageFact {
  return { label, value: '', awaiting: true }
}

/** Fill the tiles the stage will have but hasn't measured yet (R83), so a
 *  pending / running / failed stage shows the SHAPE of its evidence instead of
 *  an empty pane — the layout the user already reads on a settled stage, with
 *  placeholders where the figures go.
 *
 *  A settled stage is returned untouched: `done` and `skipped` have produced
 *  everything they ever will, so a placeholder there would claim a value is
 *  still coming.
 *
 *  The awaited list is the WHOLE band, not a floor under it: a stage that
 *  declares one shows those tiles in that order in every state, and a fact
 *  outside the list is DROPPED while the stage works rather than led with. A
 *  running band used to carry extra tiles nothing settled ever shows — the live
 *  agent phase, the authoring pass, portify's attempt and phase — so the band
 *  the user learned to read at rest was a different band from the one in front
 *  of them mid-flight, and the figure they were waiting for kept moving as the
 *  transient tiles came and went. Those live facts all have a home of their own
 *  further down the pane (the passes card, the state line, the Activity panel);
 *  the band's job is the settled shape, with placeholders where figures land. */
export function withAwaitingTiles(
  stage: FlightStage,
  companion: FlightStage | undefined,
  known: StageFact[],
  /** A band source has not been READ yet (`StageBandData.pending`). A settled
   *  stage keeps its placeholders while this holds: the tiles fed by the flight
   *  record are ready a fetch before the ones fed by the ledger, boot run or
   *  config, and dropping the latter meanwhile re-widths every tile in the grid
   *  the moment they land. It also stops the fallback tile a stage substitutes
   *  for a missing source (`Coverage gaps` for `Requirements`) from taking a
   *  slot for one frame and being relabelled in the next. */
  pending = false,
): StageFact[] {
  // A merged row settles when BOTH halves do. Reading the primary alone told the
  // Suite setup row it was finished while its env capture had not started — the
  // row said `pending`, and its band showed one lonely tile where the two the
  // capture still owes belong.
  if (stageSettled(stage) && (!companion || stageSettled(companion)) && !pending) return known
  const awaited = AWAITED_FACT_LABELS[stage.key]
  if (!awaited) return known
  const byLabel = new Map(known.map((f) => [f.label, f]))
  return awaited.map((label) => byLabel.get(label) ?? awaitingFact(label))
}

/** The band is the stage's SETTLED tile set in every state — see
 *  `withAwaitingTiles`. The live agent's phase (thinking / writing / a tool
 *  call) is not part of it: it belongs to the state line under the stage title
 *  (`StageStatusLines`) and to the Activity panel, both of which show it with
 *  more detail and without displacing a figure the user is waiting on. */
export function stageFacts(
  stage: FlightStage,
  flight: FlightManifest,
  companion?: FlightStage,
  /** Sources outside the flight record (see StageBandData). Absent fields drop
   *  their tile — the band never pads itself to a fixed width. */
  band: StageBandData = {},
): StageFact[] {
  return withAwaitingTiles(stage, companion, measuredStageFacts(stage, flight, companion, band), band.pending)
}

/** What the stage has actually measured — evidence, live progress and the band's
 *  outside sources. Absent values drop their tile here; `withAwaitingTiles` is
 *  what turns those holes into placeholders. */
function measuredStageFacts(
  stage: FlightStage,
  flight: FlightManifest,
  companion?: FlightStage,
  band: StageBandData = {},
): StageFact[] {
  const evalTask = band.evalTask
  const ev = evidenceOf(stage)
  const cev = evidenceOf(companion)
  // A pending step normally has nothing to show — EXCEPT when its artifacts were
  // probed from the workspace, which means they exist on disk even though the step
  // never completed (specs authored, no requirements to map them onto). Hiding
  // those facts would misreport a part-done step as untouched.
  // `scout` is exempt: its first tile counts the repos the USER named when the
  // flight was launched, which is flight input rather than stage evidence. It is
  // as true before the scan as after, so hiding it would put a placeholder where
  // a known figure belongs.
  if (stage.status === 'pending' && stage.evidenceSource !== 'workspace' && stage.key !== 'scout') return []
  switch (stage.key) {
    case 'similarity': {
      const match = ev.match as Record<string, unknown> | null | undefined
      return match && typeof match.feature === 'string'
        ? [{ label: 'Matches', value: match.feature }]
        : []
    }
    case 'scout': {
      // What the scan FOUND, as counts. The identities behind each count —
      // repo names, locations, per-repo env files — live on the RepoScanPanel's
      // cards below (R72c); repeating a name here would just be that card in a
      // smaller font.
      // No env-file count here: the capture that acts on it happens a stage
      // later, and Suite setup already reports the captured/declared ratio —
      // this band would just be that number, a stage early and without the
      // outcome attached. The declared list still reads in the state line.
      return [
        { label: 'Repos scanned', value: String(distinctRepoPaths(flight.repoPaths).length), big: true },
        ...(band.config ? [{ label: 'Services found', value: String(band.config.services), big: true as const }] : []),
        ...(band.config ? [{ label: 'Port slots drafted', value: String(band.config.portSlots), big: true as const }] : []),
      ]
    }
    case 'scaffold': {
      // This stage CONFIGURES, so its settings are not its evidence: the worker
      // count and the service list are inputs the user can edit six inches
      // below, and counting them here measures nothing. What it actually proved
      // is that the suite comes up — so the band reports the boot proof, how
      // long that took, and whether the env it booted with is complete. The
      // suite name and whether it was reused already read in the state line.
      // The boot RUN is the better source than the cached evidence: it exists
      // for probed stages too (found by feature), and it carries per-service
      // ports and timings the evidence never held. Evidence is the fallback for
      // a run whose directory has since been cleaned away.
      const recorded = cev.boot as { services?: Array<{ name?: string; status?: string }> } | undefined
      const services: Array<{ status?: string }> = band.boot?.manifest.services ?? recorded?.services ?? []
      // "Came up" = anything that isn't a failed readiness probe. A service torn
      // down after the check passed (`stopped` — what env-capture always leaves
      // behind) still came up.
      const booted = services.filter((s) => s.status !== 'timeout' && s.status !== 'queued').length
      const bootMs = bootDurationMs(band.boot?.lifecycleEvents)
      const capturedFiles = num(cev, 'captured')
      return [
        ...(services.length > 0
          ? [{
              label: 'Services booted',
              value: `${booted}/${services.length}`,
              big: true as const,
              tone: booted === services.length ? 'good' as const : 'bad' as const,
            }]
          : []),
        ...(bootMs != null
          ? [{
              label: 'Boot time',
              value: formatDuration(bootMs),
              big: true as const,
              sub: 'every run waits this long first',
            }]
          : []),
        ...envFileFacts(flight, capturedFiles),
      ]
    }
    case 'env-capture':
      // Folded into the scaffold row (R32); kept for completeness if a caller
      // renders the stage standalone.
      return bootCheckFacts(ev)
    case 'docs': {
      // Counts, not filenames. The old band spent a tile per doc printing
      // `okr.md`, `sms_prod_conversation.md` — the same names the Requirement
      // docs card lists directly below with their sizes, so the band was a
      // worse copy of the card. What the band adds is the SHAPE of the work,
      // read left to right in the order the work happened: how many docs went
      // in, how many requirements came out, and how much text that took in and
      // left behind.
      const recordedDocs = Array.isArray(ev.docs) ? (ev.docs as unknown[]).filter((d): d is string => typeof d === 'string') : []
      // Prefer the LIVE listing's source-doc count: the recorded evidence is a
      // point-in-time snapshot while the byte sub-line beside it is live, and a
      // doc added or deleted after the flight made one tile describe two
      // different states of the workspace. The evidence stands in when the
      // listing hasn't resolved (or the band wasn't given one) — and when the
      // listing is EMPTY: the flight read those docs whether or not they still
      // exist, so a later cleanup must not erase the record of what went in.
      const liveDocs = band.docsListing?.docs.filter((d) => !d.generated)
      const docs = liveDocs?.length ? liveDocs : recordedDocs
      const count = num(cev, 'requirementCount')
      // Tokens is an ESTIMATE (four chars each), so it renders with a `≈` and
      // never claims to be the measured figure the byte count is.
      const tokens = band.docBytes != null ? estimateTokens(band.docBytes) : null
      const summaryTokens = band.summaryBytes != null && band.summaryBytes > 0 ? estimateTokens(band.summaryBytes) : null
      // EVERY TILE CARRIES ITS OWN WEIGHT. The band used to hold all four size
      // figures on one tile's sub-line (`tokens · from ≈ 3.3k · 12.9 KB → 3.2 KB`),
      // which put the input's weight two tiles away from the input and left the
      // reader matching each figure to an end of an arrow. Now the source tile
      // states what the source weighs and the output tile states what the output
      // weighs, each as `≈ tokens · KB` in that one order, so the three tiles read
      // left to right as: this much text went in → this many requirements came out
      // → and they weigh this much.
      return [
        ...(docs.length > 0
          ? [{
              label: 'Source docs',
              value: String(docs.length),
              big: true as const,
              // The weight of what went in, on the tile that counts what went in.
              ...(tokens != null && band.docBytes != null
                ? { sub: `≈ ${compactCount(tokens)} tokens · ${formatBytes(band.docBytes)}` }
                : {}),
            }]
          : []),
        ...(count != null ? [{ label: 'Requirements inferred', value: String(count), big: true as const }] : []),
        ...(summaryTokens != null && band.summaryBytes != null
          ? [{
              label: 'Distilled to',
              value: `≈ ${compactCount(summaryTokens)}`,
              big: true as const,
              // Unit first so the 22px value stays a bare figure, then the measured
              // byte count the estimate approximates, then the compression — the one
              // hint on this screen that the distillation may have dropped
              // something. The ratio is computed from the MEASURED bytes, not the
              // token estimates, and is omitted rather than printed as a negative
              // when a summary somehow came out bigger than its source.
              sub: [
                `tokens · ${formatBytes(band.summaryBytes)}`,
                ...(band.docBytes != null && band.summaryBytes < band.docBytes
                  ? [`${round((1 - band.summaryBytes / band.docBytes) * 100)}% smaller`]
                  : []),
              ].join(' · '),
            }]
          : []),
        // No docs listed but bytes measured: nothing above carries the source
        // weight, so it gets its own tile rather than going unreported.
        ...(docs.length === 0 && tokens != null && band.docBytes != null
          ? [{
              label: 'Source text',
              value: `≈ ${compactCount(tokens)}`,
              big: true as const,
              sub: `tokens · ${formatBytes(band.docBytes)}`,
            }]
          : []),
      ]
    }
    case 'prd-summary': {
      const count = num(ev, 'requirementCount')
      return count != null ? [{ label: 'Requirements', value: String(count) }] : []
    }
    case 'specs-coverage': {
      const p = specsCoverageProgress(stage)
      // Evidence lands when the stage settles; while the loop runs the same
      // facts come from the live progress shape.
      const evPct = num(ev, 'coveragePct')
      const pct = evPct ?? p?.coveragePct ?? null
      // The mapper runs at the END of a pass, so while the authoring agent works
      // `progress.coveragePct` is still the ledger the pass STARTED from. On a
      // first flight that start is 0 — and rendering it as an amber "0%" for the
      // several minutes authoring takes states a measurement nobody made: it
      // reads as a suite that covers nothing, when the truth is nothing has been
      // measured yet. Suppressed ONLY for a zero no mapping has produced (the
      // awaited-tile placeholder takes the slot, R83); a measured 0% still shows,
      // and any non-zero came from a real ledger.
      const everMapped = p?.passes.some((entry) => typeof entry.coveragePct === 'number') ?? false
      const unmeasured = stage.status === 'running' && evPct == null && pct === 0 && !everMapped
      const gapRows = Array.isArray(ev.gaps) ? (ev.gaps as Array<{ gap?: string }>) : null
      const gaps = gapRows ? gapRows.length : p?.gapsOpen ?? null
      // R35: name the gap kinds, not just the count ("2 untested, 1 path-incomplete").
      const byKind = new Map<string, number>()
      for (const g of gapRows ?? []) {
        if (typeof g.gap === 'string') byKind.set(g.gap, (byKind.get(g.gap) ?? 0) + 1)
      }
      const breakdown = [...byKind].map(([kind, n]) => `${n} ${kind}`).join(' · ')
      const target = flight.opts.coverageTarget
      const totals = band.ledger?.totals
      // A probed suite with no requirements has UNDEFINED coverage, not 0%. The
      // percentage tile (amber, empty bar) would read as a failing suite when the
      // truth is there is no PRD to measure its specs against.
      if (stage.evidenceSource === 'workspace' && num(ev, 'total') === 0) {
        // Its own second line, not the label's gloss: "what the documents asked
        // for" under "None mapped yet" reads as a contradiction, when the truth
        // is there were no documents to ask.
        return [{ label: 'Requirements', value: 'None yet', sub: 'no requirement docs for this suite' }]
      }
      // No "Authoring pass N of M" tile: the loop's position is the PASSES card's
      // whole subject, one card below, where each pass carries its own verdict —
      // and M is a ceiling the loop rarely reaches, so a stepper in the band read
      // as four more rounds scheduled rather than four allowed.
      return [
        ...(pct != null && !unmeasured
          ? [{
              label: 'Requirements covered',
              value: `${pct}%`,
              big: true as const,
              tone: pct >= target ? 'good' as const : 'warn' as const,
            }]
          : []),
        // How many requirements exist at all — the denominator the percentage
        // alone never gave. The SPLIT (which kind of gap the rest are) is the
        // CoverageCompositionPanel's job, one card below: five buckets across two
        // populations do not fit a 10.5px sub-line, and forcing them through one
        // meant merging the two amber gap kinds into a single bar segment.
        //
        // While the loop runs there is no ledger yet, so the older gap COUNT
        // stands in; it answers less, but it is what live progress can support.
        ...(totals && totals.total > 0
          ? [{ label: 'Requirements', value: String(totals.total), big: true as const }]
          : gaps != null
            ? [{
                label: 'Coverage gaps',
                value: gaps === 0 ? '0' : String(gaps),
                big: true as const,
                ...(breakdown && gaps > 0 ? { sub: breakdown } : {}),
                tone: gaps === 0 ? 'good' as const : 'warn' as const,
              }]
            : []),
        // How many specs the authoring produced. Read off the ledger's mapped
        // tests, which is the set the coverage percentage was computed over — so
        // the two tiles describe the same population. Their DEPTH is on the
        // composition card; the spec-file count stays as the sub for a suite with
        // no requirements, which has no composition card to fall back to.
        ...(band.ledger && band.ledger.tests.length > 0
          ? [{
              label: 'Tests written',
              value: String(band.ledger.tests.length),
              big: true as const,
              ...(!totals || totals.total === 0
                ? specFileCount(band.ledger) != null
                  ? { sub: `across ${plural(specFileCount(band.ledger)!, 'test file')}` }
                  : {}
                : {}),
            }]
          : []),
      ]
    }
    case 'portify': {
      // R35: verdict → proof → what changed, in that order.
      // Skipped with nothing to show is the whole statement. Skipped with
      // evidence is not: resuming a flight mid-pipeline marks every earlier
      // stage skipped, so this sentence replaced a fully-populated band —
      // injectable count, double-boot proof, port changes — the moment the user
      // continued from a later step. Evidence outranks the skip; the rail draws
      // the same distinction (see railStatus).
      if (stage.status === 'skipped' && !stageHasEvidence(stage.evidence)) {
        return [{ label: 'Parallel', value: 'Already checked — safe to run two at once', tone: 'good' }]
      }
      // No live attempt/phase tiles while running: neither survives into the
      // settled band, and the same two facts are already on the state line and
      // the embedded portify timeline below. The band holds its three awaited
      // placeholders until the workflow measures them.
      // Natively concurrency-ready: every start command already declares a port
      // slot, so portify had nothing to rewrite and left no workflow to read.
      // That is a real, reportable outcome — without it the stage rendered
      // ticked and completely empty, which reads as a broken panel rather than
      // as "nothing needed doing".
      const declared = num(ev, 'declaredInjectable')
      const declaredOf = num(ev, 'serviceCount')
      if (declared != null && declaredOf != null && declaredOf > 0) {
        // A port slot in the config is a DECLARATION, not proof. Portify proves
        // concurrency by booting the whole suite twice at once on two disjoint
        // port maps and requiring both to come up — that is what "Instances
        // proven" counts, and nothing here has done it. So no `tone: 'good'`
        // (the verified hue) and no borrowed "Files edited: 0": both would read
        // as a verdict this evidence cannot support. The empty proof tile is the
        // point — it says which half is missing instead of hiding it.
        return [
          { label: 'Services injectable', value: `${declared}/${declaredOf}`, big: true, sub: "set in this suite's settings" },
          { label: 'Instances proven', value: '—', sub: 'nothing has started two copies yet' },
        ]
      }
      if (typeof ev.workflowId !== 'string') return []
      // The old band was three sentences ("Safe — services boot side by side",
      // "Concurrent double boot, both green", "Applied (overlay)") — a verdict
      // restated three ways, with no way to see how much was edited or how hard
      // it was to get there. The verdict now rides the state line; the band
      // reports the size of the work and the strength of the proof.
      const wf = band.portify
      const instances: PortifyBootInstance[] = wf?.verification?.instances ?? []
      const instancesOk = instances.filter((i) => i.ok).length
      const diff = overlayDiffStat(wf?.diff)
      const repos = wf?.repos.length ?? null
      return [
        ...(repos != null
          ? [{
              label: 'Services injectable',
              value: `${repos}/${repos}`,
              big: true as const,
              tone: 'good' as const,
            }]
          : []),
        ...(diff
          ? [{
              label: 'Files edited',
              value: String(diff.files),
              big: true as const,
              sub: `+${diff.added} −${diff.removed} lines`,
            }]
          : [{ label: 'Files edited', value: ev.edits ? '—' : '0', big: true as const, ...(ev.edits ? {} : { tone: 'good' as const, sub: 'ports were already swappable' }) }]),
        ...(instances.length > 0
          ? [{
              label: 'Instances proven',
              value: `${instancesOk}/${instances.length}`,
              big: true as const,
              tone: instancesOk === instances.length ? 'good' as const : 'bad' as const,
              sub: instancesOk === instances.length ? 'started side by side' : 'one copy failed to start',
            }]
          : []),
        // Deliberately NOT here: the attempt count. While the stage runs it is the
        // news, and the running branch above carries it — but once this settled,
        // how many tries it took says how hard canary worked, not whether the
        // suite is safe to run in parallel, which is what the three tiles above
        // answer. The same reason the authoring-pass count left its band.
      ]
    }
    case 'run':
      // R80: the run is rendered ONCE, as the Test Run hero (TestRunPanel) — it
      // owns the verdict, pass count, repairs, services and give-up reason as a
      // single object. Emitting stage facts here too would print the same
      // numbers a second time in the "At a glance" card above the hero, which is
      // exactly the duplication the hero replaced. So: no stage-level facts.
      return []
    case 'evaluation-export': {
      // The band answers "what did we actually verify" — the one question no
      // earlier stage answers. It is deliberately a DERIVATION, and it reads left
      // to right as one sentence with its arithmetic shown:
      //
      //   every requirement has a spec claiming it  (what we set out to prove)
      //   → the specs are mostly shallow            (how strong that proof can be)
      //   → 2 of them passed in the run             (what actually held)
      //   → so 0 requirements come out proven       (the conclusion)
      //
      // WHY THE INPUTS ARE RESTATED HERE. Coverage is bookkeeping over
      // annotations: a requirement is `covered` the moment some spec's `@req-*` /
      // `@path-*` tags claim its every path, and no run is consulted — so a suite
      // whose every spec fails still reports 100%. `proven` re-judges the same
      // requirement through a second gate: every path backed by a spec that
      // PASSED. The conclusion is therefore unreadable without both gates on
      // screen; showing only `0/6` made a reader ask why, which is what this
      // ordering fixes. The old band led with that conclusion and buried the
      // first gate in a `100% claimed, 0% proven` sub-line — two terms of art in
      // a 10.5px line, on the one surface a non-author reads first.
      //
      // Still deliberately NOT here: the RUN's own pass/fail totals (R80 — those
      // are the Test Run's, and reprinting them made this band a second run
      // summary). The specs tile is not that number: it counts only the specs
      // annotated to a requirement, the population that can move the proven axis
      // at all, on the same join the proven tile reads. Nor the archive's SIZE,
      // which measured the download rather than the verification — that sits on
      // the deliverable card beside the filename and the button it describes.
      const led = ledgerEvidence(band.ledger)
      const reportRunId = evalTask?.runId ?? str(ev, 'runId')
      const bandFacts: StageFact[] = [
        // GATE ONE, run-blind, so it renders even with no run joined: the claim
        // the coverage stage made. This is `claimedPct` as a count over the same
        // denominator the proven tile uses, which is what lets the two ends of
        // the band be compared at a glance instead of across a unit change.
        ...(led
          ? [{
              label: 'Requirements with tests',
              value: `${led.covered}/${led.total}`,
              big: true as const,
              tone: led.covered === led.total ? 'good' as const : 'warn' as const,
              sub: claimedSub(led),
            }]
          : []),
        ...(led && led.strength.strong + led.strength.solid + led.strength.basic + led.strength.shallow > 0
          ? [(() => {
              const head = strengthHeadline(led.strength)
              return {
                label: 'Test depth',
                value: head.value,
                big: true as const,
                // The whole distribution, strongest to weakest: a suite that is
                // 2 strong and 16 shallow reads very differently from one that
                // is 2 strong and 2 shallow, and the headline number alone
                // hides it.
                segments: strengthSegments(led.strength),
                sub: strengthBreakdown(led.strength, head.tier),
              }
            })()]
          : []),
        // What the run did with the specs that can carry proof. Gated on the
        // proven axis existing: with no run joined, every mapped spec would
        // report as "never ran", which reads as a finding about the suite when it
        // is only the absence of a run.
        //
        // The foreign-run caveat is stated once, on the conclusion tile: both
        // tiles read the same join, and saying it twice in two 10.5px sub-lines
        // buries the numbers it qualifies.
        ...(led && led.proven != null && led.specs.mapped > 0
          ? [{
              label: 'Tests that passed',
              value: `${led.specs.passed}/${led.specs.mapped}`,
              big: true as const,
              tone: led.specs.passed === led.specs.mapped ? 'good' as const : 'warn' as const,
              sub: passedSub(led),
            }]
          : []),
        // GATE TWO — the conclusion, last, because it is what the three tiles to
        // its left add up to.
        ...(led && led.proven != null
          ? [{
              label: 'Requirements proven',
              value: `${led.proven}/${led.total}`,
              big: true as const,
              tone: led.proven === led.total ? 'good' as const : 'warn' as const,
              sub: provenSub(led, reportRunId),
            }]
          : []),
      ]
      if (bandFacts.length > 0) return bandFacts
      // No ledger and no recorded archive (an older export, or a feature with no
      // PRD): fall back to naming the deliverable rather than showing nothing.
      return evaluationIdentityFacts(ev, evalTask)
    }
    default:
      return []
  }
}

/** The claim tile's sub-line: what "has specs" actually required. A requirement
 *  is covered only when EVERY path it declares is claimed by some spec's tags, so
 *  the clean case names that bar rather than restating the fraction above it —
 *  and the incomplete case says how many fell short of it. */
function claimedSub(led: LedgerEvidence): string {
  const gaps = led.total - led.covered
  if (gaps <= 0) return 'every path has a test'
  return `${gaps} not fully covered`
}

/** What became of the specs that can carry proof. Empty buckets drop out, and a
 *  clean sweep says so rather than leaving the tile bare — "18/18" with no
 *  sub-line reads as a truncated tile.
 *
 *  The unmapped count is named whenever there is one: this tile's denominator
 *  counts only specs annotated to a requirement, so a suite with unannotated
 *  specs would otherwise read as a smaller suite than it is. It is the one place
 *  the band can say so without a fifth tile.
 *
 *  Two honesty caveats displace the clean-sweep line when they apply: a pass
 *  that needed a Playwright retry is a flake, not a clean pass, and a summary
 *  merged forward across partial heal reruns never saw all its passes in one
 *  execution. Both come off the run's own summary (never re-derived here), and
 *  "every test passed" without them would be the exact rounding-up this band
 *  exists to prevent. */
function passedSub(led: LedgerEvidence): string {
  const { specs } = led
  const parts = [
    ...(specs.failed > 0 ? [`${specs.failed} failed`] : []),
    ...(specs.neverRan > 0 ? [`${specs.neverRan} never ran`] : []),
    ...(specs.passedOnRetry > 0 ? [`${specs.passedOnRetry} passed on a retry`] : []),
    ...(led.testCount > specs.mapped ? [`${led.testCount - specs.mapped} unlabelled`] : []),
  ]
  // "labelled" names the tile's population even on a clean sweep — the
  // denominator is the requirement-labelled tests, not the whole suite, and
  // beside two requirement-counting tiles an unnamed 15/15 read as arithmetic
  // gone wrong.
  const line = parts.length > 0 ? parts.join(' · ') : 'every labelled test passed'
  return led.spansExecutions ? `${line} · across partial runs` : line
}

/** The conclusion tile's sub-line — the RULE that turns the three tiles to its
 *  left into this number, which is the one thing they cannot show. A suite can
 *  have every requirement claimed and two specs passing and still prove nothing,
 *  because a requirement counts only when every path it declares is backed by a
 *  spec that passed. Without that sentence the arithmetic looks broken.
 *
 *  The engine joins the proven axis against the feature's LATEST recorded run,
 *  which is this report's run right after an export and stops being it the moment
 *  the suite runs again. When the ledger's run and the report's run differ, that
 *  caveat displaces the rule: a number attributed to the wrong run is a worse
 *  problem than an unexplained one, and the deliverable card underneath names the
 *  report's own run a few inches below. */
// `reportRunId` admits null as well as undefined because its two sources differ:
// `evalTask?.runId` is absent-as-undefined, while `str(ev, …)` reports a missing
// evidence key as null. The body already treats both as "unknown" via `!= null`,
// so the signature says so rather than the caller coercing one into the other.
function provenSub(led: LedgerEvidence, reportRunId: string | null | undefined): string {
  if (led.provenRunId != null && reportRunId != null && led.provenRunId !== reportRunId) {
    return `measured on run ${led.provenRunId}, not this one`
  }
  if (led.proven != null && led.proven === led.total) return 'every requirement had a test that passed'
  return 'each path needs a test that passed'
}

/** The Evaluation Report's pre-band fallback: name the deliverable when there
 *  are no measurements to show (no ledger, and an archive exported before its
 *  contents were recorded). A conducted flight records its own evidence and a
 *  derived one is probed at read time, but both read the export TASK — the thing
 *  the download actually fetches and the only source the two paths share.
 *
 *  The archive is named as the user will receive it, from the same helper that
 *  sets `link.download` — never `export.zip`, which is only the internal
 *  filename inside the logs dir and a file nobody has ever been handed. */
function evaluationIdentityFacts(
  ev: Record<string, unknown>,
  evalTask: EvaluationExportTask | null | undefined,
): StageFact[] {
  const runId = evalTask?.runId ?? str(ev, 'runId')
  const mode = evalTask?.mode ?? str(ev, 'mode')
  const recordedBase = str(ev, 'archiveBase')
  const archive = evalTask
    ? evaluationArchiveFilename(evalTask.feature, evalTask.runId)
    : recordedBase ? `${recordedBase}.zip` : null
  return [
    ...(runId ? [{ label: 'From run', value: runId, mono: true }] : []),
    ...(mode ? [{ label: 'Report', value: mode === 'localized' ? 'written by an agent' : 'built from the run' }] : []),
    ...(archive ? [{ label: 'Archive', value: archive, mono: true, title: archive }] : []),
  ]
}

/** Suite setup's env tile: how many of the env files the app declared were
 *  actually captured into the envset.
 *
 *  This replaced a count of env KEYS (which read in the hundreds on a Spring
 *  stack). That number measured the size of the user's own config surface, not
 *  anything this flight did, and nothing the user could act on changed with it —
 *  while putting a four-figure tally next to the word "captured" made the tile
 *  read as a secrets inventory. The ratio is the fact that matters: a missing-env
 *  checkpoint can be WAIVED, letting a flight boot with fewer files than the app
 *  asked for, and that shortfall resurfaces much later as a service that won't
 *  come up or a test that can't reach one. `2/3` says so at a glance.
 *
 *  The scan's declared list is the denominator. A probed record has no scan
 *  evidence to compare against, so it reports the captured count alone rather
 *  than inventing a total. */
function envFileFacts(flight: FlightManifest, captured: number | null): StageFact[] {
  if (captured == null) return []
  const scoutEv = evidenceOf(flight.stages.find((s) => s.key === 'scout'))
  const declared = Array.isArray(scoutEv.envFiles) ? scoutEv.envFiles.length : null
  if (declared == null || declared <= 0) {
    return [{ label: 'Env files', value: String(captured), big: true, sub: 'copied in for Canary' }]
  }
  const complete = captured >= declared
  return [{
    label: 'Env files',
    value: `${captured}/${declared}`,
    big: true,
    tone: complete ? 'good' : 'bad',
    sub: complete ? 'all the app asked for' : `${declared - captured} skipped or missing`,
  }]
}

/** How many distinct spec FILES the ledger's tests live in. Null when the ledger
 *  records no locations (older mappings), so the sub-line is omitted rather than
 *  claiming one file. */
function specFileCount(ledger: CoverageLedger): number | null {
  const files = new Set(ledger.tests.map((t) => t.file).filter((f): f is string => Boolean(f)))
  return files.size > 0 ? files.size : null
}

/** `1234` → `1.2k`. Used for token estimates, where the exact digit is noise. */
function compactCount(n: number): string {
  if (n < 1000) return String(n)
  const thousands = n / 1000
  return `${thousands < 10 ? Math.round(thousands * 10) / 10 : Math.round(thousands)}k`
}

/** Coverage percentages carry one decimal; a band tile wants the integer. */
function round(pct: number): number {
  return Math.round(pct)
}

/** The strength distribution bar, strongest to weakest. Shared by the two tiles
 *  that report depth (Test authoring's specs, the Evaluation Report's evidence) so
 *  a colour means the same thing in both. */
function strengthSegments(strength: StrengthCounts): FactSegment[] {
  return [
    { value: strength.strong, tone: 'good' },
    { value: strength.solid, tone: 'accent' },
    { value: strength.basic, tone: 'warn' },
    { value: strength.shallow, tone: 'bad' },
    { value: strength.ungraded, tone: 'muted' },
  ]
}

const STRENGTH_TIERS = ['strong', 'solid', 'basic', 'shallow', 'ungraded'] as const

/** The depth tile's headline: the count of the BEST tier the suite actually
 *  reached. It used to be hardwired to `N strong` — but the strong tier needs a
 *  non-local URL (strength.ts), so every localhost suite led with a permanent
 *  "0 strong", a zero presented as the finding when it is a structural ceiling.
 *  Leading with the best achieved tier reports what the suite IS. */
function strengthHeadline(strength: StrengthCounts): { value: string; tier: (typeof STRENGTH_TIERS)[number] } {
  const tier = STRENGTH_TIERS.find((t) => strength[t] > 0) ?? 'ungraded'
  return { value: `${strength[tier]} ${tier}`, tier }
}

/** The strength buckets below the headline, strongest first, omitting empty
 *  ones and the headline's own bucket (the only caller leads with it as the
 *  value, so repeating it would print the same figure twice). Ungraded tests
 *  are named as ungraded rather than folded into the weakest bucket — an
 *  unmeasured test is not a shallow one. */
function strengthBreakdown(strength: StrengthCounts, omit: (typeof STRENGTH_TIERS)[number]): string | undefined {
  const parts = STRENGTH_TIERS
    .filter((t) => t !== omit && strength[t] > 0)
    .map((t) => `${strength[t]} ${t}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

// ─── What a tile MEANS, keyed by its label ──────────────────────────────────
// Two maps, both keyed on the tile's label rather than threaded through the 30
// branch sites above. The label is already this file's identity key — it is what
// `AWAITED_FACT_LABELS` matches a placeholder to its eventual value on — so
// keying here means a tile that has not been measured yet still carries its
// explanation and its second line, which nothing passed per-branch could give.
//
// Labels that repeat across stages (`Requirements`, `Env files`, `Files edited`)
// repeat the same CONCEPT, so one entry serves them all. A tile whose meaning
// genuinely diverges sets `help` on the fact itself.

/** The hover explanation behind the `?`: what the figure is counted from, and
 *  the catch a reader would otherwise have to discover. Two sentences at most —
 *  the tooltip is 260px wide and it is read standing up, not studied.
 *
 *  A label with no entry renders NO `?` and no tooltip: the mark promises an
 *  explanation, and one with nothing behind it is worse than none. */
export const FACT_HELP: Record<string, string> = {
  // Scout
  'Matches': 'Another suite already tests this app. Reuse it instead of making a new one.',
  'Repos scanned': 'The code folders you picked. Canary reads each one to see how the app starts.',
  'Services found': 'The apps and servers Canary found. Every test run starts all of them first.',
  'Port slots drafted': 'A port Canary can change per run, so two runs never fight over the same one.',
  // Suite setup
  'Services booted': 'How many started and answered. If any did not, a test will hit a missing service.',
  'Boot time': 'How long the app takes to start. Every run waits this long before testing.',
  'Env files': 'The app’s startup settings, copied for Canary. A missing one breaks a service later.',
  'Boot check': 'Did each service start and answer? One shut down afterwards still counts as fine.',
  // Requirements
  'Source docs': 'The files Canary read — briefs, specs, notes. The requirements come only from these.',
  'Source text': 'How much text those files hold. The token figure is a rough estimate, not a count.',
  'Requirements inferred': 'One thing the app must do, small enough to test. Everything later is scored against these.',
  'Requirements': 'One thing the app must do, small enough to test. Everything later is scored against these.',
  'Distilled to': 'The short summary agents read instead of the full files. Tokens are a rough estimate.',
  // Test authoring
  'Requirements covered': 'Counted from labels in the test files. Nothing was run, so every test could still be failing.',
  'Coverage gaps': 'Requirements with no test yet, or only part of one. The next pass goes after these.',
  'Tests written': 'Tests labelled with a requirement. Unlabelled tests still run, they just are not counted here.',
  // Parallel readiness
  'Parallel': 'Can two runs of this suite start at once without fighting over a port? Checked once.',
  'Services injectable': 'The service reads its port from settings instead of having it fixed in the code.',
  'Files edited': 'Changes Canary made so ports can be swapped. Kept as a patch you can undo.',
  'Instances proven': 'Two copies of the app ran at once and both answered. That is the real proof.',
  // Test run history
  'Runs performed': 'Every run Canary kept for this suite, not just this flight’s.',
  'Succeeded': 'Runs where every test passed. A stopped run counts as neither a pass nor a fail.',
  'Avg duration': 'Average time a finished run took, startup included. Runs still going are left out.',
  'Repair cycles': 'One cycle: tests fail, an agent fixes the app, the tests run again. It never edits the test.',
  // Evaluation report
  'Requirements with tests': 'Counted from labels in the test files. Nothing was run to check they work.',
  // All four tiers defined where the words are shown — the same definitions the
  // Composition card's hover titles carry (STRENGTH_TIER_HELP). The strong tier
  // needs a non-local URL, so a local-only suite genuinely tops out at solid;
  // saying so keeps its ceiling from reading as a defect.
  'Test depth': 'How much each test really checks. Strong — a real browser or outside system confirmed it. Solid — the app’s own API or UI said so. Basic — a database row changed. Shallow — only the app’s own log. Strong needs a non-local URL, so a local-only suite tops out at solid.',
  'Tests that passed': 'Only tests labelled with a requirement. They are the only ones that can prove anything.',
  'Requirements proven': 'A test has to exist and pass for every declared path. Depth is reported separately — a shallow pass still proves.',
  'From run': 'The test run this report came from.',
  'Report': 'From the run: the numbers straight off it. Agent-written: an agent put them into words.',
  'Archive': 'The zip you download — the evidence, the run’s results, and the report.',
}

/** The static second line, used only when the fact carries no measured `sub`.
 *  Plain words, no jargon, and short enough for a 10.5px line at a 140px tile —
 *  it says what the figure is FOR, where the tooltip says how it is counted.
 *
 *  Deliberately absent for the identity tiles (`From run`, `Archive`, `Report`)
 *  and the sentence-valued ones (`Matches`, `Parallel`): their value already
 *  reads as a phrase, and a gloss under a filename is noise.
 *
 *  Every label in `AWAITED_FACT_LABELS` MUST have an entry: the gloss is what
 *  keeps a row of placeholder tiles the same height (the equal-height invariant
 *  on `StageFact.sub`), and a hole here is a band whose tiles sit at three
 *  different heights while the stage works. `Boot check` is sentence-valued but
 *  awaited, so it carries one for exactly that reason. */
export const FACT_GLOSS: Record<string, string> = {
  'Repos scanned': 'you picked these at the start',
  'Services found': 'every run starts all of them',
  'Port slots drafted': 'so two runs never clash',
  'Services booted': 'checked on a test start',
  'Boot time': 'every run waits this long first',
  'Env files': 'the app’s startup settings',
  'Boot check': 'did every service answer',
  'Source docs': 'where the requirements came from',
  'Requirements inferred': 'things the app must do',
  'Distilled to': 'the short version agents read',
  'Test depth': 'how much each test checks',
  'Requirements': 'what the documents asked for',
  'Requirements covered': 'a test claims it — nothing has run yet',
  'Coverage gaps': 'no test covers these yet',
  'Tests written': 'written for the requirements',
  'Services injectable': 'each gets its port from the run',
  'Files edited': 'fixed ports swapped out',
  'Instances proven': 'two copies ran at once',
  'Requirements with tests': 'claimed by a test’s label',
  'Tests that passed': 'in the run this report reads',
  'Requirements proven': 'a passing test backs every path',
  'Runs performed': 'this suite’s whole history',
  'Succeeded': 'every test passed',
  'Avg duration': 'finished runs only',
  'Repair cycles': 'fail, fix the app, run again',
}

export const FACT_TONE: Record<NonNullable<StageFact['tone']>, string> = {
  good: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--danger)',
}

/** The stand-in for a figure the stage hasn't produced (R83). Sized to the
 *  22px metric line it replaces, so the tile keeps its height and the value
 *  lands in place instead of pushing the card down when the stage settles.
 *
 *  Always the dash a reader already knows as "no value" — never a skeleton bar
 *  or a sweep. A bar where a figure goes reads as a measurement, and a live
 *  pane already announces itself through its status badge, so animating every
 *  tile adds motion without information. Hue says how the slot emptied:
 *  muted while it is merely held open, `--danger` once the step stopped short
 *  of filling it. */
export function FactPlaceholder({ awaiting }: { awaiting: AwaitingState }) {
  return (
    <div
      className="mt-1 flex h-[22px] items-center"
      data-testid="fact-awaiting"
      data-awaiting={awaiting}
      // role="img": an aria-label on a role-less generic div is ignored by most
      // assistive tech, so the placeholder's meaning never actually reached a
      // screen reader.
      role="img"
      aria-label={awaiting === 'failed' ? 'not measured — the step failed' : 'not measured yet'}
    >
      <span
        className="text-[22px] font-normal leading-none"
        style={{ color: awaiting === 'failed' ? 'var(--danger)' : 'var(--text-muted)' }}
      >
        —
      </span>
    </div>
  )
}

/** The mark that says an explanation exists. Half-opacity at rest so a band of
 *  four tiles does not read as four punctuation marks, and full when the pointer
 *  is anywhere on the tile — the same moment the tooltip it advertises appears.
 *  `aria-hidden` because the explanation itself is in the tile's own sr-only
 *  line, which a screen reader gets without a hover it cannot perform.
 *
 *  `TOOLTIP_ANCHOR_ATTR` makes the tip drop from THIS mark rather than from the
 *  bottom of the whole tile — the mark is what advertised the explanation, so it
 *  is where the explanation should appear. The tile stays the hover target. */
function FactHelpMark() {
  return (
    <span
      aria-hidden="true"
      {...{ [TOOLTIP_ANCHOR_ATTR]: '' }}
      className="flex h-3 w-3 flex-none items-center justify-center rounded-full border text-[8.5px] leading-none opacity-70 transition-opacity duration-150 group-hover/fact:opacity-100 group-focus-within/fact:opacity-100"
      style={{ borderColor: 'currentColor' }}
    >
      ?
    </span>
  )
}

/** One fact as a tile, in three fixed lines: label (+ `?`), value, second line.
 *  Numeric/scalar facts (`big`) render a large metric value with an optional
 *  stepper/bar; text, path, and sentence values stay in the quiet body size and
 *  truncate inside the tile — so a value like a file path or "Safe — services
 *  boot side by side" reads on the same grid as "0%".
 *
 *  BOTH explanatory lines are resolved by LABEL, not passed in. The second line
 *  prefers the measured `sub` a stage produced and falls back to the static
 *  gloss, so a tile is never a line shorter than the one beside it just because
 *  its news happens to be clean — which is exactly what a green run history used
 *  to do. The tooltip is the whole TILE's, not the mark's: a 12px target is a
 *  poor one, and the mark is there to say the explanation exists, not to be the
 *  only way to reach it. */
export function FactTile({ fact: f, awaiting = 'idle' }: {
  fact: StageFact
  /** Why this tile's placeholder is empty (R86) — a live stage gets a sweeping
   *  bar, a parked one a muted dash, a failed one a danger dash. Only read when
   *  the fact itself is `awaiting`; a tile with a value ignores it. */
  awaiting?: AwaitingState
}) {
  const toneColor = f.tone ? FACT_TONE[f.tone] : null
  const help = f.help ?? FACT_HELP[f.label]
  // The static gloss stands in for a missing `sub` on a placeholder too: it is
  // true before the figure lands and after it, so the tile keeps its height and
  // nothing shifts when the stage settles. A failed placeholder overrides it:
  // the gloss describes a figure ("things the app must do") that this tile is
  // now never going to hold, so it says what happened instead.
  const sub = f.awaiting && awaiting === 'failed'
    ? 'not measured'
    : f.sub ?? FACT_GLOSS[f.label]
  const tile = (
    <div className="group/fact min-w-0 rounded-md px-3 py-2.5 bg-elevated" data-testid="fact-tile">
      {/* Sentence case, NOT the uppercase `.cl-rubric` the card kickers use. A
          tile label is read alongside a 22px number, and at that pairing the
          letter-spaced caps compete with the figure instead of labelling it. The
          kicker above the grid still carries the rubric voice, so the card keeps
          its register — this is the tile's own label, one level down. */}
      <div className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted">
        <span className="min-w-0 truncate">{f.label}</span>
        {help ? <FactHelpMark /> : null}
      </div>
      {help ? <span className="sr-only">{help}</span> : null}
      {f.awaiting ? (
        <FactPlaceholder awaiting={awaiting} />
      ) : f.big ? (
        <>
          <div className="mt-1 flex items-baseline gap-1 leading-none">
            <span className="text-[22px] font-medium" style={{ color: toneColor ?? 'var(--text-primary)' }}>{f.value}</span>
          </div>
          {f.segments ? <FactSegments segments={f.segments} /> : null}
        </>
      ) : (
        <div
          className="mt-1 min-w-0 truncate text-[11.5px]"
          title={f.title ?? f.value}
          style={{ color: toneColor ?? 'var(--text-secondary)', ...(f.mono ? { fontFamily: 'var(--font-mono)' } : {}) }}
        >
          {f.value}
        </div>
      )}
      {sub ? <div data-testid="fact-sub" className="mt-1.5 text-[10.5px] text-secondary">{sub}</div> : null}
    </div>
  )
  return help ? <Tooltip label={help}>{tile}</Tooltip> : tile
}

/** The one facts renderer every stage uses (R20): the 2–4 things that matter at
 *  this stage, carded on the same `PanelCard` surface as the Service / Playwright
 *  / docs digests below it, so the whole pane reads as one stack of like blocks.
 *  Facts render as a responsive tile grid (R77): numeric facts get a large
 *  metric treatment (coverage %, pass N of M), text/path facts stay quiet — one
 *  layout that fits every stage's mix of scalar and sentence values. */
export function FactsGrid({ facts, aside, awaiting = 'idle' }: {
  facts: StageFact[]
  /** Passed to every tile: the pane's one awaiting state, so every placeholder
   *  in the band says the same thing about why it is empty. */
  awaiting?: AwaitingState
  /** The stage's one card-level action, on the kicker line (PanelCard's `aside`)
   *  — the Evaluation Report's download sits with the archive it downloads
   *  instead of in the stage header. Only ever passed alongside the facts it acts
   *  on (the download and the Archive tile come from the same export task), so
   *  the no-facts return below can't strand it. */
  aside?: ReactNode
}) {
  if (facts.length === 0) return null
  return (
    // Same column as every stage panel — the tile grid wraps inside it and
    // long values truncate within a tile, never sprawling the whole pane.
    <div className={STAGE_COLUMN}>
      <PanelCard kicker="At a glance" aside={aside} testId="stage-facts-card">
        <div
          data-testid="stage-facts"
          className="grid gap-2"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
        >
          {facts.map((f, i) => (
            <FactTile key={`${f.label}-${i}`} fact={f} awaiting={awaiting} />
          ))}
        </div>
      </PanelCard>
    </div>
  )
}
