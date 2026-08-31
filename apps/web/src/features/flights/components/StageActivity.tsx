import { useEffect, type ReactNode } from 'react'
import type { FlightStageKey, SpecsCoverageProgress as SpecsCoverageProgressT } from '@/shared/api/client'
import { AgentSessionView, type AgentSessionSegmentSource, type AgentSessionSource, type ExternalSessionActivity } from '@/shared/ui/AgentSessionView'
import { StatusDot } from '@/shared/ui/atoms'
import { useResizableHeight } from '@/shared/ui/use-resizable-height'
import { PanelCard } from '@/shared/ui/PanelCard'
import { StepList, StepRow } from '@/shared/ui/StepList'
import { useEvaluationExportLog } from '@/features/evaluation'
import { StageColumn } from './stage-meta'

interface StageActivityRailProps {
  stageKey: FlightStageKey
  /** Present, including as null before task discovery, only for Report. */
  evaluationTaskId?: string | null
  /** The stage's one agent session, if it spawned one (flight agent, or the
   *  Evaluation Report's export task). Omitted for agentless stages — the rail
   *  then shows system rows alone. */
  source?: AgentSessionSource
  /** Ordered sessions for a stage that spawns more than once. Each segment
   *  keeps its own provenance and only the current entry tails live output. */
  sessionSources?: AgentSessionSegmentSource[]
  live: boolean
  settled: boolean
  log: string
  /** Extra system rows pinned at the very head of the rail, before the
   *  conductor's log — e.g. an evaluation task's build lifecycle or the
   *  `[external]` row when a run is repaired by an external MCP client. */
  leadingSystemRows?: string[]
  /** Compact provenance for work performed in the user's own agent. The full
   *  external monitors stay on their dedicated screens; Flight keeps the
   *  chronological rows. */
  externalSessions?: ExternalSessionActivity[]
  /** Explicit user choice owned by the Flight screen so it survives a stage
   *  switch. Undefined uses the stage's live/settled default. */
  open?: boolean
  onOpenChange: (open: boolean) => void
  /** Why this stage has no transcript, when the stage knows better than the
   *  generic "nothing ran here" fallback. A settled stage can hold real evidence
   *  and still have no session to replay — the agent ran in the user's own
   *  client, or its log was cleaned — and saying nothing ran contradicts the
   *  panels above it. */
  empty?: { title: string; body?: string }
}

/** The stage's activity band (R66): ONE consolidated block, identical for every
 *  stage. The conductor's `[tagged]` system lines and the stage's own agent
 *  timeline ride one `AgentSessionView` rail (system lines passed as
 *  `systemRows`, styled apart from the agent's rows). Agent stages tail their
 *  flight session; the Evaluation Report tails its export task; an agentless
 *  stage passes no `source` and shows system rows alone.
 *  Agent events come only from the CLI JSONL; `stage.log` contains compact
 *  conductor rows. Ordered stage sessions use their persisted start times to
 *  keep validation and pass-transition evidence between the sessions that
 *  surround it. Legacy manifests retain their old raw-chunk split. The band
 *  keeps a height the reader dragged, and folds to its label bar at the bottom
 *  of that same drag (R88). */
