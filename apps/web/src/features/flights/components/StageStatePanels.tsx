import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightManifest, FlightStage, FlightStageErrorDetail, FlightStageRemedy } from '@/shared/api/client'
import { PANEL_CARD_CLASS, PANEL_CARD_STYLE } from '@/shared/ui/PanelCard'
import { stageLabel, STAGE_COLUMN, stageStateLine } from './stage-meta'
import { CheckpointControls } from './CheckpointControls'
import { truncate } from './StageDetail'

/** R73: the one failure card every stage renders when it fails — a danger-toned
 *  twin of CheckpointControls, so a crash reads with the same weight as a
 *  checkpoint instead of a bare red line. Names what failed and shows the raw
 *  detail in a scrollable mono block (these messages run long). Recovery is the
 *  header's state primary (Continue / Repeat a step…), not a second button here
 *  — one Continue, no confusion. Width is capped to line up with the repo-scan
 *  cards above (both on STAGE_COLUMN) so the stage reads as one column, not a full-bleed
 *  banner under narrow cards. */
export function StageErrorPanel({ flightId, stageLabel, detail, errorDetail }: {
  flightId: string
  stageLabel: string
  detail: string
  /** Boot-failure evidence (service log tail + path) — rendered under the
   *  verdict so the CAUSE is on the stage, not a log-dig away. */
  errorDetail?: FlightStageErrorDetail
}) {
  const logName = errorDetail?.logPath ? errorDetail.logPath.split('/').pop() : null
  // Machine-actionable fix, derived server-side at read time (live git
  // status) — null when this error has no known remedy. Executing it cleans
  // the repos and resumes the flight; the WS flights-changed refresh then
  // replaces this panel with the retried stage.
  const [remedy, setRemedy] = useState<FlightStageRemedy | null>(null)
  const [remedyBusy, setRemedyBusy] = useState<'stash' | 'commit' | null>(null)
  const [remedyError, setRemedyError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.getFlightRemedy(flightId)
      .then((r) => { if (!cancelled) setRemedy(r.remedy) })
      .catch(() => {}) // no remedy is the quiet default — the raw error stands
    return () => { cancelled = true }
  }, [flightId, detail])
  const runRemedy = (action: 'stash' | 'commit') => {
    setRemedyBusy(action)
    setRemedyError(null)
    api.applyFlightRemedy(flightId, action)
      .catch((err) => {
        setRemedyError(err instanceof Error ? err.message : String(err))
        // Partial failures leave some repos cleaned — re-read so the rows match.
        api.getFlightRemedy(flightId).then((r) => setRemedy(r.remedy)).catch(() => {})
      })
      .finally(() => setRemedyBusy(null))
  }
  return (
    <section
      data-testid="stage-error"
      className={`flex flex-col gap-2.5 rounded-lg border border-danger/45 bg-danger/6 p-3 ${STAGE_COLUMN}`}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-danger">✕</span>
        <span data-testid="stage-error-title" className="text-[12.5px] font-semibold text-danger">
          {stageLabel} failed
        </span>
      </div>
      <p className="text-[12px] text-secondary">
        This step stopped on the error below. Fix it, then hit Continue at the top to try again.
      </p>
      <pre
        data-testid="stage-error-detail"
        className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-[10.5px] border-line bg-canvas text-secondary font-mono"
      >
        {detail}
      </pre>
      {errorDetail?.logTail && (
        <>
          <div className="cl-rubric">
            Last lines of {logName ?? 'the service log'}
          </div>
          <pre
            data-testid="stage-error-log-tail"
            className="m-0 max-h-[220px] overflow-auto whitespace-pre rounded border p-2 text-[10.5px] leading-relaxed border-line bg-canvas text-secondary font-mono"
          >
            {errorDetail.logTail}
          </pre>
        </>
      )}
      {errorDetail?.logPath && (
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            data-testid="stage-error-open-log"
            onClick={() => { api.openEditor({ file: errorDetail.logPath }).catch(() => {}) }}
            className="cl-button min-h-6 shrink-0 px-2 py-0.5 text-[11px] text-accent"
          >
            Open full service log
          </button>
          <span className="min-w-0 truncate text-[10px] text-muted font-mono" title={errorDetail.logPath}>
            {errorDetail.logPath}
          </span>
        </div>
      )}
      {remedy && (
        <div data-testid="stage-remedy" className="flex flex-col gap-2 border-t pt-2.5 border-line">
          <div className="cl-rubric">
            Recommended fix
          </div>
          {remedy.repos.length === 0 ? (
            // The error is stale: every repo is clean again (fixed by hand).
            <p className="text-[12px] text-secondary">
              The repos are clean again — hit Continue at the top to try again.
            </p>
          ) : (
            <>
              <p className="text-[12px] text-secondary">
                Clear the uncommitted changes and the flight will try this step again.
              </p>
              <div className="rounded border border-line">
                {remedy.repos.map((repo, i) => (
                  <div
                    key={repo.path}
                    className={`flex items-center gap-2 px-2.5 py-1.5${i > 0 ? ' border-t' : ''}`}
                    style={i > 0 ? { borderColor: 'var(--border-default)' } : undefined}
                    title={repo.path}
                  >
                    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                    <span className="text-[11.5px] text-primary font-mono">{repo.name}</span>
                    <span className="ml-auto text-[10px] text-muted font-mono">
                      {repo.modified} modified
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="stage-remedy-stash"
                  disabled={remedyBusy !== null}
                  onClick={() => runRemedy('stash')}
                  className="cl-button-primary px-2.5 py-1 text-xs"
                >
                  {remedyBusy === 'stash' ? 'Stashing…' : 'Stash and continue'}
                </button>
                <button
                  type="button"
                  data-testid="stage-remedy-commit"
                  disabled={remedyBusy !== null}
                  onClick={() => runRemedy('commit')}
                  className="cl-button px-2.5 py-1 text-xs text-accent"
                >
                  {remedyBusy === 'commit' ? 'Committing…' : 'Commit and continue'}
                </button>
              </div>
              <p className="text-[10.5px] text-muted">
                Stash is undoable — <span className="font-mono">git stash pop</span>. Commit uses <span className="font-mono">"canary-lab: wip"</span>.
              </p>
            </>
          )}
          {remedyError && (
            <p data-testid="stage-remedy-error" className="text-[11px] text-danger">{remedyError}</p>
          )}
        </div>
      )}
    </section>
  )
}

/** Which paused-resume narrative this stage carries, if any (null = not a
 *  resume point). Mirrors the two "Continue picks up here" branches in
 *  `stageStateLine` so the card and the state sentence never disagree:
 *   - `interrupted` — pending WITH a startedAt (a pause/restart flipped a
 *     running step back to pending but kept its timestamp);
 *   - `not-started` — the entry step of a paused flight, stopped before it
 *     began (nothing earlier is still ahead of it).
 *  Only ever true for the single stage Continue would enter at, so the card
 *  can't render on the later pending rows that are honestly just waiting. */
export function pausedResumeKind(stage: FlightStage, flight: FlightManifest): 'interrupted' | 'not-started' | null {
  if (flight.status !== 'paused' || stage.status !== 'pending') return null
  if (stage.startedAt) return 'interrupted'
  const idx = flight.stages.findIndex((s) => s.key === stage.key)
  const waitingOnEarlier = flight.stages
    .slice(0, idx < 0 ? 0 : idx)
    .some((s) => s.status !== 'done' && s.status !== 'skipped')
  return waitingOnEarlier ? null : 'not-started'
}

/** The paused twin of StageErrorPanel — the "how to pick this back up" card for
 *  a flight parked on a step with nothing else to show (no checkpoint, no
 *  error). Recovery stays the header's one Continue (R74 — "one Continue, no
 *  confusion"), so this card carries NO button; it names where the step stopped,
 *  reassures that finished work is kept, and points the eye up to the header
 *  control the void otherwise left the user hunting for. Quiet neutral card —
 *  a single amber status dot says "waiting on you"; no tinted band or wash
 *  (neutral surfaces, one accent). */
export function StagePausedPanel({ kind, compact = false }: {
  kind: 'interrupted' | 'not-started'
  /** R82: the stage already shows its own work below (the Test Run hero keeps
   *  the run on screen through a pause), so there is no void to fill — the same
   *  words render as ONE line instead of a full card that would push the actual
   *  evidence down. Card form is for a stage with nothing else to show. */
  compact?: boolean
}) {
  const interrupted = kind === 'interrupted'
  const heading = interrupted ? 'Paused part way' : 'Paused before this step'
  const rest = interrupted
    ? ' to pick this step up where it stopped. Earlier work is kept.'
    : ' to start this step. The earlier steps are already done.'
  // An ↑ points at the header control by direction, not by a brittle
  // "top-right" — matches the failed card's "Continue from the header".
  // The arrow is glued to the word (a hair of margin, no space character): the
  // arrow is part of the control's name here, and a full space made it read as
  // a separate glyph floating between "Use" and "Continue".
  const sentence = (
    <>
      Use{' '}
      <span className="whitespace-nowrap font-semibold text-accent">
        <span aria-hidden="true" className="mr-[0.08em]">↑</span>Continue
      </span> in the header{rest}
    </>
  )
  if (compact) {
    return (
      <div data-testid="stage-paused" className={`flex items-start gap-2 text-[12px] leading-snug text-secondary ${STAGE_COLUMN}`}>
        <span aria-hidden="true" className="cl-status-dot mt-[5px] shrink-0 bg-warning" style={{ height: '0.45rem', width: '0.45rem' }} />
        <span className="min-w-0">
          <span className="text-primary">{heading}.</span> {sentence}
        </span>
      </div>
    )
  }
  return (
    <section
      data-testid="stage-paused"
      /* Same slab as every other stage card (PanelCard's chrome), so a paused
         step doesn't read as a different kind of object. */
      className={`flex flex-col gap-2 ${PANEL_CARD_CLASS} ${STAGE_COLUMN}`}
      style={PANEL_CARD_STYLE}
    >
      <div className="cl-rubric flex items-center gap-2">
        <span aria-hidden="true" className="cl-status-dot bg-warning" style={{ height: '0.45rem', width: '0.45rem' }} />
        {heading}
      </div>
      <p className="m-0 text-[12px] leading-snug text-primary">{sentence}</p>
    </section>
  )
}
