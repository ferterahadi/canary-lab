import { useEffect, useMemo, useState } from 'react'
import * as api from '@/shared/api/client'
import type { HealEnd, RunDetail, RunIndexEntry, RunStatus } from '@/shared/api/types'
import { PanelCard } from '@/shared/ui/PanelCard'
import { FixesCapturedPanel, RunRow } from '@/features/runs'
import { clientLabel } from '@/shared/ui/external-client-branding'
import { FailingTests } from './FailingTests'
import { FactsGrid, STAGE_COLUMN, healEndShort, plural, type StageFact } from './stage-meta'
import { runHistoryStats } from './stage-metrics'
import { formatDuration } from '@/shared/lib/format'

// R80 — the Test Run hero. Before this, the run stage rendered the SAME run
// three-to-four times: the "At a glance" facts card, the RunRepairSummary's own
// second facts card, the runs-list row, and the checkpoint message. The panel
// was organized by DATA SOURCE, so one run's verdict + pass count repeated.
//
// This renders the run as ONE object: an identity row (RunRow chrome), a quiet
// stats line under it (Tests · Repairs · Services), the failing tests
// worst-first, and the live run controls. The big-number tile treatment belongs
// to the "At a glance" band above — see RunStatsLine. Below the hero: the
// previous runs for this feature.
//
// R82 — the stage is the run's SUMMARY, and everything that was really run-detail
// content is gone from it: the per-failure assertion error / snippet / open-spec
// disclosure (FailingTests), the `Restart run` button (a second "run it again"
// sitting next to the checkpoint's own), and the repair-journal disclosure (the
// repair transcript lives on the run detail, which this panel links to). The
// run-failed DECISION also left: it renders as the same generic CheckpointControls
// card every other checkpoint kind gets, below this panel, so a flight's
// questions all look and sit the same. What remains here is evidence.
//
// It is the SINGLE poller for the run stage (one 5s interval: run detail + the
// feature's runs list).

/** The cap the repair count is reported against — mirrors the server's
 *  AUTO_HEAL_MAX_CYCLES (heal-cycle.ts). Presentation only. */
const REPAIR_CYCLE_CAP = 10

/** What the run stage's evidence carries — the hero renders from this
 *  immediately (before the first poll resolves) and enriches from run detail. */
export interface RunStageEvidence {
  runId?: string
  status?: string
  healCycles?: number
  healEnd?: HealEnd
}