export function StageActivityRail({
  stageKey,
  evaluationTaskId,
  source,
  sessionSources,
  live,
  settled,
  log,
  leadingSystemRows = [],
  externalSessions = [],
  open: controlledOpen,
  onOpenChange,
  empty,
}: StageActivityRailProps) {
  // Report activity belongs to the export task, not any flight pass sidecars.
  const isReport = stageKey === 'evaluation-export'
  const exportRows = useExportTaskRows(isReport ? evaluationTaskId ?? null : null)
  const sessions = isReport ? undefined : sessionSources
  // The Activity boundary is stable for the lifetime of a stage. Before the
  // first run it stays collapsed with an honest empty state; once work starts it
  // opens in place instead of appearing as a new piece of page chrome.
  const open = controlledOpen ?? live
  // One height for every stage's Activity band: it is a reading preference, not
  // a property of the stage, so switching stages must not reset it. Collapse is
  // the same gesture's end stop rather than a button — see the bar below.
  const { height: activityHeight, dragging, handleProps } = useResizableHeight({
    storageKey: 'cl-activity-height',
    defaultPx: 208,
    minPx: 104,
    maxPx: 560,
    collapsePx: 72,
    collapsed: !open,
    onCollapsedChange: (next) => onOpenChange(!next),
  })
  const { pre, between, post } = splitSystemRows(log, { source, sessions, live })

  return (
    <section
      data-testid="stage-activity"
      /* Open, the band holds a height the reader chose — NOT `flex-1`, which
         gave a one-row hand-off the same ~400px box a hundred-row transcript
         gets, and NOT the content's height, which would creep down the page as
         an agent appends rows mid-stream. `max-h-[70%]` is the relative cap the
         pixel clamp can't express: a height dragged tall on a big window must
         not swallow a short pane. */
      className={`flex flex-col bg-elevated/22 ${open ? 'min-h-0 max-h-[70%] shrink-0' : 'shrink-0'}`}
      style={open ? { height: activityHeight } : undefined}
    >
      {/* R88: the labelled bar IS the panel's movable top edge — there is no
          Hide/Show button any more. Push the edge past the floor and the band
          folds to this bar; pull it back and the band returns at the height the
          reader had chosen. One control, not two: a button that only ever said
          "all the way open" or "all the way shut" was the coarse version of a
          gesture that already spans both. Double-click is the fast path for
          readers who want the old single click, and the bar is a focusable
          separator so arrows / Home / End / Enter reach every state without a
          pointer. Grabbing it costs no aim: the whole ~26px row is the target,
          where a 1px rule between panes would have replaced a real button with
          a hairline. */}
      <div
        {...handleProps}
        data-testid="stage-activity-resize"
        aria-label="Activity panel size"
        title="Drag to resize · drag down to hide · double-click to toggle"
        className={`cl-resize-bar flex items-center gap-2.5 py-0 pl-2.5 pr-2 select-none${dragging ? ' dragging' : ''}`}
      >
        <span className="cl-rubric flex items-center gap-1.5">
          {/* The same live pulse the stage's `generating` chip shows — echoed
              on the band so a folded rail still advertises that work is
              running inside it. The dot is the whole signal; a "running" word
              beside it said the same thing twice. It is `aria-hidden`, so the
              state rides the bar's accessible name instead — colour alone is
              not a status for a screen reader. */}
          {live && <StatusDot state="running" className="shrink-0" />}
          Activity
          {live && <span className="sr-only">— running</span>}
        </span>
        <span className="h-px flex-1 border-t border-dashed border-line" />
        {/* The grip is the only affordance left, so it has to read as one from
            rest — no hover-to-discover. It states the axis and nothing else;
            the words that used to live here were the button. */}
        <span aria-hidden className="cl-resize-grip" />
      </div>
      {open && (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-2">
          {/* ONE rail for EVERY stage. The conductor's system lines and the
              stage's agent timeline (flight agent, or the export task) share it;
              an agentless stage (no `source`) renders system rows alone. */}
          <AgentBlock>
            <AgentSessionView
              source={source}
              sessionSources={sessions}
              systemRows={{ pre: [...exportRows, ...leadingSystemRows, ...pre], between, post }}
              externalSessions={externalSessions}
              empty={empty ?? noActivityCopy(live, settled)}
            />
          </AgentBlock>
        </div>
      )}
    </section>
  )
}

/** Blank lines separate paragraphs in a log file but mean nothing on a rail:
 *  drop them once, for every log this band renders. */
function logRows(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '')
}

/** `[tag]` or `[tag@<iso>]` — the conductor stamps its own lines. Current
 *  multi-session manifests use those stamps plus session start times; the
 *  untagged-run fallback keeps historical manifests readable. */
function isTagged(line: string): boolean {
  return /^\[[\w-]+(?:@[^\]]+)?\]/.test(line)
}

/** The Report stage tails its export task instead of a flight agent session, so
 *  the task's build lifecycle rides the same rail. Every other stage passes a
 *  null id, which keeps the hook order identical across stages. */
function useExportTaskRows(taskId: string | null): string[] {
  const { log, watchTask } = useEvaluationExportLog(taskId)
  useEffect(() => {
    if (taskId) watchTask(taskId)
  }, [taskId, watchTask])
  return logRows(log)
}

/** Why the rail is empty, when the stage itself knows no better reason. A stage
 *  that has not started and one that finished leaving nothing to replay are
 *  different facts, and saying "nothing ran" for the second contradicts the
 *  evidence panels above it. */
