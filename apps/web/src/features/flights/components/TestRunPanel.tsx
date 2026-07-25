import { useEffect, useMemo, useState } from 'react'
import * as api from '../../../shared/api/client'
import type { FlightCheckpoint } from '../../../shared/api/client'
import type { HealEnd, JournalEntry, RunDetail, RunIndexEntry, RunStatus } from '../../../shared/api/types'
import { PanelCard } from '../../../shared/ui/PanelCard'
import { RunRow } from '../../runs/components/RunRow'
import { FixesCapturedPanel } from '../../runs/components/FixesCapturedPanel'
import { clientLabel } from '../../runs/components/external-client-branding'
import { FailingTests } from './FailingTests'
import { FactTile, STAGE_COLUMN, checkpointOptionLabel, healEndLine, healEndShort, type StageFact } from './stage-meta'

// R80 — the Test Run hero. Before this, the run stage rendered the SAME run
// three-to-four times: the "At a glance" facts card, the RunRepairSummary's own
// second facts card, the runs-list row, and the checkpoint message. The panel
// was organized by DATA SOURCE, so one run's verdict + pass count repeated.
//
// This renders the run as ONE object: an identity row (RunRow chrome), a metric
// row (Tests · Repairs · Services tiles), the failing tests worst-first, the run
// controls, and — when the run parked on `run-failed` — the decision footer
// fused right here with the give-up reason as its "why" line. Below the hero:
// the earlier runs for this feature. It is the SINGLE poller for the run stage
// (one 5s interval: run detail + journal + runs list).

