// The FlightStartDialog state machine — every piece of state, the effects that
// load entry options and drive a plan-features task, and the submit handlers.
// Lifted out of the component verbatim so the dialog file is its markup; the
// hook hands each binding back under its original name.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type {
  AgentStagePlans,
  FlightEntryOptions,
  FlightStageEntryOption,
  FlightStageKey,
  FlightStageStatus,
  PlanFeaturesTask,
  PlannedFeature,
} from '@/shared/api/client'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import { usePlanFeaturesTask } from './use-plan-features-task'

type NewFlightPhase = 'form' | 'planning' | 'proposal'

export function useFlightStartDialog({ feature, intent, fromStage, resumePlanTaskId, newFlightPrefill, onOpenFlight, onClose }: {
  feature: string | null
  intent: FlightLauncherIntent
  fromStage: FlightStageKey | null
  resumePlanTaskId?: string | null
  /** Seed for new-flight mode (the first-run guide's one-click sample repo).
   *  Applied to the INITIAL state only, so it never fights the user's edits or
   *  a resumed pre-flight task's own values. */
  newFlightPrefill?: { repoPaths: string[]; description: string } | null
  onOpenFlight: (flightId: string) => void
  onClose: () => void
}) {
  // A new-flight submit that hits the existing-record 409 switches the dialog
  // itself into feature-scoped mode (R67) — resolvedFeature drives everything
  // the `feature` prop used to.
  const [resolvedFeature, setResolvedFeature] = useState<string | null>(feature)
  const [entry, setEntry] = useState<FlightEntryOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // A prefill only applies to new-flight mode; the feature-scoped path loads its
  // own values from the flight's entry options a few effects down.
  const seed = feature === null && !resumePlanTaskId ? newFlightPrefill : null
  const [description, setDescription] = useState(seed?.description ?? '')
  const [repoPaths, setRepoPaths] = useState<string[]>(seed?.repoPaths ?? [])
  // Fresh mode never asks where to re-enter — a changed intent/repo set is only
  // valid from the beginning — so it opens pre-picked there and stays put.
  const [picked, setPicked] = useState<FlightStageKey | 'continue' | null>(
    feature && intent !== 'fresh' ? fromStage : 'similarity',
  )
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  // R80: bumped after the in-dialog stop, to refetch the entry options so the
  // now-inactive flight drops the "flying right now" branch and the fresh form
  // takes over — the user lands on the inputs they opened the dialog to change.
  const [entryNonce, setEntryNonce] = useState(0)

  // R69: the full-flight step list is a collapsible preview — the whole journey
  // shown by default (greyed + locked for a first flight, the real re-entry
  // control once flown), collapsible to get it out of the way.
  const [showSteps, setShowSteps] = useState(true)

  // R71/W4: autopilot rides every launch path (plan, single-flight escape,
  // proposal confirm, feature-scoped start). Default ON; the body carries the
  // field only on an explicit opt-out (absent = on, server-side too).
  const [autopilot, setAutopilot] = useState(true)
  const autopilotBody = autopilot ? {} : { autopilot: false as const }
  // R79: which CLI conducts the flight's stage agents. Preselected from the
  // workspace's default-agent setting; claude is the wire default, so only a
  // codex pick rides the body. Sticky server-side once the flight exists.
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude')
  const agentBody = agent === 'codex' ? { agent: 'codex' as const } : {}
  // The whole config is kept (not just the default-agent bit): the models gate
  // below needs askModelsOnLaunch + agentModels. Unreachable → null, and the
  // gate never arms (launching beats blocking on a settings probe).
  const [projectConfig, setProjectConfig] = useState<api.ProjectConfig | null>(null)
  useEffect(() => {
    api.getProjectConfig()
      .then((c) => {
        setProjectConfig(c)
        if (c.healAgent === 'codex') setAgent('codex')
      })
      .catch(() => {})
  }, [])

  // The models gate (2.2.0): when the workspace armed askModelsOnLaunch, the
  // three explicit launch actions park on "use defaults or customize?" first.
  // Holds WHICH action to replay on confirm. The plan-first path (planFlight)
  // is deliberately ungated — its launch is server-driven and takes the saved
  // defaults; the proposal confirm (launchProposal) is the gated moment.
  const [modelsGate, setModelsGate] = useState<'start' | 'single' | 'proposal' | null>(null)

  // R54 plan flow state. Resuming a backgrounded pre-flight opens straight in
  // the planning view (the resume effect attaches the task; the settle effect
  // then promotes it to the proposal or into the launched flight).
  const [phase, setPhase] = useState<NewFlightPhase>(resumePlanTaskId ? 'planning' : 'form')
  // A creation response only seeds the shared reader; accepted remote state
  // has one owner. Resumed tasks are keyed directly by navigation.
  const [createdTask, setCreatedTask] = useState<PlanFeaturesTask>()
  const planTaskId = resumePlanTaskId ?? createdTask?.taskId ?? null
  const { task: planTask, error: planReadError } = usePlanFeaturesTask(planTaskId, createdTask)
  const [proposal, setProposal] = useState<PlannedFeature[]>([])
  const [sharedGroup, setSharedGroup] = useState('')
  const [conflicts, setConflicts] = useState<string[]>([])
  const autoLaunched = useRef<string | null>(null)
  const navigated = useRef<string | null>(null)
  const resumeAttached = useRef<string | null>(null)
  const mounted = useRef(false)
  const currentTaskId = useRef(planTaskId)
  currentTaskId.current = planTaskId
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const taskIsCurrent = useCallback((id: string): boolean => mounted.current && currentTaskId.current === id, [])
  const openTaskFlight = useCallback((id: string, flightId: string): void => {
    if (!taskIsCurrent(id) || navigated.current === id) return
    navigated.current = id
    onOpenFlight(flightId)
  }, [onOpenFlight, taskIsCurrent])
  const closeTask = useCallback((id: string): void => {
    if (!taskIsCurrent(id) || navigated.current === id) return
    navigated.current = id
    onClose()
  }, [onClose, taskIsCurrent])
  // Seed the editable proposal from the settled plan exactly once. Without this,
  // a bare parent re-render (poll/WS) re-fires the settle effect below and
  // clobbers the user's in-progress name/group/intent edits.
  const proposalSeeded = useRef<string | null>(null)

  const newFlight = resolvedFeature === null

  useEffect(() => {
    autoLaunched.current = null
    navigated.current = null
    resumeAttached.current = null
    proposalSeeded.current = null
    setProposal([])
    setSharedGroup('')
    setConflicts([])
    setStartError(null)
    setModelsGate(null)
    setBusy(false)
    setPhase(planTaskId ? 'planning' : 'form')
  }, [planTaskId])

  useEffect(() => {
    if (!planTask || resumeAttached.current === planTask.taskId) return
    resumeAttached.current = planTask.taskId
    if (resumePlanTaskId) {
      setDescription(planTask.description)
      setRepoPaths(planTask.repoPaths)
    }
  }, [planTask, resumePlanTaskId])

  useEffect(() => {
    if (newFlight) return
    let alive = true
    api.getFlightEntryOptions(resolvedFeature)
      .then((options) => {
        if (!alive) return
        setEntry(options)
        setDescription(options.prefill.description)
        setRepoPaths(options.prefill.repoPaths)
        // Default pick: a paused flight resumes; anything else defaults to the
        // full restart. Fresh mode (R76) keeps its own pre-pick — landing a
        // "change the intent" handoff on `continue` is exactly the bug that
        // rework fixed: it re-froze the fields the user came to edit.
        if (intent === 'fresh') return
        // A caller-supplied stage already answered "where do we re-enter?" —
        // the entry load must not clobber it back to the top of the pipeline.
        if (fromStage) return
        setPicked(options.canContinue ? 'continue' : options.flight ? 'similarity' : null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => { alive = false }
  }, [resolvedFeature, newFlight, intent, fromStage, entryNonce])

  // A settled plan advances the phase. Single-feature launching is the
  // SERVER's job (so a backgrounded plan starts even with the dialog closed) —
  // once it flips the task to `launched`, jump straight into the new flight.
  useEffect(() => {
    if (!planTask) return
    if (planTask.status === 'cancelled') {
      closeTask(planTask.taskId)
      return
    }
    if (planTask.status === 'launched' && planTask.launchedFlightIds && planTask.launchedFlightIds.length > 0) {
      if (autoLaunched.current === planTask.taskId) return
      autoLaunched.current = planTask.taskId
      openTaskFlight(planTask.taskId, planTask.launchedFlightIds[0])
      return
    }
    if (planTask.status !== 'done' || !planTask.result) return
    const features = planTask.result.features
    const conflicted = (planTask.conflicts?.length ?? 0) > 0
    // Several features, or a single one whose name clashed → the human decides
    // (confirm the split / rename). Show the proposal.
    if (features.length > 1 || conflicted) {
      if (proposalSeeded.current === planTask.taskId) return
      proposalSeeded.current = planTask.taskId
      setProposal(features)
      setSharedGroup(features.find((f) => f.group)?.group ?? '')
      if (conflicted) setConflicts(planTask.conflicts ?? [])
      setPhase('proposal')
      return
    }
    // Single feature, no conflict. The server has already launched it in the
    // live flow (we catch `launched` above via the poll); this direct launch
    // is the fallback for a server without auto-launch, guarded to fire once.
    if (autoLaunched.current === planTask.taskId) return
    autoLaunched.current = planTask.taskId
    api.launchPlannedFeatures(planTask.taskId, { features })
      .then(({ flightIds }) => openTaskFlight(planTask.taskId, flightIds[0]))
      .catch((err: unknown) => {
        if (!taskIsCurrent(planTask.taskId)) return
        autoLaunched.current = null
        applyLaunchFailure(err)
        if (proposalSeeded.current === planTask.taskId) return
        proposalSeeded.current = planTask.taskId
        setProposal(features)
        setSharedGroup(features[0]?.group ?? '')
        setPhase('proposal')
      })
  }, [planTask, openTaskFlight, closeTask, taskIsCurrent])

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
  // R75: repos + intent are frozen against PARTIAL re-entry only — a full
  // restart ("Start fresh — from the beginning", mode redo) discards every
  // stage's evidence, so the inputs unlock exactly there and nowhere else.
  const hasRecord = !newFlight && entry?.flight != null
  const needsArgs = newFlight || (entry !== null && entry.flight === null)
  const editableInputs = hasRecord && picked === 'similarity'
  const inputsRequired = needsArgs || editableInputs
  // R76: the fresh-intent view — intent + repos only. The stage menu is not
  // rendered at all (not merely defaulted), because every row it offers except
  // the full restart is invalid the moment these inputs change.
  const freshMode = !newFlight && intent === 'fresh'

  const canSubmit = newFlight
    ? !busy && description.trim() !== '' && repoPaths.length > 0
    : entry !== null && !entry.active && !busy && picked !== null
      && (!inputsRequired || (description.trim() !== '' && repoPaths.length > 0))

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
    api.planFeatures({ repoPaths, description: description.trim(), ...autopilotBody, ...agentBody })
      .then((task) => {
        if (!mounted.current) return
        setCreatedTask(task)
        setPhase('planning')
        setBusy(false)
      })
      .catch(openFlightFail)
  }

  /** The planning escape hatch — one flight for the whole intent, no agent. */
  const beginSingleFlight = (models: AgentStagePlans | null): void => {
    setBusy(true)
    setStartError(null)
    api.startFlight({
      feature: derivedFeature ?? 'feature',
      repoPaths,
      description: description.trim(),
      ...autopilotBody,
      ...agentBody,
      ...(models ? { models } : {}),
    })
      .then((manifest) => onOpenFlight(manifest.flightId))
      .catch(openFlightFail)
  }
  const startSingleFlight = (): void => {
    if (busy) return
    if (projectConfig?.askModelsOnLaunch === true) { setModelsGate('single'); return }
    beginSingleFlight(null)
  }

  /** Stop is distinct from closing: it settles the durable task server-side,
   *  waits for the whole agent tree, then lets every UI surface drop the now-
   *  terminal pre-flight through the store's live event. */
  const cancelPlanning = (taskId: string): void => {
    if (busy || !planTask || planTask.taskId !== taskId) return
    setBusy(true)
    setStartError(null)
    api.cancelPlanFeatures(taskId)
      .then(() => closeTask(taskId))
      .catch((err: unknown) => {
        if (!taskIsCurrent(taskId)) return
        setStartError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  /** Proposal confirm: one flight per card, sequentially queued (R54). */
  const beginLaunchProposal = (models: AgentStagePlans | null): void => {
    if (!planTask) return
    setBusy(true)
    setStartError(null)
    setConflicts([])
    const features = proposal.map((f) => ({
      ...f,
      ...(sharedGroup.trim() ? { group: sharedGroup.trim() } : {}),
    }))
    api.launchPlannedFeatures(planTask.taskId, { features, ...autopilotBody, ...agentBody, ...(models ? { models } : {}) })
      .then(({ flightIds }) => openTaskFlight(planTask.taskId, flightIds[0]))
      .catch((error: unknown) => { if (taskIsCurrent(planTask.taskId)) applyLaunchFailure(error) })
  }
  const launchProposal = (): void => {
    if (busy || !planTask) return
    if (projectConfig?.askModelsOnLaunch === true) { setModelsGate('proposal'); return }
    beginLaunchProposal(null)
  }

  /** R80: the fresh-intent dead-end's way forward. A flying suite can't take new
   *  inputs — changing them IS a restart — so the dialog offers the restart
   *  outright: stop the running flight, then reload into the fresh form the user
   *  came for. Nothing is wiped here; the wipe belongs to the restart itself. */
  const stopAndStartFresh = (): void => {
    if (busy || !entry?.flight) return
    setBusy(true)
    setStartError(null)
    api.abortFlight(entry.flight.flightId)
      .then(() => {
        setBusy(false)
        setEntryNonce((n) => n + 1)
      })
      .catch((err: unknown) => {
        setStartError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  const beginStart = (models: AgentStagePlans | null): void => {
    if (!entry || picked === null) return
    setBusy(true)
    setStartError(null)
    const body: api.StartFlightBody = {
      feature: resolvedFeature!,
      // Frozen args (R57/R75): with a record, repos + intent ride the body
      // ONLY on a full restart (mode redo accepts new values); mid-pipeline
      // re-entry omits them — the server reuses the stored values (and 409s
      // on differing ones).
      ...(inputsRequired ? { repoPaths, description: description.trim() } : {}),
      env: entry.prefill.env,
      coverageTarget: entry.prefill.coverageTarget,
      ...(picked === 'continue'
        ? { mode: 'continue' as const }
        : picked === 'similarity'
          ? (hasRecord ? { mode: 'redo' as const } : {})
          : { ...(hasRecord ? { mode: 'jump' as const } : {}), fromStage: picked }),
      ...autopilotBody,
      ...agentBody,
      ...(models ? { models } : {}),
    }
    api.startFlight(body)
      .then((manifest) => onOpenFlight(manifest.flightId))
      .catch(openFlightFail)
  }
  const start = (): void => {
    if (busy) return
    if (newFlight) { planFlight(); return }
    if (!entry || picked === null) return
    if (projectConfig?.askModelsOnLaunch === true) { setModelsGate('start'); return }
    beginStart(null)
  }

  /** The models gate's confirm — replays the parked action with the answer
   *  (null = defaults: send nothing, the server resolves the saved config). */
  const confirmLaunchModels = (models: AgentStagePlans | null): void => {
    const kind = modelsGate
    setModelsGate(null)
    if (kind === 'start') beginStart(models)
    else if (kind === 'single') beginSingleFlight(models)
    else if (kind === 'proposal') beginLaunchProposal(models)
  }

  return { resolvedFeature, entry, loadError, projectConfig, modelsGate, setModelsGate, confirmLaunchModels, description, setDescription, repoPaths, setRepoPaths, picked, setPicked, busy, startError: startError ?? planReadError, taskUnavailable: planTaskId !== null && planTask === null, showSteps, setShowSteps, autopilot, setAutopilot, agent, phase, planTask, proposal, setProposal, sharedGroup, setSharedGroup, conflicts, newFlight, byKey, lastStatus, hasRecord, editableInputs, inputsRequired, freshMode, canSubmit, startSingleFlight, cancelPlanning, launchProposal, stopAndStartFresh, start }
}