function noActivityCopy(live: boolean, settled: boolean): { title: string; body: string } {
  if (live) return { title: 'Waiting for activity', body: 'Updates will appear here as this step runs.' }
  if (!settled) return { title: 'No activity yet', body: 'This step has not started.' }
  return { title: 'No activity recorded', body: 'There is no session or system log to replay for this step.' }
}

interface SplitSystemRows {
  pre: string[]
  between: string[][]
  post: string[]
}

/** Where the conductor's rows sit relative to the stage's agent sessions: `pre`
 *  before the first, `between[i]` between session i and i + 1, `post` after the
 *  last. Current manifests carry per-row timestamps; the two legacy splits
 *  reconstruct the same placement for flights recorded before them. A stage with
 *  no session at all has nothing to sit between, so every row is `pre`. */
function splitSystemRows(log: string, { source, sessions = [], live }: {
  source?: AgentSessionSource
  sessions?: AgentSessionSegmentSource[]
  live: boolean
}): SplitSystemRows {
  const lines = logRows(log)
  if (sessions.length > 0) {
    return splitTimestampedSystemRows(lines, sessions)
      ?? (sessions.length > 1
        ? splitLegacyMultiSessionSystemRows(lines, sessions.length)
        : splitLegacySingleSessionSystemRows(lines, live))
  }
  if (source !== undefined) return splitLegacySingleSessionSystemRows(lines, live)
  return { pre: lines, between: [], post: [] }
}

/** Keep one-session manifests readable whether they contain the old untagged
 *  transcript copy or only a compact spawn/result pair. */
function splitLegacySingleSessionSystemRows(lines: string[], live: boolean): SplitSystemRows {
  const firstUntagged = lines.findIndex((line) => !isTagged(line))
  if (firstUntagged >= 0) {
    let lastUntagged = firstUntagged
    for (let index = lines.length - 1; index >= firstUntagged; index--) {
      if (!isTagged(lines[index])) { lastUntagged = index; break }
    }
    return {
      pre: lines.slice(0, firstUntagged),
      between: [],
      post: lines.slice(lastUntagged + 1),
    }
  }
  if (live) return { pre: lines, between: [], post: [] }

  // A legacy single-session stage has no persisted start time. Split after its
  // spawn announcement so the timeline still sits where the agent ran.
  let splitAt = lines.length
  for (let index = lines.length - 1; index >= 0; index--) {
    if (isTagged(lines[index]) && lines[index].trimEnd().endsWith('…')) { splitAt = index + 1; break }
  }
  return { pre: lines.slice(0, splitAt), between: [], post: lines.slice(splitAt) }
}

/** Position current conductor rows without using a duplicate transcript as a
 *  separator. Returns null for an older manifest without usable timestamps. */
function splitTimestampedSystemRows(
  lines: string[],
  sessions: AgentSessionSegmentSource[],
): SplitSystemRows | null {
  const starts = sessions.map((session) => Date.parse(session.startedAt ?? ''))
  if (starts.some((startedAt) => !Number.isFinite(startedAt))) return null
  if (starts.some((startedAt, index) => index > 0 && startedAt < starts[index - 1])) return null

  const systemRows = lines.filter(isTagged)
  const stamped = systemRows.map((line) => {
    const match = /^\[[\w-]+@([^\]]+)\]/.exec(line)
    const at = Date.parse(match?.[1] ?? '')
    return Number.isFinite(at) ? { line, at } : null
  })
  if (stamped.some((row) => row === null)) return null

  const pre: string[] = []
  const between = Array.from({ length: Math.max(0, sessions.length - 1) }, () => [] as string[])
  const post: string[] = []
  for (const row of stamped) {
    if (!row) continue
    if (row.at <= starts[0]) {
      pre.push(row.line)
      continue
    }
    const nextSession = starts.findIndex((startedAt, index) => index > 0 && row.at <= startedAt)
    if (nextSession < 0) post.push(row.line)
    else between[nextSession - 1].push(row.line)
  }
  return { pre, between, post }
}

/** Preserve chronology for historical manifests, where maximal untagged runs
 *  were mirrored agent chunks used as invisible session separators. */
function splitLegacyMultiSessionSystemRows(lines: string[], sessionCount: number): SplitSystemRows {
  const pre: string[] = []
  const between = Array.from({ length: sessionCount - 1 }, () => [] as string[])
  const post: string[] = []
  let outputRuns = 0
  let inOutputRun = false

  for (const line of lines) {
    if (!isTagged(line)) {
      if (!inOutputRun) outputRuns += 1
      inOutputRun = true
      continue
    }
    inOutputRun = false
    if (outputRuns === 0) pre.push(line)
    else if (outputRuns >= sessionCount) post.push(line)
    else between[outputRuns - 1].push(line)
  }

  return { pre, between, post }
}

