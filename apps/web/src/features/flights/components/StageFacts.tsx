import type { FlightManifest, FlightStage } from '@/shared/api/client'
import { PanelCard } from '@/shared/ui/PanelCard'
import { PORTIFY_PHASE_LABEL, STAGE_COLUMN, evidenceOf, num, portifyProgress, specsCoverageProgress, str } from './stage-meta'

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
  /** A quiet secondary line under a `big` value (e.g. the gap-kind breakdown). */
  sub?: string
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
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

export function stageFacts(
  stage: FlightStage,
  flight: FlightManifest,
  companion?: FlightStage,
): StageFact[] {
  const ev = evidenceOf(stage)
  const cev = evidenceOf(companion)
  if (stage.status === 'pending') return []
  switch (stage.key) {
    case 'similarity': {
      const match = ev.match as Record<string, unknown> | null | undefined
      return match && typeof match.feature === 'string'
        ? [{ label: 'Matches', value: match.feature }]
        : []
    }
    case 'scout':
      // R72c: everything the scan surfaces is per-repo and lives on the
      // RepoScanPanel's cards (name · location · env files) under the one
      // global intent — no facts left at the stage level.
      return []
    case 'scaffold': {
      // R32: the merged Feature setup row — the env/boot proof from the folded
      // env-capture companion. The suite name is NOT a fact here: it already
      // reads in the breadcrumb and the state line. The config digest (run
      // command, ports, Playwright) renders beside these from the live config.
      const dir = str(ev, 'featureDir')
      return [
        ...(ev.reused ? [{ label: 'Setup', value: 'Reused existing', tone: 'good' as const }] : []),
        ...(dir ? [{ label: 'Location', value: dir.split('/').slice(-2).join('/'), mono: true, title: dir }] : []),
        ...bootCheckFacts(cev),
      ]
    }
    case 'env-capture':
      // Folded into the scaffold row (R32); kept for completeness if a caller
      // renders the stage standalone.
      return bootCheckFacts(ev)
    case 'docs': {
      // R33: the merged Requirements row — the collected docs by name (path on
      // hover), the source rung, and the distilled requirement count from the
      // folded prd-summary companion.
      const docs = Array.isArray(ev.docs) ? (ev.docs as unknown[]).filter((d): d is string => typeof d === 'string') : []
      const source = str(ev, 'source')
      const count = num(cev, 'requirementCount')
      const shown = docs.slice(0, MAX_LIST_FACTS)
      return [
        ...shown.map((d, i) => ({
          label: docs.length === 1 ? 'Doc' : `Doc ${i + 1}`,
          value: d,
          mono: true,
          title: `features/${flight.feature}/docs/${d}`,
        })),
        ...(docs.length > shown.length ? [{ label: ' ', value: `+${docs.length - shown.length} more` }] : []),
        ...(source ? [{ label: 'Source', value: source }] : []),
        ...(count != null ? [{ label: 'Requirements', value: String(count) }] : []),
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
      return [
        { label: 'Parallel', value: 'Safe — services boot side by side', tone: 'good' },
        { label: 'Proof', value: 'Concurrent double boot, both green' },
        { label: 'Edits', value: ev.edits ? 'Applied (overlay)' : 'None needed' },
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
      const zip = str(ev, 'evaluationZip') ?? flight.links?.evaluationZip
      return zip ? [{ label: 'Archive', value: zip.split('/').pop() ?? zip, mono: true, title: zip }] : []
    }
    default:
      return []
  }
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
      <div className="cl-rubric">{f.label}</div>
      {f.big ? (
        <>
          <div className="mt-1 flex items-baseline gap-1 leading-none">
            <span className="text-[22px] font-medium" style={{ color: toneColor ?? 'var(--text-primary)' }}>{f.value}</span>
            {f.stepper ? <span className="text-[12px] text-muted">{` of ${f.stepper[1]}`}</span> : null}
          </div>
          {f.stepper ? <FactStepper current={f.stepper[0]} total={f.stepper[1]} /> : null}
          {f.bar != null ? <FactBar frac={f.bar} color={toneColor ?? 'var(--accent)'} /> : null}
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
export function FactsGrid({ facts }: { facts: StageFact[] }) {
  if (facts.length === 0) return null
  return (
    // Same column as every stage panel — the tile grid wraps inside it and
    // long values truncate within a tile, never sprawling the whole pane.
    <div className={STAGE_COLUMN}>
      <PanelCard kicker="At a glance" testId="stage-facts-card">
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