export function TestRunPanel({
  feature,
  runId,
  live,
  evidence,
  onOpenRun,
  onError,
}: {
  feature: string
  runId: string
  /** A run for this feature is active right now — drives the poll cadence. */
  live: boolean
  evidence: RunStageEvidence
  /** Open a run on the run detail. `focusTest` is a failed entry's `name` — the
   *  detail lands on the Playwright tab, scrolled to that test (R82). */
  onOpenRun?: (feature: string, runId: string, focusTest?: string) => void
  onError?: (msg: string) => void
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [runs, setRuns] = useState<RunIndexEntry[]>([])
  // Bumped after a PR is opened so the poll re-runs and picks up proposedPrs
  // even on a settled (non-polling) run.
  const [reloadKey, setReloadKey] = useState(0)

  // One poller for the whole run stage — the run detail and the feature's run
  // list on a single interval. Gentle 5s cadence while anything is live; a
  // single load once settled.
  useEffect(() => {
    let alive = true
    const load = (): void => {
      api.getRunDetail(runId).then((d) => { if (alive) setDetail(d) }).catch(() => {})
      api.listRuns({ feature }).then((r) => { if (alive) setRuns(r) }).catch(() => {})
    }
    load()
    if (!live) return () => { alive = false }
    const id = setInterval(load, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [runId, feature, live, reloadKey])

  const manifest = detail?.manifest
  const summary = detail?.summary
  const status: RunStatus = (manifest?.status ?? (evidence.status as RunStatus | undefined) ?? (live ? 'running' : 'failed'))
  const healCycles = manifest?.healCycles ?? evidence.healCycles ?? 0
  const healEnd = manifest?.healEnd ?? evidence.healEnd

  // The feature's real test runs, newest first (boot/benchmark/verify are
  // plumbing, not test runs). The current run's ordinal reads off this list.
  const featureRuns = useMemo(
    () => runs.filter((r) => r.executionType !== 'boot' && r.executionType !== 'benchmark' && r.executionType !== 'verify'),
    [runs],
  )
  const idx = featureRuns.findIndex((r) => r.runId === runId)
  const ordinal = idx >= 0 ? featureRuns.length - idx : null
  const previous = featureRuns
    .filter((r) => r.runId !== runId)
    .slice(0, 5)
    .map((r) => ({ run: r, ordinal: featureRuns.length - featureRuns.findIndex((x) => x.runId === r.runId) }))

  // The identity row is a RunRow — same chrome as the runs list, so the run
  // reads as the one object it is. Prefer the live index entry; synthesize one
  // from the manifest/evidence before the list resolves.
  const currentEntry: RunIndexEntry = featureRuns.find((r) => r.runId === runId) ?? {
    runId,
    feature,
    startedAt: manifest?.startedAt ?? '',
    status,
    executionType: manifest?.executionType ?? 'run',
  }

  const stats = runStats({ summary, healCycles, healEnd, services: manifest?.services })
  const failing = summary?.failed ?? []
  const active = live && (status === 'running' || status === 'healing')
  const runRef = shortRunRef(runId)

  const report = (err: unknown): void => onError?.(err instanceof Error ? err.message : String(err))

  return (
    <div className={`flex flex-col gap-3 ${STAGE_COLUMN}`} data-testid="test-run">
      {/* The band belongs HERE rather than in `stageFacts`, because this panel
          already polls the feature's run list — resolving it a second time in the
          band-data hook would be two requests for one answer. It reports the
          HISTORY (how many runs, how they ended, how long they take); the hero
          below reports the latest run. Different scopes, so no number repeats. */}
      <FactsGrid facts={runHistoryFacts(featureRuns)} />

      <PanelCard kicker="Latest run" testId="test-run-hero">
        <ul className="m-0 list-none p-0">
          <RunRow
            run={currentEntry}
            detail={detail ?? undefined}
            primaryLabel={`Run ${runRef}`}
            marker={ordinal != null ? `run ${ordinal} of ${featureRuns.length}` : undefined}
            showPorts={false}
            /* R82: the score is HIDDEN on the identity row — the stats line
               right below states it. Showing it here too (promoted beside the
               chip, or in the meta line) printed the same fraction twice, a
               hand's width apart. */
            passCount="hidden"
            onSelect={() => onOpenRun?.(feature, runId)}
          />
        </ul>

        <RunStatsLine stats={stats} />

        {/* WHICH tests failed — identity only. Each row opens that failure on the
            run detail, where the assertion error, the snippet and the spec live
            (R82); this stage stays the summary. */}
        <FailingTests
          failing={failing}
          knownTests={summary?.knownTests}
          {...(onOpenRun ? { onOpenTest: (name: string) => onOpenRun(feature, runId, name) } : {})}
        />

        <RunControls runId={runId} status={status} active={active} onError={report} />

        {/* External heal: the repair runs in the user's own MCP client, so there
            is no Canary transcript to embed — an honest status line, with the
            full picture one drill-through away on the run detail. */}
        {manifest?.healMode === 'external' && (
          <div data-testid="run-hero-external" className="mt-2 text-[11px] text-muted">
            {externalHealNote(manifest.externalHealSession)}
          </div>
        )}
      </PanelCard>

      {/* Never dead-end: when the worktree run left a fix, the patch is always
          reachable here (copy path · open · apply locally). Phase D layers the
          Propose-PR control in via prSlot. */}
      {manifest?.fixCapture && manifest.fixCapture.repos.length > 0 && (
        <FixesCapturedPanel
          fixCapture={manifest.fixCapture}
          runId={runId}
          proposedPrs={manifest.proposedPrs}
          onError={onError}
          onProposed={() => setReloadKey((k) => k + 1)}
        />
      )}

      {/* The runs before this one (R82). Same rubric + dashed-rule + count-chip
          header the Failing tests band uses, so the two lists on this stage read
          as one family instead of a card and a stray `<h3>`. Each row is labelled
          by its run REF and ordinal — the old list repeated the feature name on
          every row, which is the one thing every row shares — and carries its own
          open action rather than relying on the row being secretly clickable. */}
      {previous.length > 0 && (
        <section data-testid="previous-runs" className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span className="cl-rubric">Previous runs</span>
            <span className="h-px flex-1 border-t border-dashed border-line" />
            <span className="cl-count-chip">{previous.length}</span>
          </div>
          <ul className="m-0 flex list-none flex-col divide-y divide-line-subtle p-0">
            {previous.map(({ run, ordinal: n }) => (
              <RunRow
                key={run.runId}
                run={run}
                detail={undefined}
                primaryLabel={`Run ${shortRunRef(run.runId)}`}
                marker={`run ${n} of ${featureRuns.length}`}
                showPorts={false}
                /* The row IS the open action — its trailing arrow stops being
                   hover-only here so the affordance is visible at rest. */
                arrow="always"
                onSelect={(r) => onOpenRun?.(feature, r.runId)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** The stage's "At a glance": what this feature's run history looks like. Every
 *  count comes from `runHistoryStats`, which keeps unfinished runs out of the
 *  outcome buckets — a run still going is not a failure, and a band that folded
 *  it into one would report a worse verdict than the evidence supports. */
function runHistoryFacts(runs: RunIndexEntry[]): StageFact[] {
  const stats = runHistoryStats(runs)
  if (!stats) return []
  const settled = stats.passed + stats.failed + stats.aborted
  return [
    {
      label: 'Runs performed',
      value: String(stats.total),
      big: true,
      ...(stats.active > 0 ? { sub: `${stats.active} still going` } : {}),
    },
    {
      label: 'Succeeded',
      value: `${stats.passed}`,
      big: true,
      // All three outcomes in one bar. A single passed/settled fraction would
      // render a failed run and an aborted one as the same empty space, and an
      // abort is a run that never reached a verdict — not a failing one.
      ...(settled > 0
        ? {
            segments: [
              { value: stats.passed, tone: 'good' as const },
              { value: stats.failed, tone: 'bad' as const },
              { value: stats.aborted, tone: 'muted' as const },
            ],
          }
        : {}),
      tone: settled === 0 ? undefined : stats.passed === settled ? 'good' : 'warn',
      ...(outcomeBreakdown(stats.failed, stats.aborted) ? { sub: outcomeBreakdown(stats.failed, stats.aborted)! } : {}),
    },
    ...(stats.avgDurationMs != null
      ? [{
          label: 'Avg duration',
          value: formatDuration(stats.avgDurationMs),
          big: true as const,
          ...(stats.longestDurationMs != null && stats.longestDurationMs !== stats.avgDurationMs
            ? { sub: `longest ${formatDuration(stats.longestDurationMs)}` }
            : {}),
        }]
      : []),
    ...(stats.healCycles > 0
      ? [{
          label: 'Repair cycles',
          value: String(stats.healCycles),
          big: true as const,
          // Scoped explicitly: the hero's own Repair-cycles tile counts THIS
          // run, and two unqualified "Repair cycles" tiles a hand's width apart
          // would read as a contradiction rather than two scopes.
          sub: `across ${plural(stats.runsWithRepairs, 'run')}`,
        }]
      : []),
  ]
}

/** "2 failed · 1 aborted", omitting whichever is zero; undefined when neither
 *  happened, so a clean history carries no sub-line at all. */
function outcomeBreakdown(failed: number, aborted: number): string | undefined {
  const parts = [
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(aborted > 0 ? [`${aborted} aborted`] : []),
  ]
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** One entry on the latest run's stats line. */
interface RunStat {
  label: string
  value: string
  /** Trailing qualifier in the label's own quiet weight — why the repair loop
   *  stopped, which the number alone can't say. */
  note?: string
  /** Hover detail when the value is a roll-up (the per-service list). */
  title?: string
  /** Danger hue. The only tone this line carries — see `RunStatsLine`. */
  bad?: boolean
}

/** The latest run's numbers, in the identity row's own register: 11px, muted
 *  label + neutral value, `·` separated — the same vocabulary RunRow's meta line
 *  uses, one line under it and aligned to the same text column.
 *
 *  These three facts used to render as `FactTile`s — boxed on `bg-elevated`,
 *  22px figures, with a progress bar and a ten-segment stepper. That is the
 *  exact treatment the "At a glance" band directly above uses, so the stage
 *  opened with two adjacent cards of big boxed numbers and nothing said which
 *  one was the headline. The band is the metric moment (it reports the whole run
 *  HISTORY); this card is ONE run object, and these are that object's
 *  attributes, so they read as attributes.
 *
 *  Tone all but disappears with the boxes. The verdict chip on the row above
 *  already carries the run's colour, and green "2/2 booted" next to an amber
 *  "2/23" next to a red FAILED chip was three accents competing for one glance —
 *  these numbers are reference data, not the alarm. The single exception is a
 *  service that never came up, which stays danger-hued because it is the one
 *  fact here that the verdict chip does NOT say: a red run whose services all
 *  booted is failing tests, a red run missing a service never got off the
 *  ground. So the line is neutral whenever nothing is wrong with it. */
function RunStatsLine({ stats }: { stats: RunStat[] }) {
  return (
    <div
      data-testid="run-hero-stats"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-3 text-[11px] leading-tight"
      /* Hangs under RunRow's text column, not its dot — derived from that row's
         own gutter + dot + gap so this line reads as its second meta line. */
      style={{ paddingLeft: 'calc(0.75rem + 0.55rem + 0.5rem)' }}
    >
      {stats.map((s, i) => (
        <span key={s.label} className="flex items-center gap-1.5" {...(s.title ? { title: s.title } : {})}>
          {i > 0 && <span aria-hidden="true" className="select-none text-muted opacity-50">·</span>}
          <span className="text-muted">{s.label}</span>
          <span className={`tabular-nums ${s.bad ? 'text-danger' : 'text-secondary'}`}>{s.value}</span>
          {s.note ? <span className="text-muted">({s.note})</span> : null}
        </span>
      ))}
    </div>
  )
}

/** What the stats line reports: Tests (passed/total), Repairs (cycle of the cap
 *  + the give-up short form), Services ("N/M booted", per-service tooltip). Boot
 *  health is a different axis than the test verdict, so it stays its own fact. */
function runStats({
  summary,
  healCycles,
  healEnd,
  services,
}: {
  summary: RunDetail['summary'] | undefined
  healCycles: number
  healEnd: HealEnd | undefined
  services: RunDetail['manifest']['services'] | undefined
}): RunStat[] {
  const stats: RunStat[] = []
  if (summary && summary.total > 0) {
    stats.push({ label: 'Tests passed', value: `${summary.passed}/${summary.total}` })
  }
  // Repairs: a clean run reads a bare "0"; any cycle names the cap it is
  // counting toward, and a loop that gave up carries the reason as the note.
  const short = healEndShort(healEnd)
  stats.push({
    label: 'Repair cycles',
    value: healCycles > 0 ? `${Math.min(healCycles, REPAIR_CYCLE_CAP)} of ${REPAIR_CYCLE_CAP}` : '0',
    ...(short ? { note: short } : {}),
  })
  const svc = services ?? []
  if (svc.length > 0) {
    // "Came up" = anything that isn't a failed readiness probe (timeout). A
    // service that booted and was later torn down (stopped) still came up.
    const booted = svc.filter((s) => s.status !== 'timeout' && s.status !== 'queued').length
    const tooltip = svc
      .map((s) => {
        const port = Object.values(s.allocatedPorts ?? {})[0]
        return `${s.name} · ${s.status ?? 'unknown'}${port ? ` · :${port}` : ''}`
      })
      .join('\n')
    stats.push({
      label: 'Services',
      value: `${booted}/${svc.length} booted`,
      title: tooltip,
      ...(booted < svc.length ? { bad: true } : {}),
    })
  }
  return stats
}

/** The run's LIVE controls, on the stage: Stop, and Cancel repair while healing.
 *  Same endpoints the run detail drives; all state flows back over the runs WS.
 *
 *  R82: no `Restart run` here. A settled non-green run parks the flight on the
 *  run-failed checkpoint, whose first option ("Start a new run") IS the restart —
 *  two differently-shaped buttons for one intent, a hand's width apart, made the
 *  user reason about a difference that doesn't matter. The run detail still has
 *  its own restart for driving a run outside a flight. */
function RunControls({
  runId,
  status,
  active,
  onError,
}: {
  runId: string
  status: RunStatus
  active: boolean
  onError: (err: unknown) => void
}) {
  if (!active) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="run-stage-controls">
      {active && status === 'healing' && (
        <button
          type="button"
          data-testid="run-stage-cancel-heal"
          onClick={() => { api.cancelHealRun(runId).catch(onError) }}
          className="cl-button px-2 py-0.5 text-[11px]"
        >
          Cancel repair
        </button>
      )}
      {active && (
        <button
          type="button"
          data-testid="run-stage-stop"
          onClick={() => { api.stopRun(runId).catch(onError) }}
          className="cl-button px-2 py-0.5 text-[11px] text-danger"
        >
          ⏹ Stop run
        </button>
      )}
    </div>
  )
}

/** Honest one-liner for an externally-claimed heal (Claude Desktop / Codex CLI
 *  repairing over MCP) — client · state · cycle, since Canary has no transcript
 *  to embed. Mirrors the wording the old activity-rail `[external]` row used. */
function externalHealNote(session: RunDetail['manifest']['externalHealSession']): string {
  if (!session) return 'Repaired by an external client. Full transcript on the run detail.'
  const who = clientLabel(session.clientKind, 'an external client')
  const cycle = session.cycleCount > 0 ? ` · repair cycle ${session.cycleCount}` : ''
  return `Repaired by ${who} — ${session.status}${cycle}. Full transcript on the run detail.`
}

/** Short, stable run reference for the identity line — the trailing token of
 *  the run id (`…-z6kc` → `z6kc`), falling back to the whole id. */
function shortRunRef(runId: string): string {
  const tail = runId.split(/[-_]/).pop()
  return tail && tail.length >= 3 ? tail : runId
}

