import { useState, type ReactNode } from 'react'
import type { SpecsCoverageProgress as SpecsCoverageProgressT } from '@/shared/api/client'
import { AgentSessionView, type AgentSessionSource } from '@/shared/ui/AgentSessionView'
import { StatusDot } from '@/shared/ui/atoms'
import { PanelCard } from '@/shared/ui/PanelCard'
import { StepList, StepRow } from '@/shared/ui/StepList'
import { StageColumn } from './stage-meta'

/** The stage's activity band (R66): ONE consolidated block, identical for every
 *  stage. The conductor's `[tagged]` system lines and the stage's own agent
 *  timeline ride one `AgentSessionView` rail (system lines passed as
 *  `systemRows`, styled apart from the agent's rows). Agent stages tail their
 *  flight session; the Evaluation Report tails its export task; an agentless
 *  stage passes no `source` and shows system rows alone.
 *  `stage.log` has no timestamps, so the split is positional: agent chunks are
 *  mirrored into the log untagged, so the first/last untagged line brackets the
 *  agent's slot (→ `pre` before it, `post` after); a settled log with no
 *  untagged lines splits after the last spawn announcement (a tagged line
 *  ending in `…`). Untagged middles never render as system rows — the timeline
 *  shows them richer. Expanded fills ~half the pane; one "▸ View activity"
 *  disclosure once settled. */
export function StageActivity({
  source,
  sourceKey,
  live,
  settled,
  log,
  leadingSystemRows = [],
}: {
  /** The stage's one agent session, if it spawned one (flight agent, or the
   *  Evaluation Report's export task). Omitted for agentless stages — the rail
   *  then shows system rows alone. */
  source?: AgentSessionSource
  /** Remount key — swaps the timeline when the specs loop flips authoring→map,
   *  or between export tasks. */
  sourceKey: string
  live: boolean
  settled: boolean
  log: string
  /** Extra system rows pinned at the very head of the rail, before the
   *  conductor's log — e.g. the `[external]` row when the run is being repaired
   *  by an external MCP client (no Canary session to tail). */
  leadingSystemRows?: string[]
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const lines = log.split('\n').filter((l) => l.trim() !== '')
  const hasSource = source !== undefined
  // A stage that hasn't started (pending — neither live nor settled) has no
  // activity to show. Suppress the whole rail when there's nothing real yet,
  // even for an agent stage whose `source` exists but has no session: otherwise
  // pending agent stages render an empty "No structured session log found" band
  // while pending agentless stages render nothing — the same waiting stage, two
  // different empty states. Once it's live or settled the rail always shows
  // (the live timeline, or the settled disclosure).
  const pending = !live && !settled
  const nothingYet = lines.length === 0 && leadingSystemRows.length === 0
  if (nothingYet && (!hasSource || pending)) return null
  const open = userToggled ?? !settled

  // `[tag]` or `[tag@<iso>]` — the conductor stamps its own lines; agent output
  // is mirrored untagged, which is what this split is looking for.
  const isTagged = (l: string): boolean => /^\[[\w-]+(?:@[^\]]+)?\]/.test(l)
  let pre = lines
  let post: string[] = []
  if (hasSource) {
    const firstUntagged = lines.findIndex((l) => !isTagged(l))
    if (firstUntagged >= 0) {
      let lastUntagged = firstUntagged
      for (let i = lines.length - 1; i >= firstUntagged; i--) {
        if (!isTagged(lines[i])) { lastUntagged = i; break }
      }
      pre = lines.slice(0, firstUntagged)
      post = lines.slice(lastUntagged + 1)
    } else if (!live) {
      // No agent chunks were mirrored — split after the adapters' spawn
      // announcement so the timeline still sits where the agent ran.
      let splitAt = lines.length
      for (let i = lines.length - 1; i >= 0; i--) {
        if (isTagged(lines[i]) && lines[i].trimEnd().endsWith('…')) { splitAt = i + 1; break }
      }
      pre = lines.slice(0, splitAt)
      post = lines.slice(splitAt)
    }
  }

  return (
    <section
      data-testid="stage-activity"
      className={`flex flex-col border-t border-line bg-elevated/22 ${open ? 'min-h-0 flex-1' : 'shrink-0'}`}
    >
      {/* R66: the boundary between the stage's detail (above) and its activity.
          One labelled bar for every stage; the toggle always rides it so the
          rail is collapsible in any state (default open while live / a fresh
          spawn, collapsed once settled — overridable per stage). */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <button
          type="button"
          data-testid="stage-details-toggle"
          aria-expanded={open}
          onClick={() => setUserToggled(!open)}
          className="flex flex-1 items-center gap-2.5 text-left"
        >
          <span className="cl-rubric flex items-center gap-1.5">
            {/* The same live pulse the stage's `generating` chip shows — echoed
                on the band so a collapsed rail still advertises that work is
                running inside it. */}
            {live && <StatusDot state="running" className="shrink-0" />}
            Activity
          </span>
          <span className="h-px flex-1 border-t border-dashed border-line" />
          <span className="cl-button px-2 py-0.5 text-[11px]">
            {open ? '▾ Hide' : '▸ Show'}
          </span>
        </button>
      </div>
      {open && (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          {/* ONE rail for EVERY stage. The conductor's system lines and the
              stage's agent timeline (flight agent, or the export task) share it;
              an agentless stage (no `source`) renders system rows alone. */}
          <AgentBlock>
            <AgentSessionView key={sourceKey} source={source} systemRows={{ pre: [...leadingSystemRows, ...pre], post }} />
          </AgentBlock>
        </div>
      )}
    </section>
  )
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
  if (phase === 'authoring') return `writing specs to close the ${gapsOpen} open gap${gapsOpen === 1 ? '' : 's'}`
  if (phase === 'validating') return 'validating the authored specs'
  return 'mapping the specs against the requirements'
}

/** The specs↔coverage loop as a pass timeline (R27/R77): settled passes show
 *  what authoring bought (the ledger % after mapping — the number that feeds
 *  the NEXT pass's prompt) with a done ✓; the live pass pulses with its current
 *  half of author↔map; the passes still ahead sit as quiet pending rows so
 *  "3 passes to go" is visible, not inferred. Pending is live-only — a loop that
 *  met target early never spends the rest. Rendered on the shared StepList so it
 *  matches every other stepped stage panel. Data is the adapter's structured
 *  progress, not parsed log. */
export function SpecsPassTimeline({ progress, live }: { progress: SpecsCoverageProgressT; live: boolean }) {
  const phaseLabel =
    progress.phase === 'authoring' ? 'authoring tests' : progress.phase === 'validating' ? 'validating specs' : 'mapping coverage'
  if (!live && progress.passes.length === 0) return null
  const pending =
    live && Number.isFinite(progress.maxPasses)
      ? Array.from({ length: Math.max(0, progress.maxPasses - progress.pass) }, (_, i) => progress.pass + 1 + i)
      : []
  return (
    <StageColumn>
      <PanelCard kicker="Passes" testId="specs-pass-timeline">
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
          {pending.map((n) => (
            <StepRow key={n} testId={`specs-pass-pending-${n}`} state="pending" title={`Pass ${n} — pending`} />
          ))}
        </StepList>
      </PanelCard>
    </StageColumn>
  )
}