/** Frame for a stage's consolidated activity (R66): the conductor's system
 *  rows and the agent's own timeline share one bordered, scrolling rail. Fills
 *  its half of the stage pane; the rail's own header names the agent. */
export function AgentBlock({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-line">
      {children}
    </div>
  )
}

export function truncate(text: string, max: number): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What the live pass is doing right now, spelled out under its row. */
export function specsPhaseSub(phase: SpecsCoverageProgressT['phase'], gapsOpen: number): string {
  if (phase === 'authoring') return `writing tests to close the ${gapsOpen} open gap${gapsOpen === 1 ? '' : 's'}`
  if (phase === 'validating') return 'validating the authored specs'
  return 'mapping the specs against the requirements'
}

/** The specs↔coverage loop as a pass timeline (R27/R77): settled passes show
 *  what authoring bought (the ledger % after mapping — the number that feeds
 *  the NEXT pass's prompt) with a done ✓; the live pass pulses with its current
 *  half of author↔map. Rendered on the shared StepList so it matches every other
 *  stepped stage panel. Data is the adapter's structured progress, not parsed log.
 *
 *  R87 — the passes still AHEAD are the kicker's count chip, not rows. As rows
 *  they restated the ceiling the state line already gives ("Pass 2 of 5 — …"),
 *  and read as rounds SCHEDULED rather than allowed: the same misread that kept
 *  a pass stepper out of the facts band, where most loops close in two. Four
 *  "pending" rows also left one row in five carrying a result.
 *
 *  The chip drops the ceiling once the loop settles, because a loop that met
 *  target at 2 never spends the rest — "2 passes" is the whole fact. A FAILED
 *  loop keeps it, in danger tone: there, how close it got to its ceiling is the
 *  reason it stopped, and nothing else on the pane says so. */
export function SpecsPassTimeline({ progress, live, failed }: {
  progress: SpecsCoverageProgressT
  live: boolean
  failed: boolean
}) {
  const phaseLabel =
    // The same three phase words the state line above uses — one loop, one
    // vocabulary ("tests", never "specs", in product copy).
    progress.phase === 'authoring' ? 'writing tests' : progress.phase === 'validating' ? 'checking the new tests compile' : 'matching tests to requirements'
  if (!live && progress.passes.length === 0) return null
  // An older flight's progress may carry no ceiling at all — then the chip
  // reports position alone rather than inventing a denominator.
  const ceiling = Number.isFinite(progress.maxPasses) ? progress.maxPasses : null
  const spent = live ? progress.pass : progress.passes.length
  const count =
    ceiling != null && (live || failed) ? `${spent} / ${ceiling} max`
    : live ? `Pass ${spent}`
    : `${spent} pass${spent === 1 ? '' : 'es'}`
  return (
    <StageColumn>
      <PanelCard
        kicker="Passes"
        aside={
          <span
            data-testid="specs-pass-count"
            className="cl-count-chip"
            // The 15% mix is `Chip`'s own fill formula, so the one toned count
            // chip in the app matches every other fill chip rather than
            // introducing a second danger tint.
            style={failed ? { background: 'color-mix(in srgb, var(--danger) 15%, transparent)', color: 'var(--danger)' } : undefined}
          >
            {count}
          </span>
        }
        testId="specs-pass-timeline"
      >
        <StepList>
          {progress.passes.map((p) => (
            <StepRow
              key={p.pass}
              testId={`specs-pass-${p.pass}`}
              state={p.note ? 'warn' : 'done'}
              title={p.note ? `Pass ${p.pass} — ${p.note}` : `Pass ${p.pass} — authored → mapped`}
              sub={
                p.note
                  ? 'retried with the errors in the next prompt'
                  : `${p.coveragePct}% covered · ${p.gapsOpen} gap${p.gapsOpen === 1 ? '' : 's'} open`
              }
            />
          ))}
          {live && (
            <StepRow
              testId="specs-pass-live"
              state="active"
              title={`Pass ${progress.pass} — ${phaseLabel}…`}
              sub={specsPhaseSub(progress.phase, progress.gapsOpen)}
            />
          )}
        </StepList>
      </PanelCard>
    </StageColumn>
  )
}
