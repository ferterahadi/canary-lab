import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '../../../shared/api/client'
import type {
  FlightEntryOptions,
  FlightStageEntryOption,
  FlightStageKey,
  FlightStageStatus,
  PlanFeaturesTask,
  PlannedFeature,
} from '../../../shared/api/client'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'
import { ChevronRightIcon, Modal, Textarea } from '../../config/components/atoms'
import { STAGE_ICON, STAGE_LABEL, stageStatusTone } from './stage-meta'
import { RepoMultiPicker, type RepoOption } from './RepoMultiPicker'

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

function rowLabel(key: FlightStageKey): string {
  return key === 'similarity' ? 'Full flight — from the beginning' : STAGE_LABEL[key]
}

const FIRST_FLIGHT_REASON = "available after this feature's first flight"

/** The new-flight side of the dialog moves through three views (one per
 *  lifecycle state): the intent+repos form, the live planning agent, and the
 *  multi-feature proposal awaiting confirmation. */
type NewFlightPhase = 'form' | 'planning' | 'proposal'

export function FlightStartDialog({
  feature,
  onClose,
  onOpenFlight,
}: {
  /** Feature to (re)fly, or null → new-flight mode (intent + repo picker). */
  feature: string | null
  /** Accepted for call-site compatibility (App still passes the flattened
   *  workspace repos); the picker now navigates the filesystem via the shared
   *  FolderPickerModal, so no seed list is needed. */
  knownRepos?: RepoOption[]
  onClose: () => void
  /** Navigate to the flight detail view (just-started or already-active). */
  onOpenFlight: (flightId: string) => void
}) {
  // A new-flight submit that hits the existing-record 409 switches the dialog
  // itself into feature-scoped mode (R67) — resolvedFeature drives everything
  // the `feature` prop used to.
  const [resolvedFeature, setResolvedFeature] = useState<string | null>(feature)
  const [entry, setEntry] = useState<FlightEntryOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [repoPaths, setRepoPaths] = useState<string[]>([])
  const [picked, setPicked] = useState<FlightStageKey | 'continue' | null>(feature ? null : 'similarity')
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  // R69: the full-flight step list is a collapsible preview — the whole journey
  // shown by default (greyed + locked for a first flight, the real re-entry
  // control once flown), collapsible to get it out of the way.
  const [showSteps, setShowSteps] = useState(true)

  // R54 plan flow state.
  const [phase, setPhase] = useState<NewFlightPhase>('form')
  const [planTask, setPlanTask] = useState<PlanFeaturesTask | null>(null)
  const [proposal, setProposal] = useState<PlannedFeature[]>([])
  const [sharedGroup, setSharedGroup] = useState('')
  const [conflicts, setConflicts] = useState<string[]>([])
  const autoLaunched = useRef(false)

  const newFlight = resolvedFeature === null

  useEffect(() => {
    if (newFlight) return
    let alive = true
    api.getFlightEntryOptions(resolvedFeature)
      .then((options) => {
        if (!alive) return
        setEntry(options)
        setDescription(options.prefill.description)
        setRepoPaths(options.prefill.repoPaths)
        setPicked(options.canContinue ? 'continue' : null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => { alive = false }
  }, [resolvedFeature, newFlight])

  // Planning: poll the task until the agent settles. Attach-or-start means the
  // task may already be done on the first poll.
  useEffect(() => {
    if (planTask?.status !== 'running') return
    const id = setInterval(() => {
      api.getPlanFeaturesTask(planTask.taskId).then(setPlanTask).catch(() => {})
    }, 1500)
    return () => clearInterval(id)
  }, [planTask?.taskId, planTask?.status])

  // A settled plan advances the phase: one feature starts without another
  // click; several become the proposal step.
  useEffect(() => {
    if (planTask?.status !== 'done' || !planTask.result) return
    const features = planTask.result.features
    if (features.length <= 1) {
      if (autoLaunched.current) return
      autoLaunched.current = true
      api.launchPlannedFeatures(planTask.taskId, { features })
        .then(({ flightIds }) => onOpenFlight(flightIds[0]))
        .catch((err: unknown) => {
          // A name collision on the single feature still needs the user —
          // surface the proposal card so they can rename it.
          autoLaunched.current = false
          applyLaunchFailure(err)
          setProposal(features)
          setSharedGroup(features[0]?.group ?? '')
          setPhase('proposal')
        })
      return
    }
    setProposal(features)
    setSharedGroup(features.find((f) => f.group)?.group ?? '')
    setPhase('proposal')
  }, [planTask, onOpenFlight])

  const applyLaunchFailure = (err: unknown): void => {
    const body = err instanceof api.ApiError
      ? (err.body as { error?: string; type?: string; conflicts?: string[] } | null)
      : null
    if (body?.type === 'feature_name_conflicts') setConflicts(body.conflicts ?? [])
    setStartError(body?.error ?? (err instanceof Error ? err.message : String(err)))
    setBusy(false)
  }

  const byKey = useMemo(() => {
    const map = new Map<FlightStageKey, FlightStageEntryOption>()
    for (const s of entry?.stages ?? []) map.set(s.key, s)
    return map
  }, [entry])
  const lastStatus = useMemo(() => {
    const map = new Map<FlightStageKey, FlightStageStatus>()
    for (const s of entry?.flight?.stages ?? []) map.set(s.key, s.status)
    return map
  }, [entry])

  const derivedFeature = newFlight && repoPaths.length > 0 ? api.deriveFeatureSlug(repoPaths[0]) : null
  // Frozen once flown (R57): a record means repos + intent are fixed forever —
  // the form neither shows the picker nor sends the values.
  const hasRecord = !newFlight && entry?.flight != null
  const needsArgs = newFlight || (entry !== null && entry.flight === null)

  const canSubmit = newFlight
    ? !busy && description.trim() !== '' && repoPaths.length > 0
    : entry !== null && !entry.active && !busy && picked !== null
      && (!needsArgs || (description.trim() !== '' && repoPaths.length > 0))

  const openFlightFail = (err: unknown): void => {
    const body = err instanceof api.ApiError
      ? (err.body as { error?: string; type?: string; flightId?: string } | null)
      : null
    // The derived feature already has a flight record → flip the dialog into
    // feature-scoped mode instead of surfacing a raw conflict (R67).
    if (body?.type === 'flight_exists_requires_choice' && derivedFeature) {
      setBusy(false)
      setStartError(null)
      setPhase('form')
      setResolvedFeature(derivedFeature)
      return
    }
    setStartError(body?.error ?? (err instanceof Error ? err.message : String(err)))
    setBusy(false)
  }

  /** R54: the new-flight primary action — run the breakdown agent first. */
  const planFlight = (): void => {
    if (busy) return
    setBusy(true)
    setStartError(null)
    api.planFeatures({ repoPaths, description: description.trim() })
      .then((task) => {
        setPlanTask(task)
        setPhase('planning')
        setBusy(false)
      })
      .catch(openFlightFail)
  }

  /** The planning escape hatch — one flight for the whole intent, no agent. */
  const startSingleFlight = (): void => {
    if (busy) return
    setBusy(true)
    setStartError(null)
    api.startFlight({
      feature: derivedFeature ?? 'feature',
      repoPaths,
      description: description.trim(),
    })
      .then((manifest) => onOpenFlight(manifest.flightId))
      .catch(openFlightFail)
  }

  /** Proposal confirm: one flight per card, sequentially queued (R54). */
  const launchProposal = (): void => {
    if (busy || !planTask) return
    setBusy(true)
    setStartError(null)
    setConflicts([])
    const features = proposal.map((f) => ({
      ...f,
      ...(sharedGroup.trim() ? { group: sharedGroup.trim() } : {}),
    }))
    api.launchPlannedFeatures(planTask.taskId, { features })
      .then(({ flightIds }) => onOpenFlight(flightIds[0]))
      .catch(applyLaunchFailure)
  }

  const start = (): void => {
    if (busy) return
    if (newFlight) { planFlight(); return }
    if (!entry || picked === null) return
    setBusy(true)
    setStartError(null)
    const body: api.StartFlightBody = {
      feature: resolvedFeature!,
      // Frozen args (R57): with a record, omit repos + intent — the server
      // reuses the stored values (and 409s on differing ones).
      ...(needsArgs ? { repoPaths, description: description.trim() } : {}),
      env: entry.prefill.env,
      coverageTarget: entry.prefill.coverageTarget,
      ...(picked === 'continue'
        ? { mode: 'continue' as const }
        : picked === 'similarity'
          ? (hasRecord ? { mode: 'redo' as const } : {})
          : { ...(hasRecord ? { mode: 'jump' as const } : {}), fromStage: picked }),
    }
    api.startFlight(body)
      .then((manifest) => onOpenFlight(manifest.flightId))
      .catch(openFlightFail)
  }

  // The number of automated steps behind a full flight (every pickable stage
  // except the "from the beginning" entry itself) — drives the preview count.
  const stepCount = PICKABLE.filter((k) => k !== 'similarity').length

  const stageMenu = (
    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Start from">
      {/* Continue sits above the fold — the common resume path, never buried in
          the collapsible journey list. */}
      {!newFlight && entry?.canContinue && (
        <StageRow
          testId="flight-start-continue"
          selected={picked === 'continue'}
          onPick={() => setPicked('continue')}
          icon="▸"
          iconTone="rgb(56, 189, 248)"
          label="Continue where it left off"
          sub="Resumes the paused flight at its first open stage."
        />
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
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
          style={{ background: 'var(--bg-selected)' }}
        >
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 transition-transform duration-150"
            style={{ color: 'var(--text-muted)', transform: showSteps ? 'rotate(90deg)' : 'none' }}
          >
            <ChevronRightIcon />
          </span>
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>The full flight</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{stepCount} steps, fully automated</span>
          {newFlight && (
            <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
              step entry unlocks after the first flight
            </span>
          )}
        </button>
        {showSteps && (
          <div className="flex flex-col gap-0.5 p-1.5">
            {PICKABLE.map((key) => {
              // New flights always start from the beginning: the whole menu
              // renders visible-but-locked so the re-entry affordance is
              // learnable (R41).
              const verdict = newFlight
                ? { key, allowed: key === 'similarity', reason: key === 'similarity' ? undefined : FIRST_FLIGHT_REASON }
                : byKey.get(key)
              const allowed = verdict?.allowed ?? false
              const status = key === 'similarity' ? undefined : lastStatus.get(key)
              return (
                <StageRow
                  key={key}
                  testId={`flight-start-stage-${key}`}
                  selected={picked === key}
                  disabled={!allowed}
                  onPick={() => setPicked(key)}
                  icon={status ? STAGE_ICON[status] : '·'}
                  iconTone={stageStatusTone(status)}
                  label={rowLabel(key)}
                  sub={allowed ? undefined : verdict?.reason}
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

  return (
    <Modal
      open
      onClose={onClose}
      icon={
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 2 11 13" />
          <path d="M22 2 15 22l-4-9-9-4Z" />
        </svg>
      }
      title={resolvedFeature ?? 'Start a flight'}
      description={
        hasRecord
          ? 'Re-fly this feature — pick where the pipeline restarts.'
          : 'One command from a bare repo to a green, covered, evaluated run.'
      }
      width={620}
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
          <div className="flex flex-col gap-2">
            <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              This feature is flying right now.
            </div>
            <button
              type="button"
              data-testid="flight-start-open-active"
              onClick={() => onOpenFlight(entry.flight!.flightId)}
              className="cl-button self-start px-2.5 py-1 text-xs"
              style={{ color: 'rgb(56, 189, 248)' }}
            >
              Open the running flight →
            </button>
          </div>
        ) : newFlight && phase === 'planning' ? (
          <PlanningView
            task={planTask}
            busy={busy}
            error={errorBlock}
            onSkip={startSingleFlight}
            onCancel={onClose}
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
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                What should this flight test?
              </span>
              {hasRecord ? (
                // Frozen intent (R57): presented, never edited, from here.
                <blockquote
                  data-testid="flight-start-frozen-intent"
                  className="rounded border-l-2 py-1 pl-2.5 text-[12px]"
                  style={{ borderColor: 'rgb(56, 189, 248)', color: 'var(--text-secondary)' }}
                >
                  {entry?.prefill.description || '—'}
                </blockquote>
              ) : (
                <Textarea
                  value={description}
                  onChange={setDescription}
                  minRows={5}
                  placeholder="e.g. the checkout flow end to end — refer to ~/Documents/prd.md"
                />
              )}
            </label>
            {hasRecord ? (
              <div className="-mt-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                Repos and intent froze when this flight first started — delete the flight to test different ones.
              </div>
            ) : (
              <div className="-mt-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                Documents referenced here are linked into the flight automatically.
              </div>
            )}

            {/* R63: no repo section once a record exists — repos are frozen. */}
            {needsArgs && (
              <div className="flex flex-col gap-1">
                <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Repos
                </span>
                <RepoMultiPicker
                  selected={repoPaths}
                  onChange={setRepoPaths}
                />
                {derivedFeature && (
                  <div data-testid="flight-start-derived-feature" className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                    Feature name: <span style={{ fontFamily: 'var(--font-mono)' }}>{derivedFeature}</span> — derived automatically
                  </div>
                )}
              </div>
            )}

            {stageMenu}

            {newFlight ? (
              <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                Step entry unlocks after this feature's first flight.
              </div>
            ) : hasRecord ? (
              <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                Starting resets this flight's stage records; captured artifacts on
                disk (config, envset, docs, specs) are kept and reused.
              </div>
            ) : null}

            {errorBlock}

            <div className="flex items-center justify-end gap-1.5">
              <button type="button" onClick={onClose} className="cl-button px-2.5 py-1 text-xs">Cancel</button>
              <button
                type="button"
                data-testid="flight-start-submit"
                disabled={!canSubmit}
                onClick={start}
                className="cl-button px-2.5 py-1 text-xs"
                style={{ color: canSubmit ? 'rgb(56, 189, 248)' : undefined, opacity: canSubmit ? 1 : 0.55 }}
              >
                {busy ? 'Starting…' : newFlight ? 'Plan flight →' : picked === 'continue' ? 'Continue flight' : 'Start flight'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** R54: the breakdown agent owns the dialog while it thinks — its timeline is
 *  the content, with the single-flight escape hatch always in reach. */
function PlanningView({
  task,
  busy,
  error,
  onSkip,
  onCancel,
}: {
  task: PlanFeaturesTask | null
  busy: boolean
  error: ReactNode
  onSkip: () => void
  onCancel: () => void
}) {
  const failed = task?.status === 'failed'
  return (
    <div className="flex flex-col gap-2.5" data-testid="flight-plan-view">
      <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {failed
          ? 'Planning failed — you can still start one flight for the whole intent.'
          : 'Judging whether this intent is one feature or several…'}
      </div>
      {failed && task?.error && (
        <div data-testid="flight-plan-error" className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}>
          {task.error}
        </div>
      )}
      {task && !failed && (
        <div className="flex min-h-[260px] flex-col rounded border" style={{ borderColor: 'var(--border-default)' }}>
          <AgentSessionView source={{ kind: 'flight-plan', taskId: task.taskId, live: task.status === 'running' }} />
        </div>
      )}
      {error}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="cl-button px-2.5 py-1 text-xs">
          Close — keep planning in the background
        </button>
        <button
          type="button"
          data-testid="flight-plan-skip"
          disabled={busy}
          onClick={onSkip}
          className="cl-button px-2.5 py-1 text-xs"
          style={{ color: failed ? 'rgb(56, 189, 248)' : undefined }}
        >
          {busy ? 'Starting…' : 'Skip planning — start a single flight'}
        </button>
      </div>
    </div>
  )
}

/** R54: the proposal step — the agent's split as editable cards, the token
 *  cost stated plainly, nothing launches until the user confirms. */
function ProposalView({
  proposal,
  conflicts,
  sharedGroup,
  busy,
  error,
  onChange,
  onGroupChange,
  onConfirm,
  onCancel,
}: {
  proposal: PlannedFeature[]
  conflicts: string[]
  sharedGroup: string
  busy: boolean
  error: ReactNode
  onChange: (features: PlannedFeature[]) => void
  onGroupChange: (group: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const patch = (i: number, part: Partial<PlannedFeature>): void => {
    onChange(proposal.map((f, idx) => (idx === i ? { ...f, ...part } : f)))
  }
  const n = proposal.length
  return (
    <div className="flex flex-col gap-2.5" data-testid="flight-proposal-view">
      <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        The intent breaks down into {n} feature{n === 1 ? '' : 's'} — each gets its own flight and test suite.
      </div>

      <ul className="m-0 flex max-h-[320px] list-none flex-col gap-1.5 overflow-auto p-0 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
        {proposal.map((f, i) => {
          const slug = api.deriveFeatureSlug(f.name)
          const conflicted = conflicts.includes(slug)
          return (
            <li
              key={i}
              data-testid={`flight-proposal-card-${i}`}
              className="flex flex-col gap-1.5 rounded border p-2.5"
              style={{ borderColor: conflicted ? 'color-mix(in srgb, var(--danger) 50%, var(--border-default))' : 'var(--border-default)' }}
            >
              <input
                value={f.name}
                onChange={(e) => patch(i, { name: e.target.value })}
                aria-label="Feature name"
                spellCheck={false}
                className="w-full rounded border px-2 py-1 text-[12px] outline-none"
                style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
              />
              {conflicted && (
                <div data-testid={`flight-proposal-conflict-${i}`} className="text-[10.5px]" style={{ color: 'var(--danger)' }}>
                  A feature named "{slug}" already exists — rename this one.
                </div>
              )}
              <Textarea value={f.description} onChange={(v) => patch(i, { description: v })} minRows={1} maxRows={3} />
              {f.scope && (
                <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                  {f.scope}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <label className="flex items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Group
        </span>
        <input
          value={sharedGroup}
          onChange={(e) => onGroupChange(e.target.value)}
          data-testid="flight-proposal-group"
          placeholder="optional — houses these features under one accordion"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border px-2 py-1 text-[11.5px] outline-none"
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
        />
      </label>

      {n > 1 && (
        <div data-testid="flight-proposal-token-warning" className="rounded border px-2.5 py-2 text-[11px]" style={{ borderColor: 'color-mix(in srgb, rgb(251, 191, 36) 45%, var(--border-default))', color: 'rgb(251, 191, 36)' }}>
          Runs {n} flights one at a time — expect roughly {n}× the usual token cost.
        </div>
      )}

      {error}

      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="cl-button px-2.5 py-1 text-xs">Cancel</button>
        <button
          type="button"
          data-testid="flight-proposal-confirm"
          disabled={busy || proposal.some((f) => !f.name.trim() || !f.description.trim())}
          onClick={onConfirm}
          className="cl-button px-2.5 py-1 text-xs"
          style={{ color: 'rgb(56, 189, 248)' }}
        >
          {busy ? 'Launching…' : n === 1 ? 'Start the flight' : `Start ${n} flights`}
        </button>
      </div>
    </div>
  )
}

/** One pickable step. Disabled rows stay visible and say WHY they're blocked
 *  (the server's missing-prerequisite message) — never silently unclickable. */
function StageRow({
  testId,
  selected,
  disabled,
  onPick,
  icon,
  iconTone,
  label,
  sub,
}: {
  testId: string
  selected: boolean
  disabled?: boolean
  onPick: () => void
  icon: string
  iconTone: string
  label: string
  sub?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={testId}
      disabled={disabled}
      onClick={onPick}
      className="flex items-start gap-2 rounded px-2 py-1.5 text-left transition-colors enabled:hover:bg-white/[0.04]"
      style={{
        background: selected ? 'var(--bg-selected)' : undefined,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : undefined,
      }}
    >
      <span className="w-3 shrink-0 text-center text-[12px] font-semibold" style={{ color: iconTone }} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]" style={{ color: disabled ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {label}
        </span>
        {sub && (
          <span className="block text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {sub}
          </span>
        )}
      </span>
    </button>
  )
}
