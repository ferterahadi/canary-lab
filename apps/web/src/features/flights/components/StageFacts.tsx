import type { ReactNode } from 'react'
import type { FlightManifest, FlightStage, PortifyBootInstance, PortifyManifest } from '@/shared/api/client'
import type { CoverageLedger, EvaluationExportTask, RunDetail } from '@/shared/api/types'
import { evaluationArchiveFilename, formatBytes, formatDuration } from '@/shared/lib/format'
import { PanelCard } from '@/shared/ui/PanelCard'
import { PORTIFY_PHASE_LABEL, STAGE_COLUMN, evidenceOf, num, portifyProgress, specsCoverageProgress, str } from './stage-meta'
import { bootDurationMs, estimateTokens, ledgerEvidence, overlayDiffStat, type StrengthCounts } from './stage-metrics'

// ─── Stage facts (R20) ──────────────────────────────────────────────────────
// One uniform template for every stage: the 2–4 things the user cares about at
// that stage, as label→value rows. Everything else is the details disclosure
// or the drill-through page's job.

export interface StageFact {
  label: string
  value: string
  tone?: 'good' | 'warn' | 'bad'
  /** Render the value in the mono face (paths, filenames, commands). */
  mono?: boolean
  /** Hover detail when the visible value is a shortened form (e.g. a path). */
  title?: string
  /** Render the value as a large metric number. Numeric/scalar facts only —
   *  sentence and path values stay in the quiet body size. */
  big?: boolean
  /** A segmented stepper under a `big` value: `[current, total]` (pass N of M). */
  stepper?: [number, number]
  /** A 0–1 progress bar under a `big` value (fraction toward the target). */
  bar?: number
  /** A proportional multi-segment bar under a `big` value, for a count that
   *  splits into named parts (passed/failed/aborted, strong/solid/basic/shallow).
   *  One bar shows the whole distribution, where a single fraction could only
   *  show the leading part — and the sub-line then names the parts. Zero-value
   *  segments are dropped, so a clean split doesn't render slivers. */
  segments?: FactSegment[]
  /** A quiet secondary line under a `big` value (e.g. the gap-kind breakdown). */
  sub?: string
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

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Everything a band needs that the flight record does NOT hold. Resolved once
 *  per visible stage by `useStageBandData` and passed in, so `stageFacts` stays
 *  a pure function of its inputs — and so a tile whose source hasn't loaded (or
 *  doesn't exist for this flight) is simply absent rather than showing a zero.
 *  Every field is optional for exactly that reason. */
export interface StageBandData {
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
  /** Env keys captured across the flight's envset slots. */
  envKeys?: number | null
  /** Envset slot count — the read-time answer to "how many env files", for a
   *  scout stage whose record stored no evidence. */
  envFiles?: number | null
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

export const MAX_LIST_FACTS = 5

/** The export task behind an Evaluation Report stage. Recorded evidence and the
 *  read-time probe both carry the id; `links` is the resume path's only carrier
 *  (its evidence records the reused archive, not the task). Resolving the TASK is
 *  what makes the card and the download work on a derived flight, which has no
 *  record at all. */
export function evaluationTaskId(stage: FlightStage, flight: FlightManifest): string | undefined {
  if (stage.key !== 'evaluation-export') return undefined
  return str(evidenceOf(stage), 'taskId') ?? flight.links?.evaluationTaskId
}

export function stageFacts(
  stage: FlightStage,
  flight: FlightManifest,
  companion?: FlightStage,
  /** Sources outside the flight record (see StageBandData). Absent fields drop
   *  their tile — the band never pads itself to a fixed width. */
  band: StageBandData = {},
): StageFact[] {
  const evalTask = band.evalTask
  const ev = evidenceOf(stage)
  const cev = evidenceOf(companion)
  // A pending step normally has nothing to show — EXCEPT when its artifacts were
  // probed from the workspace, which means they exist on disk even though the step
  // never completed (specs authored, no requirements to map them onto). Hiding
  // those facts would misreport a part-done step as untouched.
  if (stage.status === 'pending' && stage.evidenceSource !== 'workspace') return []
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
      // Recorded scan evidence first; the envset's slot count is the read-time
      // answer for a record that stored none (same cache-vs-truth rule the boot
      // proof follows).
      const envFiles = Array.isArray(ev.envFiles) ? ev.envFiles.length : band.envFiles ?? null
      return [
        { label: 'Repos scanned', value: String(flight.repoPaths.length), big: true },
        ...(band.config ? [{ label: 'Services found', value: String(band.config.services), big: true as const }] : []),
        ...(envFiles != null ? [{ label: 'Env files found', value: String(envFiles), big: true as const }] : []),
        ...(band.config ? [{ label: 'Port slots drafted', value: String(band.config.portSlots), big: true as const }] : []),
      ]
    }
    case 'scaffold': {
      // This stage CONFIGURES, so its settings are not its evidence: the worker
      // count and the service list are inputs the user can edit six inches
      // below, and counting them here measures nothing. What it actually proved
      // is that the suite comes up — so the band reports the boot proof, how
      // long that took, and what got snapshotted. The suite name, whether it was
      // reused, and the env FILE count all already read in the state line above.
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
              bar: booted / services.length,
              tone: booted === services.length ? 'good' as const : 'bad' as const,
            }]
          : []),
        ...(bootMs != null
          ? [{
              label: 'Boot time',
              value: formatDuration(bootMs),
              big: true as const,
              sub: 'every run pays this first',
            }]
          : []),
        ...(band.envKeys != null
          ? [{
              label: 'Env keys captured',
              value: String(band.envKeys),
              big: true as const,
              ...(capturedFiles != null ? { sub: `across ${plural(capturedFiles, 'file')}` } : {}),
            }]
          : []),
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
      // worse copy of the card. What the band adds is the SHAPE of the work:
      // how many requirements came out, from how many docs, and how much text
      // the agent had to read to get there.
      const docs = Array.isArray(ev.docs) ? (ev.docs as unknown[]).filter((d): d is string => typeof d === 'string') : []
      const count = num(cev, 'requirementCount')
      // Tokens is an ESTIMATE (four chars each), so it renders with a `≈` and
      // never claims to be the measured figure the byte count is.
      const tokens = band.docBytes != null ? estimateTokens(band.docBytes) : null
      return [
        ...(count != null ? [{ label: 'Requirements distilled', value: String(count), big: true as const }] : []),
        ...(docs.length > 0 ? [{ label: 'Source docs', value: String(docs.length), big: true as const }] : []),
        ...(tokens != null && band.docBytes != null
          ? [{
              label: 'Tokens read',
              value: `≈ ${compactCount(tokens)}`,
              big: true as const,
              // The compression is the interesting part: the distillation is what
              // this stage produced, and "4× smaller" says how much reading the
              // later stages were spared.
              sub: [formatBytes(band.docBytes), distillRatio(band)].filter(Boolean).join(' · '),
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
      const pct = num(ev, 'coveragePct') ?? p?.coveragePct ?? null
      const gapRows = Array.isArray(ev.gaps) ? (ev.gaps as Array<{ gap?: string }>) : null
      const gaps = gapRows ? gapRows.length : p?.gapsOpen ?? null
      // R35: name the gap kinds, not just the count ("2 untested, 1 path-incomplete").
      const byKind = new Map<string, number>()
      for (const g of gapRows ?? []) {
        if (typeof g.gap === 'string') byKind.set(g.gap, (byKind.get(g.gap) ?? 0) + 1)
      }
      const breakdown = [...byKind].map(([kind, n]) => `${n} ${kind}`).join(' · ')
      const target = flight.opts.coverageTarget
      // A probed suite with no requirements has UNDEFINED coverage, not 0%. The
      // percentage tile (amber, empty bar) would read as a failing suite when the
      // truth is there is no PRD to measure its specs against.
      if (stage.evidenceSource === 'workspace' && num(ev, 'total') === 0) {
        return [{ label: 'Requirements', value: 'None mapped yet' }]
      }
      return [
        // Pass N of M — the big number carries the stepper so "3 passes still to
        // go" reads at a glance instead of being inferred from "2 of 5".
        ...(stage.status === 'running' && p
          ? [{
              label: 'Authoring pass',
              value: String(p.pass),
              big: true as const,
              ...(Number.isFinite(p.maxPasses) ? { stepper: [p.pass, p.maxPasses] as [number, number] } : {}),
            }]
          : []),
        ...(pct != null
          ? [{
              label: 'Requirements covered',
              value: `${pct}%`,
              big: true as const,
              bar: target > 0 ? pct / target : pct >= 100 ? 1 : 0,
              tone: pct >= target ? 'good' as const : 'warn' as const,
            }]
          : []),
        ...(gaps != null
          ? [{
              label: 'Coverage gaps',
              value: gaps === 0 ? '0' : String(gaps),
              big: true as const,
              ...(breakdown && gaps > 0 ? { sub: breakdown } : {}),
              tone: gaps === 0 ? 'good' as const : 'warn' as const,
            }]
          : []),
        ...(stage.status !== 'running' && p && p.passes.length > 0 ? [{ label: 'Authoring passes', value: String(p.passes.length), big: true as const }] : []),
        // How many specs the authoring actually produced. Read off the ledger's
        // mapped tests, which is the set the coverage percentage was computed
        // over — so the two tiles describe the same population.
        ...(band.ledger && band.ledger.tests.length > 0
          ? [{
              label: 'Specs authored',
              value: String(band.ledger.tests.length),
              big: true as const,
              ...(specFileCount(band.ledger) != null
                ? { sub: `across ${plural(specFileCount(band.ledger)!, 'spec file')}` }
                : {}),
            }]
          : []),
      ]
    }
    case 'portify': {
      // R35: verdict → proof → what changed, in that order.
      if (stage.status === 'skipped') return [{ label: 'Parallel', value: 'Already verified — safe for parallel runs', tone: 'good' }]
      if (stage.status === 'running') {
        // Live phase mirror from the workflow (attempt stepper + phase verb) —
        // the embedded agent timeline below carries the detail.
        const prog = portifyProgress(stage)
        const attempt = num(prog, 'attempt')
        const maxAttempts = num(prog, 'maxAttempts')
        const phase = str(prog, 'status')
        return [
          ...(attempt != null && maxAttempts != null
            ? [{ label: 'Attempt', value: String(attempt), big: true as const, stepper: [attempt, maxAttempts] as [number, number] }]
            : []),
          ...(phase ? [{ label: 'Phase', value: PORTIFY_PHASE_LABEL[phase] ?? phase }] : []),
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
              bar: 1,
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
          : [{ label: 'Files edited', value: ev.edits ? '—' : '0', big: true as const, ...(ev.edits ? {} : { tone: 'good' as const, sub: 'already injectable' }) }]),
        ...(instances.length > 0
          ? [{
              label: 'Instances proven',
              value: `${instancesOk}/${instances.length}`,
              big: true as const,
              tone: instancesOk === instances.length ? 'good' as const : 'bad' as const,
              sub: instancesOk === instances.length ? 'booted side by side' : 'a concurrent boot failed',
            }]
          : []),
        ...(wf && wf.maxAttempts > 0
          ? [{
              label: 'Attempts',
              value: String(wf.attempt),
              big: true as const,
              stepper: [wf.attempt, wf.maxAttempts] as [number, number],
            }]
          : []),
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
      // The band answers "what did we actually verify", which is the one
      // question no earlier stage answers. Test authoring reports coverage
      // CLAIMED by annotation — it never looks at a run result, so a suite whose
      // every test fails still reads 100%. `proven` is the run-grounded sibling:
      // covered AND confirmed by a test that passed. Naming both, side by side,
      // is the point of the tile; the gap between them is the evaluation.
      //
      // Deliberately NOT here: the pass/fail counts. Those are the Test Run's,
      // one stage up, and reprinting them made this band a second run summary.
      const led = ledgerEvidence(band.ledger)
      const contents = evalTask?.archive
      const bandFacts: StageFact[] = [
        ...(led && led.proven != null
          ? [{
              label: 'Requirements proven',
              value: `${led.proven}/${led.total}`,
              big: true as const,
              bar: led.total > 0 ? led.proven / led.total : 0,
              tone: led.proven === led.total ? 'good' as const : 'warn' as const,
              sub: led.provenPct != null
                ? `${round(led.claimedPct)}% claimed, ${round(led.provenPct)}% proven`
                : undefined,
            }]
          : []),
        ...(led && led.strength.strong + led.strength.solid + led.strength.basic + led.strength.shallow > 0
          ? [{
              label: 'Evidence strength',
              value: `${led.strength.strong} strong`,
              big: true as const,
              // The whole distribution, strongest to weakest: a suite that is
              // 2 strong and 16 shallow reads very differently from one that is
              // 2 strong and 2 shallow, and the headline number alone hides it.
              segments: [
                { value: led.strength.strong, tone: 'good' as const },
                { value: led.strength.solid, tone: 'accent' as const },
                { value: led.strength.basic, tone: 'warn' as const },
                { value: led.strength.shallow, tone: 'bad' as const },
                { value: led.strength.ungraded, tone: 'muted' as const },
              ],
              sub: strengthBreakdown(led.strength),
            }]
          : []),
        ...(contents
          ? [{
              label: 'Evidence bundled',
              // Leads with the SIZE, not the video count. Size is always known —
              // it can be stat'd off the zip even for an export written before
              // the contents were recorded — whereas that older export's video
              // count is unrecoverable without unpacking it. Leading with the
              // count made every such archive announce a big "0".
              value: formatBytes(contents.bytes),
              big: true as const,
              ...(contents.videos > 0 ? { sub: plural(contents.videos, 'video') } : {}),
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
    ...(mode ? [{ label: 'Report', value: mode === 'localized' ? 'agent-rewritten' : 'built from evidence' }] : []),
    ...(archive ? [{ label: 'Archive', value: archive, mono: true, title: archive }] : []),
  ]
}

/** How many distinct spec FILES the ledger's tests live in. Null when the ledger
 *  records no locations (older mappings), so the sub-line is omitted rather than
 *  claiming one file. */
function specFileCount(ledger: CoverageLedger): number | null {
  const files = new Set(ledger.tests.map((t) => t.file).filter((f): f is string => Boolean(f)))
  return files.size > 0 ? files.size : null
}

/** "4× smaller" — source docs against the distilled summary. Omitted unless both
 *  sizes are known and the summary is genuinely smaller. */
function distillRatio(band: StageBandData): string | null {
  if (band.docBytes == null || band.summaryBytes == null || band.summaryBytes <= 0) return null
  const ratio = band.docBytes / band.summaryBytes
  return ratio >= 1.5 ? `distilled ${Math.round(ratio)}× smaller` : null
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

/** The strength buckets below the headline, strongest first, omitting empty
 *  ones. Ungraded tests are named as ungraded rather than folded into the
 *  weakest bucket — an unmeasured test is not a shallow one. */
function strengthBreakdown(strength: StrengthCounts): string | undefined {
  const parts = [
    ...(strength.solid > 0 ? [`${strength.solid} solid`] : []),
    ...(strength.basic > 0 ? [`${strength.basic} basic`] : []),
    ...(strength.shallow > 0 ? [`${strength.shallow} shallow`] : []),
    ...(strength.ungraded > 0 ? [`${strength.ungraded} ungraded`] : []),
  ]
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export const FACT_TONE: Record<NonNullable<StageFact['tone']>, string> = {
  good: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--danger)',
}

/** A segmented pass stepper under a `big` value: done segments quiet, the
 *  current one lit sky, the rest hairline — so the remaining passes are visible
 *  as empty track, not inferred from the number. */
export function FactStepper({ current, total }: { current: number; total: number }) {
  return (
    <div className="mt-2 flex gap-1" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className="h-[3px] flex-1 rounded-full"
          style={{
            background:
              i < current - 1 ? 'var(--text-secondary)' : i === current - 1 ? 'var(--accent-strong)' : 'var(--border-strong)',
          }}
        />
      ))}
    </div>
  )
}

/** A thin progress bar under a `big` value — coverage filling toward target. */
export function FactBar({ frac, color }: { frac: number; color: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * 100
  return (
    <div className="mt-2 h-[3px] overflow-hidden rounded-full" style={{ background: 'var(--border-strong)' }} aria-hidden>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

/** One fact as a tile. Numeric/scalar facts (`big`) render a large metric value
 *  with an optional stepper/bar/sub; text, path, and sentence values stay in the
 *  quiet body size and truncate inside the tile — so a value like a file path or
 *  "Safe — services boot side by side" reads on the same grid as "0%". */
export function FactTile({ fact: f }: { fact: StageFact }) {
  const toneColor = f.tone ? FACT_TONE[f.tone] : null
  return (
    <div className="min-w-0 rounded-md px-3 py-2.5 bg-elevated">
      {/* Sentence case, NOT the uppercase `.cl-rubric` the card kickers use. A
          tile label is read alongside a 22px number, and at that pairing the
          letter-spaced caps compete with the figure instead of labelling it. The
          kicker above the grid still carries the rubric voice, so the card keeps
          its register — this is the tile's own label, one level down. */}
      <div className="text-[11.5px] text-muted">{f.label}</div>
      {f.big ? (
        <>
          <div className="mt-1 flex items-baseline gap-1 leading-none">
            <span className="text-[22px] font-medium" style={{ color: toneColor ?? 'var(--text-primary)' }}>{f.value}</span>
            {f.stepper ? <span className="text-[12px] text-muted">{` of ${f.stepper[1]}`}</span> : null}
          </div>
          {f.stepper ? <FactStepper current={f.stepper[0]} total={f.stepper[1]} /> : null}
          {f.segments ? <FactSegments segments={f.segments} /> : null}
          {f.bar != null && !f.segments ? <FactBar frac={f.bar} color={toneColor ?? 'var(--accent)'} /> : null}
          {f.sub ? <div className="mt-1.5 text-[10.5px] text-secondary">{f.sub}</div> : null}
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
    </div>
  )
}

/** The one facts renderer every stage uses (R20): the 2–4 things that matter at
 *  this stage, carded on the same `PanelCard` surface as the Service / Playwright
 *  / docs digests below it, so the whole pane reads as one stack of like blocks.
 *  Facts render as a responsive tile grid (R77): numeric facts get a large
 *  metric treatment (coverage %, pass N of M), text/path facts stay quiet — one
 *  layout that fits every stage's mix of scalar and sentence values. */
export function FactsGrid({ facts, aside }: {
  facts: StageFact[]
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
            <FactTile key={`${f.label}-${i}`} fact={f} />
          ))}
        </div>
      </PanelCard>
    </div>
  )
}