/** Display cap for the repair-cycle stepper — mirrors the server's
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
  flightId,
  feature,
  runId,
  live,
  evidence,
  checkpoint,
  onResponded,
  onOpenRun,
  onError,
}: {
  flightId: string
  feature: string
  runId: string
  /** A run for this feature is active right now — drives the poll cadence. */
  live: boolean
  evidence: RunStageEvidence
  /** The run-failed checkpoint when the flight is parked on it; the hero fuses
   *  its decision footer. Null for any other state. */
  checkpoint: FlightCheckpoint | null
  onResponded: () => void
  onOpenRun?: (feature: string, runId: string) => void
  onError?: (msg: string) => void
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [runs, setRuns] = useState<RunIndexEntry[]>([])
  // Bumped after a PR is opened so the poll re-runs and picks up proposedPrs
  // even on a settled (non-polling) run.
  const [reloadKey, setReloadKey] = useState(0)

  // One poller for the whole run stage — run detail, heal journal, and the
  // feature's run list on a single interval. Gentle 5s cadence while anything
  // is live; a single load once settled.
  useEffect(() => {
    let alive = true
    const load = (): void => {
      api.getRunDetail(runId).then((d) => { if (alive) setDetail(d) }).catch(() => {})
      api.listJournal({ run: runId }).then((j) => { if (alive) setJournal(j) }).catch(() => {})
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
  const earlier = featureRuns.filter((r) => r.runId !== runId).slice(0, 5)

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

  const tiles = runTiles({ summary, healCycles, healEnd, services: manifest?.services })
  const failing = summary?.failed ?? []
  const active = live && (status === 'running' || status === 'healing')
  const runRef = shortRunRef(runId)

  const report = (err: unknown): void => onError?.(err instanceof Error ? err.message : String(err))

  return (
    <div className={`flex flex-col gap-3 ${STAGE_COLUMN}`} data-testid="test-run">
      <PanelCard kicker="Latest run" testId="test-run-hero">
        <ul className="m-0 list-none p-0">
          <RunRow
            run={currentEntry}
            detail={detail ?? undefined}
            primaryLabel={`Run ${runRef}`}
            marker={ordinal != null ? `run ${ordinal} of ${featureRuns.length}` : undefined}
            showPorts={false}
            promotePassCount
            onSelect={() => onOpenRun?.(feature, runId)}
          />
        </ul>

        {tiles.length > 0 && (
          <div
            data-testid="run-hero-tiles"
            className="mt-1 grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
          >
            {tiles.map((f, i) => <FactTile key={`${f.label}-${i}`} fact={f} />)}
          </div>
        )}

        {/* What failed, and why. Every failure is expandable to its assertion
            error + snippet — the summary has carried that all along and the
            old truncated-slug list threw it away. */}
        <FailingTests failing={failing} knownTests={summary?.knownTests} />

        <RunControls runId={runId} status={status} active={active} onError={report} />

        {/* External heal: the repair runs in the user's own MCP client, so there
            is no Canary transcript to embed — an honest status line, with the
            full picture one drill-through away on the run detail. */}
        {manifest?.healMode === 'external' && (
          <div data-testid="run-hero-external" className="mt-2 text-[11px] text-muted">
            {externalHealNote(manifest.externalHealSession)}
          </div>
        )}

        {checkpoint?.kind === 'run-failed' && (
          <RunDecisionFooter
            flightId={flightId}
            checkpoint={checkpoint}
            whyLine={healEndLine(healEnd) ?? checkpoint.message}
            onResponded={onResponded}
          />
        )}

        <RunActivityDisclosure journal={journal} live={active} />
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

      {earlier.length > 0 && (
        <div data-testid="earlier-runs">
          <h3 className="cl-rubric mb-1">Earlier runs</h3>
          <ul className="m-0 flex list-none flex-col gap-1 rounded border border-line p-1">
            {earlier.map((r) => (
              <RunRow key={r.runId} run={r} detail={undefined} showPorts={false} onSelect={(run) => onOpenRun?.(feature, run.runId)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** The metric tiles: Tests (passed/total + bar), Repairs (cycles + stepper +
 *  give-up short form), Services ("N/M booted", per-service tooltip). Boot
 *  health is a different axis than the test verdict, so it keeps its own tile. */
function runTiles({
  summary,
  healCycles,
  healEnd,
  services,
}: {
  summary: RunDetail['summary'] | undefined
  healCycles: number
  healEnd: HealEnd | undefined
  services: RunDetail['manifest']['services'] | undefined
}): StageFact[] {
  const tiles: StageFact[] = []
  if (summary && summary.total > 0) {
    const allGreen = summary.passed === summary.total
    tiles.push({
      label: 'Tests passed',
      value: `${summary.passed}/${summary.total}`,
      big: true,
      bar: summary.total > 0 ? summary.passed / summary.total : 0,
      tone: allGreen ? 'good' : 'warn',
    })
  }
  // Repairs: 0 cycles on a clean run reads "0" with no stepper; any cycle shows
  // the stepper toward the cap and, if the loop gave up, the reason short form.
  const short = healEndShort(healEnd)
  tiles.push({
    label: 'Repair cycles',
    value: String(healCycles),
    big: true,
    ...(healCycles > 0 ? { stepper: [Math.min(healCycles, REPAIR_CYCLE_CAP), REPAIR_CYCLE_CAP] as [number, number] } : {}),
    ...(short ? { sub: short } : {}),
    ...(healCycles === 0 && !short ? { tone: 'good' as const } : {}),
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
    tiles.push({
      label: 'Services',
      value: `${booted}/${svc.length} booted`,
      title: tooltip,
      tone: booted === svc.length ? 'good' : 'bad',
    })
  }
  return tiles
}

/** The run's own controls, on the stage: Stop / Cancel repair while live,
 *  Restart once it has settled non-green. Same endpoints the run detail drives;
 *  all state flows back over the runs WS. */
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
  const canRestart = !active && (status === 'failed' || status === 'aborted')
  if (!active && !canRestart) return null
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
      {canRestart && (
        <button
          type="button"
          data-testid="run-stage-restart"
          onClick={() => { api.restartRun(runId).catch(onError) }}
          className="cl-button px-2 py-0.5 text-[11px] text-accent"
          title="Re-run the remaining/failed tests on the same run"
        >
          ▸ Restart run
        </button>
      )}
    </div>
  )
}

/** The run-failed decision, fused into the hero: the give-up reason as the
 *  "why" line, then the flight's own options (Start a new run / Export as-is).
 *  Other checkpoint kinds still render the generic CheckpointControls card. */
function RunDecisionFooter({
  flightId,
  checkpoint,
  whyLine,
  onResponded,
}: {
  flightId: string
  checkpoint: FlightCheckpoint
  whyLine: string
  onResponded: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const respond = (choice: string): void => {
    setBusy(true)
    setFailure(null)
    api.respondFlightCheckpoint(flightId, { choice })
      .then(() => onResponded())
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  const options = checkpoint.options ?? []
  return (
    <div
      data-testid="run-decision-footer"
      className="mt-2.5 flex flex-col gap-2 rounded-md border border-warning/25 bg-warning/8 px-3 py-2.5"
    >
      <p className="text-[12px] text-secondary">{whyLine}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((option, i) => (
          <button
            key={option}
            type="button"
            data-testid={`checkpoint-choice-${option}`}
            disabled={busy}
            onClick={() => respond(option)}
            className={`cl-button inline-flex items-center gap-1.5 px-2.5 py-1 text-xs${i === 0 ? ' border-accent/45 text-accent' : ''}`}
            title={option}
          >
            {checkpointOptionLabel('run-failed', option)}
            {i === 0 && <span data-testid="checkpoint-recommended" className="cl-badge-accent">Recommended</span>}
          </button>
        ))}
      </div>
      {failure && <div className="text-[11px] text-danger">{failure}</div>}
    </div>
  )
}

/** The run stage is agentless at the flight level (its repair agent's timeline
 *  lives on the run detail drill-through), so the standing activity band was
 *  dead weight here. What's worth keeping — what each repair cycle attempted —
 *  folds into one collapsed disclosure, expanded only while live. */
function RunActivityDisclosure({
  journal,
  live,
}: {
  journal: JournalEntry[]
  live: boolean
}) {
  const cycles = [...journal]
    .filter((e) => e.iteration != null)
    .sort((a, b) => (b.iteration ?? 0) - (a.iteration ?? 0))
    .slice(0, REPAIR_CYCLE_CAP)
  const [open, setOpen] = useState<boolean | null>(null)
  if (cycles.length === 0) return null
  const isOpen = open ?? live
  return (
    <div className="mt-2.5" data-testid="run-activity">
      <button
        type="button"
        data-testid="run-activity-toggle"
        aria-expanded={isOpen}
        onClick={() => setOpen(!isOpen)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="cl-rubric">Repairs</span>
        <span className="h-px flex-1 border-t border-dashed border-line" />
        <span className="cl-button px-2 py-0.5 text-[11px]">{isOpen ? '▾ Hide' : `▸ ${cycles.length}`}</span>
      </button>
      {isOpen && (
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0" data-testid="repair-journal">
          {cycles.map((entry) => (
            <li key={entry.iteration ?? entry.timestamp ?? entry.body.slice(0, 24)} className="text-[11.5px] text-secondary">
              <span className={entry.outcome === 'passed' ? 'text-success' : 'text-muted'}>
                Cycle {entry.iteration ?? '?'}{entry.outcome ? ` · ${entry.outcome}` : ''}
              </span>
              {entry.hypothesis ? ` — ${truncate(entry.hypothesis, 90)}` : ''}
            </li>
          ))}
        </ul>
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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
