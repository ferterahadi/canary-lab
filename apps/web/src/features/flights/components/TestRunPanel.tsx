import { useMemo, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type { HealEnd, RunDetail, RunIndexEntry, RunStatus } from '@/shared/api/types'
import { PanelCard } from '@/shared/ui/PanelCard'
import type { RunOpenTarget } from '@/shared/lib/workspace-view-state'
import { RunRow, useRun, useRuns } from '@/features/runs'
import { FailingTests } from './FailingTests'
import { FactsGrid, HERO_ROW, STAGE_COLUMN, healEndShort, plural, runHistoryFacts } from './stage-meta'
import { SkeletonBar, SkeletonBead, type AwaitingState } from '@/shared/ui/Skeleton'
import { DisabledControlTooltip } from '@/shared/ui/Tooltip'

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
// Data comes from the shared runs store (`useRun` / `useRuns`): `/ws/runs`
// already pushes the run detail and the index live, so the panel's old 5s
// interval re-downloaded the app's biggest payload (full playback events) to
// read a handful of summary fields the store was holding all along.

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
  awaiting,
  pausedNotice,
  mutationLockedReason,
}: {
  feature: string
  /** Absent until the stage HAS a run — the hero then renders as its own
   *  skeleton (R83) rather than the stage pane going blank. */
  runId?: string
  /** A run for this feature is active right now — gates the live controls and
   *  the "still running" reading of a verdictless run. */
  live: boolean
  evidence: RunStageEvidence
  /** Open a run on the run detail. `target.test` is a failed entry's `name` — the
   *  detail lands on the Playwright tab, scrolled to that test (R82);
   *  `target.tab` names a pane (the captured fixes go to Changes). */
  onOpenRun?: (feature: string, runId: string, target?: RunOpenTarget) => void
  onError?: (msg: string) => void
  /** Why any missing run-history value is a skeleton. Required so a completed
   *  run with old/incomplete evidence reads as unavailable, not idle. */
  awaiting: AwaitingState
  /** The shared stage recovery card. It sits after this panel's own facts band,
   *  matching every other stage without giving run history a second owner. */
  pausedNotice?: ReactNode
  /** External ownership leaves live run controls visible but inert. */
  mutationLockedReason?: string
}) {
  const { detail } = useRun(runId)
  const { runs } = useRuns()

  const manifest = detail?.manifest
  const summary = detail?.summary
  const status: RunStatus = (manifest?.status ?? (evidence.status as RunStatus | undefined) ?? (live ? 'running' : 'failed'))
  const healCycles = manifest?.healCycles ?? evidence.healCycles ?? 0
  const healEnd = manifest?.healEnd ?? evidence.healEnd

  // The feature's real test runs, newest first (boot/benchmark/verify are
  // plumbing, not test runs). The current run's ordinal reads off this list.
  const featureRuns = useMemo(
    () => runs.filter((r) => r.feature === feature && r.executionType !== 'boot' && r.executionType !== 'benchmark' && r.executionType !== 'verify'),
    [runs, feature],
  )
  const idx = runId ? featureRuns.findIndex((r) => r.runId === runId) : -1
  const ordinal = idx >= 0 ? featureRuns.length - idx : null
  const previous = featureRuns
    .filter((r) => r.runId !== runId)
    .slice(0, 5)
    .map((r) => ({ run: r, ordinal: featureRuns.length - featureRuns.findIndex((x) => x.runId === r.runId) }))

  // The identity row is a RunRow — same chrome as the runs list, so the run
  // reads as the one object it is. Prefer the live index entry; synthesize one
  // from the manifest/evidence before the list resolves.
  const currentEntry: RunIndexEntry = (runId ? featureRuns.find((r) => r.runId === runId) : undefined) ?? {
    runId: runId ?? '',
    feature,
    startedAt: manifest?.startedAt ?? '',
    status,
    executionType: manifest?.executionType ?? 'run',
  }

  const stats = runStats({
    summary,
    healCycles,
    healEnd,
    services: manifest?.services,
    fixCapture: manifest?.fixCapture,
    ...(runId && onOpenRun ? { onOpenFixes: () => onOpenRun(feature, runId, { tab: 'changes' }) } : {}),
  })
  const failing = summary?.failed ?? []
  const active = live && (status === 'running' || status === 'healing')
  const runRef = runId ? shortRunRef(runId) : null

  const report = (err: unknown): void => onError?.(err instanceof Error ? err.message : String(err))

  return (
    <div className={`flex flex-col gap-3 ${STAGE_COLUMN}`} data-testid="test-run">
      {/* The band belongs HERE rather than in `stageFacts`, because this panel
          already reads the feature's run list off the shared store — resolving
          it a second time in the band-data hook would be two owners for one
          answer. It reports the HISTORY (how many runs, how they ended, how
          long they take); the hero below reports the latest run. Different
          scopes, so no number repeats. */}
      <FactsGrid facts={runHistoryFacts(featureRuns)} awaiting={awaiting} />

      {pausedNotice}

      <PanelCard kicker="Latest run" testId="test-run-hero">
        {runId == null && awaiting ? (
          <RunHeroSkeleton awaiting={awaiting} />
        ) : (
          <>
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
            /* Guarded on `runId` like the `onOpenFixes` wiring above: the hero
               also renders from a synthesized entry before the run list
               resolves, and this used to hand `onOpenRun` an undefined id in
               that window — asking the host to open a run that has no id. */
            onSelect={() => { if (runId) onOpenRun?.(feature, runId) }}
          />
        </ul>

        <RunStatsLine stats={stats} />

        {/* WHICH tests failed — identity only. Each row opens that failure on the
            run detail, where the assertion error, the snippet and the spec live
            (R82); this stage stays the summary. */}
        <FailingTests
          failing={failing}
          knownTests={summary?.knownTests}
          {...(onOpenRun && runId ? { onOpenTest: (name: string) => onOpenRun(feature, runId, { test: name }) } : {})}
        />

        {/* No run id means there is no run to control — the surrounding branch
            can still render from manifest/evidence alone. */}
        {runId && <RunControls runId={runId} status={status} active={active} onError={report} mutationLockedReason={mutationLockedReason} />}
          </>
        )}
      </PanelCard>

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
  /** Makes this segment the line's one link — an accent-hued button with a
   *  trailing arrow. Only the captured fixes use it (see `runStats`). */
  onClick?: () => void
  /** Test hook for the linked segment. */
  testId?: string
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
/** The hero before there is a run to report: the same blocks the filled card
 *  has, on the same left edge.
 *
 *  Composed here rather than stacked out of `SkeletonRows`, because a generic row
 *  list drew every block flush at x=0 — a left edge no value in this card ever
 *  lands on. It also made the widest bar in the card a 7px sub-line and the two
 *  test rows identical twins, so the placeholders promised a layout the card does
 *  not have. Everything now hangs off `HERO_ROW`, the same constant RunRow's
 *  stats line and the failure rows use.
 *
 *  Widths follow what actually arrives: a short "Run 4f2a" title over a longer
 *  meta line, then wrapping test titles over a shorter tag line. */
function RunHeroSkeleton({ awaiting }: { awaiting: AwaitingState }) {
  return (
    <div data-testid="test-run-hero-skeleton" className="flex flex-col">
      {/* Identity row — RunRow's gutter, dot size and two-line text column. */}
      <div className="flex items-center gap-2 py-2" style={{ paddingInline: HERO_ROW.GUTTER }}>
        <SkeletonBead awaiting={awaiting} size={8.8} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <SkeletonBar awaiting={awaiting} width="28%" height={10} />
          <SkeletonBar awaiting={awaiting} width="52%" height={7} />
        </div>
      </div>

      {/* Tests · Repairs · Services land on this bar, not beside it. */}
      <div style={{ paddingLeft: HERO_ROW.TEXT_INDENT }}>
        <SkeletonBar awaiting={awaiting} width="40%" height={8} />
      </div>

      {/* The per-test rows, in FailureRow's dot lane and hairline dividers. */}
      <ul className="m-0 mt-3 flex list-none flex-col p-0">
        {['64%', '46%'].map((width) => (
          <li
            key={width}
            className="flex items-start gap-2 border-t border-line-subtle py-2 first:border-t-0"
            style={{ paddingInline: HERO_ROW.GUTTER }}
          >
            <span className="mt-[5px] flex shrink-0 items-center justify-center" style={{ width: HERO_ROW.DOT }}>
              <SkeletonBead awaiting={awaiting} size={6} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <SkeletonBar awaiting={awaiting} width={width} height={9} />
              <SkeletonBar awaiting={awaiting} width="24%" height={7} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RunStatsLine({ stats }: { stats: RunStat[] }) {
  return (
    <div
      data-testid="run-hero-stats"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-3 text-[11px] leading-tight"
      style={{ paddingLeft: HERO_ROW.TEXT_INDENT }}
    >
      {stats.map((s, i) => (
        <span key={s.label} className="flex items-center gap-1.5" {...(s.title ? { title: s.title } : {})}>
          {i > 0 && <span aria-hidden="true" className="select-none text-muted opacity-50">·</span>}
          {s.onClick ? (
            // The line's one interactive segment. It stays in the line's register
            // (11px, muted label) and takes the accent only on the value + arrow —
            // accent MEANS "click me" here, which is exactly what this is, and the
            // neutral numbers beside it stay reference data.
            <button
              type="button"
              onClick={s.onClick}
              {...(s.testId ? { 'data-testid': s.testId } : {})}
              className="flex items-center gap-1.5 rounded text-[11px] hover:underline"
            >
              <span className="text-muted">{s.label}</span>
              <span className="tabular-nums text-accent">{s.value}</span>
              <span aria-hidden="true" className="text-accent">→</span>
            </button>
          ) : (
            <>
              <span className="text-muted">{s.label}</span>
              <span className={`tabular-nums ${s.bad ? 'text-danger' : 'text-secondary'}`}>{s.value}</span>
              {s.note ? <span className="text-muted">({s.note})</span> : null}
            </>
          )}
        </span>
      ))}
    </div>
  )
}

/** What the stats line reports: Tests (passed/total), Repairs (cycle of the cap
 *  + the give-up short form), Services ("N/M booted", per-service tooltip), and
 *  the captured fixes as a link. Boot health is a different axis than the test
 *  verdict, so it stays its own fact. */
function runStats({
  summary,
  healCycles,
  healEnd,
  services,
  fixCapture,
  onOpenFixes,
}: {
  summary: RunDetail['summary'] | undefined
  healCycles: number
  healEnd: HealEnd | undefined
  services: RunDetail['manifest']['services'] | undefined
  /** The repair's captured diff, when the run left one. */
  fixCapture: RunDetail['manifest']['fixCapture'] | undefined
  /** Opens the run detail's Changes tab. Omitted when there is nowhere to go
   *  (no drill-through wired), and the fixes then aren't reported here at all —
   *  a count the user can't act on is worse than silence. */
  onOpenFixes?: () => void
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
  // The repair's edits, as a link rather than a surface. This used to be a whole
  // second card under the hero — three boxed repo cards, six buttons, three
  // accent-filled ones — restating what the run detail's Changes tab already owns
  // (the same RepairedRepoCard, plus the per-repo branch and PR state the stage
  // never had room for). The stage is the run's SUMMARY (R82), so it reports THAT
  // a fix was captured and where to review it; the actions live at the
  // destination.
  const fixRepos = fixCapture?.repos ?? []
  if (fixRepos.length > 0 && onOpenFixes) {
    stats.push({
      label: 'Fixes captured',
      value: plural(fixRepos.length, 'repo'),
      // Which repo, and how much of it — the one thing the old cards said that a
      // count can't. Same roll-up-gets-a-tooltip rule the Services segment uses.
      title: fixRepos.map((r) => `${r.repoName} · ${plural(r.files, 'file')}`).join('\n'),
      onClick: onOpenFixes,
      testId: 'run-hero-fixes',
    })
  }
  return stats
}

/** The run's LIVE controls, on the stage: Stop, and Cancel repair while healing.
 *  Same endpoints the run detail drives; all state flows back over the runs WS.
 *
 *  These two are RUN-scoped and the header's Pause is FLIGHT-scoped — and since
 *  pause now ends the run too, the only thing separating them is how much they
 *  stop. Each title says which, because three buttons that all read as "stop"
 *  is exactly how a user learns to trust none of them.
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
  mutationLockedReason,
}: {
  runId: string
  status: RunStatus
  active: boolean
  onError: (err: unknown) => void
  mutationLockedReason?: string
}) {
  if (!active) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="run-stage-controls">
      {active && status === 'healing' && (
        <DisabledControlTooltip>
          <button
            type="button"
            data-testid="run-stage-cancel-heal"
            disabled={mutationLockedReason != null}
            onClick={() => { api.cancelHealRun(runId).catch(onError) }}
            className="cl-button px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-45"
            title={mutationLockedReason ?? 'Stops the repair and keeps the failing result. The flight will ask what to do next.'}
          >
            Cancel repair
          </button>
        </DisabledControlTooltip>
      )}
      {active && (
        <DisabledControlTooltip>
          <button
            type="button"
            data-testid="run-stage-stop"
            disabled={mutationLockedReason != null}
            onClick={() => { api.stopRun(runId).catch(onError) }}
            className="cl-button px-2 py-0.5 text-[11px] text-danger disabled:cursor-not-allowed disabled:opacity-45"
            title={mutationLockedReason ?? 'Ends this run only — the flight keeps going and asks what to do next. Pause stops everything.'}
          >
            ⏹ Stop run
          </button>
        </DisabledControlTooltip>
      )}
    </div>
  )
}

/** Short, stable run reference for the identity line — the trailing token of
 *  the run id (`…-z6kc` → `z6kc`), falling back to the whole id. */
function shortRunRef(runId: string): string {
  const tail = runId.split(/[-_]/).pop()
  return tail && tail.length >= 3 ? tail : runId
}
