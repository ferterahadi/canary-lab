import { useFlightStartDialog } from './use-flight-start-dialog'
import { type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type { FlightStageKey } from '@/shared/api/client'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import { ChevronRightIcon, Modal, StatusDot, Textarea, Toggle } from '@/shared/ui/atoms'
import { FLIGHT_OVERVIEW, STAGE_BLURB, STAGE_ICON, STAGE_LABEL, stageStatusTone } from './stage-meta'
import { RepoMultiPicker, type RepoOption } from './RepoMultiPicker'
import { PlanningView, ProposalView, StageRow } from './FlightStartProposal'

// R25/R40/R54/R63: the UI's flight launcher — THE entry point for flights.
// Two modes off one dialog:
//   • new-flight (feature == null, opened from "+ New"): asks exactly two
//     things — intent + repo list — then ALWAYS plans first (R54): the
//     breakdown agent judges whether the intent is one feature or several.
//     One feature → the flight starts straight away; several → a proposal
//     step (editable cards + token warning) that launches one flight per
//     feature, the first running and the rest queued sequentially.
//   • feature-scoped (existing behavior): the stage menu answers "where do you
//     want the pipeline to (re)start?", each row's clickability being the
//     SERVER's stage-entry verdict (GET /api/flights/entry), never a
//     client-side prerequisite guess. Repos + intent are FROZEN once a record
//     exists (R57/R63) — no repo section, intent read-only, the request body
//     omits both so the server reuses the stored values.
// Picking + Start posts the same /api/flights body the CLI and MCP send
// (four-surface parity), so continue / redo / jump behave identically here.

/** The pickable steps: stage keys minus `heal` (always run-driven — the server
 *  rejects it outright, so it isn't a choice) in execution order. `similarity`
 *  doubles as "the beginning": entering there is a full flight (mode `redo`
 *  when a record exists). */
const PICKABLE: FlightStageKey[] = [
  'similarity',
  'scout',
  'scaffold',
  'env-capture',
  'docs',
  'prd-summary',
  'specs-coverage',
  'portify',
  'run',
  'evaluation-export',
]

/** R76: one name for the full-restart entry across both dialogs (this launcher's
 *  stage list and the re-run dialog's lead row) — they perform the identical act
 *  (mode `redo`), so they can't read as two different things. */
export const START_FRESH_LABEL = 'Start fresh — from the beginning'

export const START_FRESH_BLURB = 'Change what it tests or which repos. Every finished step is redone.'

function rowLabel(key: FlightStageKey): string {
  return key === 'similarity' ? START_FRESH_LABEL : STAGE_LABEL[key]
}

/** The new-flight side of the dialog moves through three views (one per
 *  lifecycle state): the intent+repos form, the live planning agent, and the
 *  multi-feature proposal awaiting confirmation. */

/** R69 (concept C): one numbered step in the launch form — a badge + connector
 *  rail on the left, the section's title + content on the right, so the setup
 *  reads as an ordered sequence (intent → repos → launch). Every badge shares
 *  one solid, high-contrast treatment so the whole sequence reads as equally
 *  present — the accent is spent only on the primary action and the selected
 *  stage row, never on the step numbers. The last step drops its connector. */
function Step({
  n,
  title,
  last,
  children,
}: {
  n: number
  title?: string
  last?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center pt-0.5">
        <span
          aria-hidden="true"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-primary)',
          }}
        >
          {n}
        </span>
        {!last && <span className="mt-1 w-px flex-1" style={{ background: 'var(--border-strong)', minHeight: 14 }} />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? '' : 'pb-4'}`}>
        {title && (
          <div className="mb-1.5 text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            {title}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export function FlightStartDialog({
  feature,
  intent = 'refly',
  fromStage = null,
  resumePlanTaskId,
  newFlightPrefill,
  onClose,
  onOpenFlight,
}: {
  /** Feature to (re)fly, or null → new-flight mode (intent + repo picker). */
  feature: string | null
  /** R76: which job this launcher is open for. 'fresh' (the Repo-scan panel's
   *  Change… and the re-run dialog's Start fresh row) drops the stage menu
   *  entirely and locks the entry to a full restart — the only entry a changed
   *  intent/repo set is valid for. Ignored in new-flight mode, which is already
   *  intent-first. */
  intent?: FlightLauncherIntent
  /** R81: pre-pick this entry stage — the handoff from a DERIVED flight's
   *  "Continue from <stage>", where the stage was computed from on-disk
   *  evidence (the first step with nothing to show for it). The server's
   *  stage-entry validator still has the final say at submit. */
  fromStage?: FlightStageKey | null
  /** Reopen attached to a backgrounded pre-flight (plan-features) task — a
   *  Flights-pill pre-flight row routes this. New-flight mode only; the dialog
   *  fetches the task and drops straight into the planning/proposal view. */
  resumePlanTaskId?: string | null
  /** Open new-flight mode with the repo and intent already filled in — the
   *  first-run guide's one-click path onto the bundled sample repo. Seeds the
   *  fields the user would otherwise have to find; both stay editable. Ignored
   *  in feature-scoped mode, whose prefill comes from the flight's own record. */
  newFlightPrefill?: { repoPaths: string[]; description: string } | null
  /** Accepted for call-site compatibility (App still passes the flattened
   *  workspace repos); the picker now navigates the filesystem via the shared
   *  FolderPickerModal, so no seed list is needed. */
  knownRepos?: RepoOption[]
  onClose: () => void
  /** Navigate to the flight detail view (just-started or already-active). */
  onOpenFlight: (flightId: string) => void
}) {  const {
    resolvedFeature,
    entry,
    loadError,
    description,
    setDescription,
    repoPaths,
    setRepoPaths,
    picked,
    setPicked,
    busy,
    startError,
    showSteps,
    setShowSteps,
    autopilot,
    setAutopilot,
    agent,
    phase,
    planTask,
    proposal,
    setProposal,
    sharedGroup,
    setSharedGroup,
    conflicts,
    newFlight,
    byKey,
    lastStatus,
    hasRecord,
    editableInputs,
    inputsRequired,
    freshMode,
    canSubmit,
    startSingleFlight,
    launchProposal,
    stopAndStartFresh,
    start,
  } = useFlightStartDialog({ feature, intent, fromStage, resumePlanTaskId, newFlightPrefill, onOpenFlight, onClose })

  // The number of automated steps behind a full flight (every pickable stage
  // except the "from the beginning" entry itself) — drives the preview count.
  const stepCount = PICKABLE.filter((k) => k !== 'similarity').length

  const stageMenu = (
    <div
      className="flex flex-col gap-1.5"
      {...(freshMode ? { 'aria-label': 'The full flight' } : { role: 'radiogroup', 'aria-label': 'Start from' })}
    >
      {/* Continue sits above the fold — the common resume path, never buried in
          the collapsible journey list. Fresh mode has no resume: changing the
          inputs is the restart. */}
      {!newFlight && !freshMode && entry?.canContinue && (
        <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-default)' }}>
          <StageRow
            testId="flight-start-continue"
            selected={picked === 'continue'}
            onPick={() => setPicked('continue')}
            icon="▸"
            iconTone="var(--accent)"
            label="Continue where it left off"
            sub="Resumes the paused flight at its first open stage."
          />
        </div>
      )}

      {/* R69: the whole flight as a collapsible preview. Greyed + locked for a
          first flight (the journey, for the record); the live re-entry control
          once flown. */}
      <div className="overflow-hidden rounded border" style={{ borderColor: 'var(--border-default)' }}>
        <button
          type="button"
          data-testid="flight-steps-toggle"
          aria-expanded={showSteps}
          onClick={() => setShowSteps((v) => !v)}
          className="cl-hover-row flex w-full items-center gap-2 px-3 py-2 text-left"
          style={{ background: 'var(--bg-selected)' }}
        >
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 transition-transform duration-150"
            style={{ color: 'var(--text-muted)', transform: showSteps ? 'rotate(90deg)' : 'none' }}
          >
            <ChevronRightIcon />
          </span>
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>The full flight</span>
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{stepCount} steps, fully automated</span>
          {(newFlight || freshMode) && (
            <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-secondary)' }}>
              {freshMode ? 'every step re-runs' : 'start from any step after the first flight'}
            </span>
          )}
        </button>
        {showSteps && (
          <div className="flex flex-col">
            {PICKABLE.map((key, index) => {
              // New flights always start from the beginning: the whole menu
              // renders visible-but-locked so the re-entry affordance is
              // learnable (R41).
              const verdict = newFlight || freshMode ? undefined : byKey.get(key)
              const allowed = newFlight || freshMode ? key === 'similarity' : (verdict?.allowed ?? false)
              // Fresh mode wipes the last attempt, so its stage glyphs would be
              // lying about what survives — the bare pipeline number instead.
              const status = key === 'similarity' || freshMode ? undefined : lastStatus.get(key)
              // Every row explains what its stage does; a re-fly's BLOCKED rows
              // instead surface the server's specific prerequisite reason. The
              // uniform first-flight lock is stated once, on the section header.
              const sub = !newFlight && !freshMode && !allowed
                ? verdict?.reason
                // The full-restart row says what it COSTS once there's a record
                // to discard; on a first flight it's just the whole journey.
                : key === 'similarity' && hasRecord
                  ? START_FRESH_BLURB
                  : STAGE_BLURB[key]
              return (
                <StageRow
                  key={key}
                  testId={`flight-start-stage-${key}`}
                  selected={picked === key}
                  disabled={!allowed}
                  readOnly={freshMode}
                  onPick={() => setPicked(key)}
                  icon={status ? STAGE_ICON[status] : '·'}
                  iconTone={stageStatusTone(status)}
                  label={rowLabel(key)}
                  sub={sub}
                  step={index + 1}
                  divider
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )

  const errorBlock = startError && (
    <div data-testid="flight-start-error" className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}>
      {startError}
    </div>
  )

  // The form view (intent + repos + the collapsible step list) is the only view
  // whose content height swings with a disclosure toggle. Pin the modal height
  // there so expanding/collapsing "The full flight" scrolls the body (Modal
  // already renders a scrollable body + a stable gutter) instead of resizing
  // the whole dialog. The other views shrink-wrap as before.
  const formView =
    !loadError
    && !(!newFlight && !entry)
    && !(!newFlight && entry?.active)
    && !(newFlight && phase === 'planning')
    && !(newFlight && phase === 'proposal')

  // Pinned to the modal's footer strip (not the scrollable body) so the primary
  // action stays visible when the step list is expanded and the body scrolls.
  const formFooter = (
    <>
      <button type="button" onClick={onClose} className="cl-button px-3 py-1 text-xs">Cancel</button>
      <button
        type="button"
        data-testid="flight-start-submit"
        disabled={!canSubmit}
        onClick={start}
        className="cl-button-primary px-3.5 py-1 text-xs"
      >
        {busy
          ? 'Starting…'
          : newFlight ? 'Plan flight →'
            : freshMode ? 'Start fresh flight'
              : picked === 'continue' ? 'Continue flight' : 'Start flight'}
      </button>
    </>
  )

  return (
    <Modal
      open
      onClose={onClose}
      // Both form flavours carry the step-list disclosure, so both pin their
      // height and scroll the body instead of resizing the whole dialog.
      height={formView ? 'min(608px, calc(100vh - 2rem))' : undefined}
      footer={formView ? formFooter : undefined}
      icon={
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 2 11 13" />
          <path d="M22 2 15 22l-4-9-9-4Z" />
        </svg>
      }
      title={resolvedFeature ?? 'Start a flight'}
      description={
        freshMode
          ? 'Change what this suite tests. It re-flies from the beginning.'
          : hasRecord
            ? 'Re-fly this suite — pick which step it restarts from.'
            : FLIGHT_OVERVIEW
      }
      width={620}
      stableScrollGutter
    >
      <div className="flex flex-col gap-3 p-4">
        {loadError ? (
          <div data-testid="flight-start-error" className="text-[11.5px]" style={{ color: 'var(--danger)' }}>
            {loadError}
          </div>
        ) : !newFlight && !entry ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading stage options…</div>
        ) : !newFlight && entry?.active ? (
          // Attach, never a second start: the single-flight lock holds server-side.
          // R80: fresh intent lands here as a dead-end otherwise — the dialog
          // promised editable inputs, so it must say WHY they're unavailable and
          // offer the only path to them (stop, then start fresh).
          <div className="flex flex-col gap-2.5">
            {/* The sky running dot is the status vocabulary's own "in progress"
                — the sentence claims live state, so it carries the same cue the
                pills and stage rails use rather than asserting it in prose. */}
            <div className="flex items-center gap-2">
              <StatusDot state="running" />
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                It’s flying right now.
              </span>
            </div>
            {freshMode && (
              <div className="text-[11.5px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                Changing what it tests restarts the flight from the beginning — the current one stops and its results are wiped.
              </div>
            )}
            {errorBlock}
            {/* Open is the safe path out of this dead-end, so it takes the one
                accent-filled skin instead of accent text on neutral chrome.
                Stopping wipes the flight's results — the same destructive
                secondary treatment the cleanup and worktree panels use. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-testid="flight-start-open-active"
                onClick={() => onOpenFlight(entry.flight!.flightId)}
                className="cl-button-primary px-2.5 py-1 text-xs"
              >
                Open the running flight →
              </button>
              {freshMode && (
                <button
                  type="button"
                  data-testid="flight-start-stop-active"
                  disabled={busy}
                  onClick={stopAndStartFresh}
                  className="cl-button px-2.5 py-1 text-xs"
                  style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))' }}
                >
                  {busy ? 'Stopping…' : 'Stop it and start fresh'}
                </button>
              )}
            </div>
          </div>
        ) : newFlight && phase === 'planning' ? (
          <PlanningView
            task={planTask}
            busy={busy}
            error={errorBlock}
            onSkip={startSingleFlight}
          />
        ) : newFlight && phase === 'proposal' ? (
          <ProposalView
            proposal={proposal}
            conflicts={conflicts}
            sharedGroup={sharedGroup}
            busy={busy}
            error={errorBlock}
            onChange={setProposal}
            onGroupChange={setSharedGroup}
            onConfirm={launchProposal}
            onCancel={onClose}
          />
        ) : (
          <>
            {/* R69 (concept C): the launch form as a numbered sequence —
                intent → repos → the pipeline — so each section is unmistakably
                its own step. Repos folds out when a record already froze them. */}
            <div className="flex flex-col">
              <Step n={1} title="What should this flight test?">
                {hasRecord && !editableInputs ? (
                  // Frozen intent (R57/R75): locked while re-entering
                  // mid-pipeline — the surviving artifacts were built from it.
                  <blockquote
                    data-testid="flight-start-frozen-intent"
                    className="rounded border-l-2 py-1 pl-2.5 text-[12px]"
                    style={{ borderColor: 'var(--accent)', color: 'var(--text-secondary)' }}
                  >
                    {entry?.prefill.description || '—'}
                  </blockquote>
                ) : (
                  <Textarea
                    value={description}
                    onChange={setDescription}
                    minRows={hasRecord ? 3 : 5}
                    placeholder="e.g. the checkout flow end to end — see ~/Documents/checkout-brief.md"
                  />
                )}
                {hasRecord && !freshMode && (
                  <div className="mt-1.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                    {editableInputs
                      ? 'Prefilled from the last flight — editable because you’re starting from the beginning.'
                      : 'Locked, because earlier steps already used these. Pick "Start fresh — from the beginning" below to change them.'}
                  </div>
                )}
                {freshMode && (
                  <div className="mt-1.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                    Prefilled from the last flight.
                  </div>
                )}
              </Step>

              {/* Repos show whenever they can be sent: a record-less feature,
                  or a full restart (R75) — hidden only while frozen. */}
              {inputsRequired && (
                <Step n={2} title="Repos">
                  <RepoMultiPicker
                    selected={repoPaths}
                    onChange={setRepoPaths}
                  />
                </Step>
              )}

              {/* R76 follow-up: fresh mode shows the same journey, read-only —
                  it can't offer re-entry (a changed intent invalidates every
                  partial result), but hiding the list left the user guessing
                  what "re-flies from the beginning" actually runs. */}
              <Step n={inputsRequired ? 3 : 2} last>
                {stageMenu}
              </Step>
            </div>

            {/* R71/W4: autopilot — on by default; the flight asks only where a
                wrong guess would do damage (secrets, duplicate feature). A
                launch setting, not a step, so it drops the border-card that
                competed with the step list above — a hairline ties it to the
                form and the toggle stays the one accent. */}
            <div
              data-testid="flight-autopilot-toggle"
              className="mt-1 flex items-center gap-3 border-t pt-3"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[12px] font-medium">Autopilot</span>
                <span className="text-[10.5px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                  Answers the safe questions for you. Still stops for missing secrets or a name clash.
                </span>
              </span>
              <Toggle testId="flight-autopilot-checkbox" value={autopilot} onChange={setAutopilot} />
            </div>

            {hasRecord && (
              <div data-testid="flight-start-reset-note" className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                {freshMode
                  ? 'The last attempt is wiped first — docs, tests, saved settings, run and report.'
                  : picked === 'continue'
                    ? 'Continue picks up from the last state — nothing is wiped.'
                    : 'Restarting from a step throws away its results and everything after it — docs, tests, saved settings, run and report. Earlier steps are kept.'}
              </div>
            )}

            {errorBlock}
          </>
        )}
      </div>
    </Modal>
  )
}
