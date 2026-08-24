import type { FlightManifest, FlightStageStatus } from '@/shared/api/client'
import { PANEL_CARD_CLASS, PANEL_CARD_STYLE, PANEL_KICKER_CLASS as SHARED_KICKER_CLASS } from '@/shared/ui/PanelCard'
import { StepList, StepRow, type StepState } from '@/shared/ui/StepList'
import { DisabledControlTooltip } from '@/shared/ui/Tooltip'
import { STAGE_COLUMN } from './stage-meta'
import { distinctRepoPaths } from './stage-metrics'

// Stage-specific panels for the flight detail view (R57/R58/R59) — each one a
// lens onto the SAME data its full surface owns (feature.config.cjs via the
// config-doc API, docs/ via the docs API), so edits here and edits there are
// the same write and stay live-synced through the existing WorkspaceEvents.

// ─── Repo Scan: intent then repos (R72c) ─────────────────────────────────────
// Keep the user-authored intent distinct from the repos the agent inspected.
// Env files and locations remain per-repo facts. Read-only: repos + intent
// freeze when the flight first starts.

export function repoBaseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
}

// Card chrome + kicker come from the shared primitive (shared/ui/PanelCard) so
// these panels and the stage facts card are literally the same surface.
export const PANEL_KICKER_CLASS = `mb-1 ${SHARED_KICKER_CLASS}`

/** Each repo row reports the SCAN's state, not the repo's existence (R83). The
 *  rows used to be hard-coded `done`, so a flight parked before the scan showed
 *  two green ticks for work that had not happened — the one claim on this panel
 *  that isn't flight input. */
export function repoRowState(status: FlightStageStatus): StepState {
  if (status === 'done' || status === 'skipped') return 'done'
  if (status === 'running') return 'active'
  if (status === 'failed') return 'failed'
  return 'pending'
}

export function RepoScanPanel({
  flight,
  status,
  envFiles = [],
  onChangeInputs,
  mutationLockedReason,
}: {
  flight: FlightManifest
  /** The scout stage's own status — drives each repo row's indicator. */
  status: FlightStageStatus
  envFiles?: string[]
  /** R75: opens the launcher (prefilled, editable) — changing intent/repos is
   *  a full restart, and the launcher is its one home. */
  onChangeInputs?: () => void
  /** External ownership keeps Change… visible but moves the mutation back to
   *  the Claude/Codex session. */
  mutationLockedReason?: string
}) {
  // One card per repository, not per configured entry — several services can
  // share a source tree (see distinctRepoPaths).
  const repos = distinctRepoPaths(flight.repoPaths)
  // Attribute each scanned env file to the repo that contains it.
  const envsFor = (repo: string): string[] =>
    envFiles
      .filter((f) => f === repo || f.startsWith(repo.replace(/[\\/]+$/, '') + '/'))
      .map((f) => f.slice(repo.replace(/[\\/]+$/, '').length + 1) || repoBaseName(f))
  const claimed = new Set(flight.repoPaths.flatMap((r) => envFiles.filter((f) => f.startsWith(r.replace(/[\\/]+$/, '') + '/'))))
  const orphans = envFiles.filter((f) => !claimed.has(f))

  return (
    <section
      data-testid="repo-scan-panel"
      className={`flex flex-col gap-2.5 ${STAGE_COLUMN}`}
      title="Repos and intent froze when this flight started. Change… reopens them and re-flies from the start."
    >
      <div
        data-testid="flight-intent-card"
        className={PANEL_CARD_CLASS}
        style={PANEL_CARD_STYLE}
      >
        <div className="flex items-baseline gap-2">
          <div className={PANEL_KICKER_CLASS}>
            Flight input
          </div>
          <div className="flex-1" />
          {onChangeInputs && (
            <DisabledControlTooltip>
              <button
                type="button"
                data-testid="flight-inputs-change"
                onClick={onChangeInputs}
                disabled={mutationLockedReason != null}
                // The negative margin grows the HIT area to ~24px without moving
                // the text — a bare 14px link was the pane's smallest target.
                className="-my-1.5 py-1.5 text-[10.5px] underline-offset-2 transition-colors hover:underline text-accent disabled:cursor-not-allowed disabled:opacity-45"
                title={mutationLockedReason ?? 'Change what this flight tests — reopens intent and repos prefilled, then re-flies from the start'}
              >
                Change…
              </button>
            </DisabledControlTooltip>
          )}
        </div>
        <h3 className="mb-1.5 text-[12.5px] font-semibold">Intent · what to test</h3>
        <p
          data-testid="flight-intent"
          className="m-0 max-w-[76ch] text-[12px] leading-relaxed text-secondary"
        >
          {flight.description}
        </p>
      </div>

      <div
        data-testid="repo-scan-card"
        className={PANEL_CARD_CLASS}
        style={PANEL_CARD_STYLE}
      >
        <div className={PANEL_KICKER_CLASS}>
          {repos.length === 1 ? 'Repo · scanned' : `Repos · ${repos.length} scanned`}
        </div>
        <StepList>
          {repos.map((p) => {
            const envs = envsFor(p)
            return (
              <StepRow
                key={p}
                testId={`repo-card-${repoBaseName(p)}`}
                state={repoRowState(status)}
                title={repoBaseName(p)}
                sub={
                  <span className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5">
                    <span className="cl-rubric">Location</span>
                    <span className="max-w-[340px] truncate text-[10px] text-secondary font-mono" title={p}>
                      {p}
                    </span>
                    {envs.length > 0 && (
                      <>
                        <span className="cl-rubric">Env</span>
                        <span className="max-w-[340px] truncate text-[10px] text-secondary font-mono" title={envs.join('\n')}>
                          {envs.join(' · ')}
                        </span>
                      </>
                    )}
                  </span>
                }
              />
            )
          })}
        </StepList>
        {orphans.length > 0 && (
          <div className="mt-2 border-t pt-2 text-[10px] border-line text-muted font-mono" title={orphans.join('\n')}>
            env outside repos: {orphans.map(repoBaseName).join(' · ')}
          </div>
        )}
      </div>
    </section>
  )
}
