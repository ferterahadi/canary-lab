import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FeaturesColumn } from './shared/shell/FeaturesColumn'
import { TestCasesColumn } from './shared/shell/TestCasesColumn'
import { RunsColumn } from './features/runs/components/RunsColumn'
import { RunDetailColumn } from './features/runs/components/RunDetailColumn'
import { FeatureConfigEditor } from './features/config/components/FeatureConfigEditor'
import { ResizablePanels } from './shared/ui/ResizablePanels'
import { VerticalSplit } from './shared/ui/VerticalSplit'
import { GlobalStatusBar } from './shared/shell/GlobalStatusBar'
import { CollisionConfirmDialog } from './features/runs/components/CollisionConfirmDialog'
import { RunStartErrorDialog } from './features/runs/components/RunStartErrorDialog'
import { PortifyWizard } from './features/portify/components/PortifyWizard'
import { LogCleanupPage } from './features/logs/components/LogCleanupPage'
import { CoverageLedgerPage } from './features/coverage/components/CoverageLedgerPage'
import { FlightPage } from './features/flights/components/FlightPage'
import { FlightStartDialog } from './features/flights/components/FlightStartDialog'
import type { RepoCollisionChoice } from './shared/api/client'
import * as api from './shared/api/client'
import { connectWorkspaceEvents } from './features/runs/api/workspace-socket'
import { useRuns, useRun, useGlobalActiveRun } from './features/runs/state/RunsContext'
import { useFeatureActivity, type FeatureActivity } from './features/flights/state/feature-activity'
import { STAGE_LABEL } from './features/flights/components/stage-meta'
import type { RepoOption } from './features/flights/components/RepoMultiPicker'
import { ToastHost, type ToastItem } from './features/config/components/atoms'
import { AGGREGATE_TOAST_ID, attentionKey, flightNeedsAttention } from './features/flights/state/flight-toasts'
import type { Feature, VersionStatus } from './shared/api/types'
import type { FlightIndexEntry, PlanFeaturesTask } from './shared/api/client'
import { readPersistedView, persistView, onViewChangedInOtherTab } from './shared/lib/workspace-view-state'

// R12: hydrate the open view + selected feature from the URL/localStorage so a
// refresh or a second tab restores where you were, not a blank workspace.
const PERSISTED_VIEW = readPersistedView()

export function App() {
  const [features, setFeatures] = useState<Feature[]>([])
  const [selectedFeature, setSelectedFeature] = useState<string | null>(PERSISTED_VIEW.feature)
  // R24: hydrate the selected run from the URL so a deep-linked / refreshed run
  // reopens. The run loads async over the WS, so we also seed the pending ref
  // below to stop the stale-run guard from clearing it before runs arrive.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(PERSISTED_VIEW.run)
  const [configFor, setConfigFor] = useState<string | null>(
    PERSISTED_VIEW.dialog === 'config' ? PERSISTED_VIEW.feature : null,
  )
  const [testsRefreshKey, setTestsRefreshKey] = useState(0)
  const [coverageRefreshKey, setCoverageRefreshKey] = useState(0)
  // Bumped when a portify overlay is saved — forces the open Ports tab to refetch
  // its config doc so the rewritten slots show without a tab switch / refresh.
  const [portsRefreshKey, setPortsRefreshKey] = useState(0)
  const [reposRefreshKey, setReposRefreshKey] = useState(0)
  const [verificationRefreshKey, setVerificationRefreshKey] = useState(0)
  const [journalRefreshKeys, setJournalRefreshKeys] = useState<Record<string, number>>({})
  const [specTotalTests, setSpecTotalTests] = useState(0)
  const [collisionPrompt, setCollisionPrompt] = useState<{ feature: string; env?: string; mode?: 'test' | 'boot'; info: RepoCollisionChoice; portsConfigured?: boolean } | null>(null)
  // A run-start failure that isn't a collision (404 feature gone, 400 bad env,
  // 5xx server error, network) — surfaced as a dialog so the Run button never
  // fails silently. Holds the params so the dialog's Retry can replay it.
  const [startError, setStartError] = useState<{ feature: string; env?: string; mode: 'test' | 'boot'; error: unknown } | null>(null)
  // Port-ification workflow view — an EMBEDDED surface only since R50 (the
  // flight's Parallel Readiness drill-through, collision recovery, benchmark):
  // 'new' starts a fresh workflow for a feature; 'revisit' reopens one by id.
  // Deliberately unrouted — flight is the one GUI entry point.
  const [portifyTarget, setPortifyTarget] = useState<
    { kind: 'new'; feature: string } | { kind: 'revisit'; workflowId: string } | null
  >(null)
  // R24: the Verify-config dialog (in the runs column) is route-driven too.
  const [verifyOpen, setVerifyOpen] = useState(PERSISTED_VIEW.dialog === 'verification')
  // Top-level view: the normal workspace, or a full-screen page (cleanup /
  // coverage / flights). Hydrated from the URL/localStorage (R12) so it
  // survives refresh.
  const [view, setView] = useState<'workspace' | 'cleanup' | 'coverage' | 'flights'>(PERSISTED_VIEW.view)
  // Flight surface: the flight list feeds the status-bar pill; the
  // selected flight id qualifies ?view=flights so a deep link / refresh
  // re-opens the exact flight (cl_route-every-surface).
  const [flights, setFlights] = useState<FlightIndexEntry[]>([])
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(PERSISTED_VIEW.flight)
  const [flightsRefreshKey, setFlightsRefreshKey] = useState(0)
  // Pre-flight (plan-features) tasks in progress / awaiting review — the pill's
  // pre-flight rows. WS-driven via `pre-flight-changed` (+ a poll-while-running
  // backstop), so a backgrounded plan stays visible and re-openable.
  const [preFlights, setPreFlights] = useState<PlanFeaturesTask[]>([])
  // The pre-flight a pill row reopened the new-flight dialog onto (attaches the
  // dialog to the running/awaiting task instead of a fresh form).
  const [resumePlanTaskId, setResumePlanTaskId] = useState<string | null>(null)
  // R25: the flight stage-entry launcher — routed (dialog=flight-start,
  // qualified by the durable feature param) so a deep link / refresh reopens it.
  const [flightStartFor, setFlightStartFor] = useState<string | null>(
    PERSISTED_VIEW.dialog === 'flight-start' ? PERSISTED_VIEW.feature : null,
  )
  // R40: the new-flight launcher (intent + repo picker, no feature yet) — the
  // "+ New" action; routed as dialog=flight-new (cold-load coherent: it needs
  // only the features list).
  const [flightStartNew, setFlightStartNew] = useState<boolean>(PERSISTED_VIEW.dialog === 'flight-new')
  // Current-vs-latest version + self-update job state. Sourced from the server,
  // refetched on every `version-changed` event (registry check resolved, or the
  // update job advanced) so the footer indicator updates live.
  const [versionStatus, setVersionStatus] = useState<VersionStatus | null>(null)
  const pendingRunSelectionRef = useRef<string | null>(PERSISTED_VIEW.run)
  const selectedFeatureRef = useRef<string | null>(null)
  const selectedRunIdRef = useRef<string | null>(PERSISTED_VIEW.run)

  // Runs come from the WebSocket-backed RunsProvider — no polling here.
  // `runs` is the full index across all features; the per-feature filter
  // happens at render time. Declared here (above the persist effect) because the
  // route serialization below reads `wizardOpen`.
  const { runs: allRuns, startRun: startRunAction, startVerification: startVerificationAction } = useRuns()
  // Read inside refreshFeatures via ref, not closure — allRuns changes on every
  // run-progress tick, and closing over it directly would give refreshFeatures a
  // new identity each time, which would tear down and reopen the /ws/workspace
  // socket below (its connect effect depends on refreshFeatures) on every tick.
  // The bus has no replay, so any event published during that reconnect window
  // is lost — exactly the "only updates after a refresh" failure mode.
  const allRunsRef = useRef(allRuns)
  useEffect(() => { allRunsRef.current = allRuns }, [allRuns])
  // Same identity-stability trick for the flights index — openActivity reads
  // it via ref so the callback (a prop of the status bar + flight page)
  // doesn't churn on every flights poll.
  const flightsRef = useRef(flights)
  useEffect(() => { flightsRef.current = flights }, [flights])
  const { entry: globalActiveRunEntry, detail: activeRunDetail } = useGlobalActiveRun()
  // R26: per-feature live activity (runs / portify / authoring) — the one
  // instance behind the Flights pill and the flights landing list. Clicking an
  // activity-only row opens the activity's REAL surface.
  const featureActivity = useFeatureActivity()
  const openActivity = useCallback((feature: string, activity: FeatureActivity) => {
    if (activity.kind === 'running' && activity.runId) {
      pendingRunSelectionRef.current = null
      setSelectedFeature(feature)
      setSelectedRunId(activity.runId)
      setView('workspace')
    } else if (activity.kind === 'exporting') {
      // R29/R38: the export lives in the flight's Evaluation Report stage when
      // the feature has a flight record; run detail no longer hosts an inline
      // panel, so a flightless export is watched from the flights view (the
      // pill blinks; the list shows the exporting row).
      const flight = flightsRef.current.find((f) => f.feature === feature)
      setSelectedFlightId(flight ? flight.flightId : null)
      setView('flights')
    } else if (activity.kind === 'portifying' && activity.workflowId) {
      setPortifyTarget({ kind: 'revisit', workflowId: activity.workflowId })
    } else if (activity.kind === 'authoring') {
      // R36: authoring used to open the AddTestWizard's Accept/Reject step —
      // jarring when the user only wants to watch. Route to the flights view.
      setSelectedFlightId(null)
      setView('flights')
    }
  }, [])

  // R12/R24: persist the full route (view + feature + selected run + open routed
  // dialog) to the URL on every change so a refresh / deep link restores it. The
  // durable tier (view + feature) also mirrors to localStorage for cross-tab sync.
  // Dialog precedence follows z-order: the full-screen overlays (portify > config
  // > wizard) sit above the in-column verify dialog, so the topmost open one owns
  // the URL.
  const routedDialog = configFor ? 'config' : flightStartFor ? 'flight-start' : flightStartNew ? 'flight-new' : verifyOpen ? 'verification' : null
  useEffect(() => {
    persistView({ view, feature: selectedFeature, run: selectedRunId, dialog: routedDialog, flight: selectedFlightId })
  }, [view, selectedFeature, selectedRunId, routedDialog, selectedFlightId])

  useEffect(() => onViewChangedInOtherTab((s) => {
    setView(s.view)
    if (s.feature) setSelectedFeature(s.feature)
  }), [])

  // Initial features load + auto-select first feature.
  useEffect(() => {
    let cancelled = false
    api.listFeatures().then((data) => {
      if (cancelled) return
      setFeatures(data)
      if (data.length > 0 && !selectedFeature) setSelectedFeature(data[0].name)
    }).catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Column 3 lists runs scoped to the currently-selected feature. Boot-only
  // sessions are excluded — they're not test runs and live in the global
  // Services surface, not the Runs list.
  const featureRuns = useMemo(
    () => allRuns.filter((r) => r.feature === selectedFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark'),
    [allRuns, selectedFeature],
  )

  // Latest run for the selected feature — running, healing, OR terminal.
  // Used as the default test-status source only until the user explicitly
  // selects a run from the runs column.
  const latestRunForFeature = featureRuns[0] ?? null
  const selectedRunForFeature = selectedRunId
    ? featureRuns.find((r) => r.runId === selectedRunId) ?? null
    : null
  const statusRunId = selectedRunForFeature?.runId ?? latestRunForFeature?.runId ?? null

  useEffect(() => {
    if (!selectedFeature) {
      pendingRunSelectionRef.current = null
      if (selectedRunId !== null) setSelectedRunId(null)
      return
    }

    if (selectedRunForFeature) {
      if (pendingRunSelectionRef.current === selectedRunForFeature.runId) {
        pendingRunSelectionRef.current = null
      }
      return
    }

    if (selectedRunId && pendingRunSelectionRef.current === selectedRunId) return

    const nextRunId = latestRunForFeature?.runId ?? null
    if (selectedRunId !== nextRunId) setSelectedRunId(nextRunId)
  }, [latestRunForFeature?.runId, selectedFeature, selectedRunForFeature, selectedRunId])

  // The detail (and therefore the summary) for Column 2 lives in the shared
  // run store. It is scoped to the selected run when there is one, so clicking
  // Run 1 / Run 2 updates the test status pills to that run's result.
  const statusRunDetail = useRun(statusRunId)
  const summaryForSelectedFeature = statusRunDetail.detail?.summary
  const statusForSelectedFeature =
    statusRunDetail.detail?.manifest.status
    ?? selectedRunForFeature?.status
    ?? latestRunForFeature?.status

  const handleStartRun = useCallback(async (env?: string, mode: 'test' | 'boot' = 'test'): Promise<void> => {
    if (!selectedFeature) return
    // Concurrent runs are allowed: different apps run in parallel on distinct
    // allocated ports; the backend admits or queues as resources allow. A
    // same-repo collision comes back as a 409 — prompt the user to isolate or
    // queue, then re-issue with their choice (preserving the boot/test mode).
    try {
      const runId = await startRunAction(selectedFeature, env, undefined, mode)
      // Boot sessions are managed in the global Services overlay, never column
      // 3 — don't select them into the run-detail pane.
      if (mode !== 'boot') {
        pendingRunSelectionRef.current = runId
        setSelectedRunId(runId)
      }
    } catch (err) {
      const collision = api.asRepoCollision(err)
      if (collision) {
        // A collision means a second concurrent run of the same app — the one
        // case where hardcoded ports actually clash. Check whether ports are
        // injectable so the dialog can offer the durable fix alongside
        // worktree/queue. Best-effort: the dialog still works without the flag.
        let portsConfigured: boolean | undefined
        try { portsConfigured = (await api.benchmarkPreflight(selectedFeature, env)).portsConfigured } catch { /* ignore */ }
        setCollisionPrompt({ feature: selectedFeature, env, mode, info: collision, portsConfigured })
        return
      }
      // Any other failure (feature gone, bad env, server/boot error, network):
      // show it so the Run button never dead-ends silently.
      setStartError({ feature: selectedFeature, env, mode, error: err })
    }
  }, [selectedFeature, startRunAction])

  const resolveCollision = useCallback(async (isolation: 'worktree' | 'queue'): Promise<void> => {
    const prompt = collisionPrompt
    setCollisionPrompt(null)
    if (!prompt) return
    try {
      const runId = await startRunAction(prompt.feature, prompt.env, isolation, prompt.mode)
      if (prompt.mode !== 'boot') {
        pendingRunSelectionRef.current = runId
        setSelectedRunId(runId)
      }
    } catch (err) {
      setStartError({ feature: prompt.feature, env: prompt.env, mode: prompt.mode ?? 'test', error: err })
    }
  }, [collisionPrompt, startRunAction])

  // Branch-mismatch recovery (from the RunStartErrorDialog). Both throw on
  // failure so the dialog surfaces it inline and stays open; on success they
  // clear the error and replay the original start. handleStartRun's own catch
  // re-populates startError if the replay hits a fresh failure.
  const switchBranchesAndRun = useCallback(async (): Promise<void> => {
    const se = startError
    const mismatch = se && api.asBranchMismatch(se.error)
    if (!se || !mismatch) return
    for (const repo of mismatch.repos) {
      await api.checkoutRepoBranch(se.feature, repo.name, repo.expected)
    }
    setStartError(null)
    await handleStartRun(se.env, se.mode)
  }, [startError, handleStartRun])

  const pinCurrentAndRun = useCallback(async (): Promise<void> => {
    const se = startError
    if (!se) return
    await api.pinFeatureBranchesToCurrent(se.feature)
    setStartError(null)
    await handleStartRun(se.env, se.mode)
  }, [startError, handleStartRun])

  const handleStartVerification = useCallback(async (input: {
    configId?: string
    targetUrls?: Record<string, string>
    playwrightEnvsetId?: string
  }): Promise<void> => {
    if (!selectedFeature) return
    const runId = await startVerificationAction(selectedFeature, input)
    pendingRunSelectionRef.current = runId
    setSelectedRunId(runId)
  }, [selectedFeature, startVerificationAction])

  // Stable identity ([] deps) — reads the current feature/runs via refs rather
  // than closing over the `selectedFeature`/`allRuns` state directly, so callers
  // that depend on this function (the /ws/workspace connect effect below) don't
  // reconnect on every unrelated run-progress tick. See the allRunsRef comment.
  const refreshFeatures = useCallback((preferredFeature?: string | null): void => {
    api.listFeatures().then((data) => {
      setFeatures(data)
      const runs = allRunsRef.current
      if (preferredFeature && data.some((f) => f.name === preferredFeature)) {
        pendingRunSelectionRef.current = null
        setSelectedFeature(preferredFeature)
        setSelectedRunId(runs.find((r) => r.feature === preferredFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null)
      } else if (!selectedFeatureRef.current || !data.some((f) => f.name === selectedFeatureRef.current)) {
        const nextFeature = data[0]?.name ?? null
        pendingRunSelectionRef.current = null
        setSelectedFeature(nextFeature)
        setSelectedRunId(nextFeature ? runs.find((r) => r.feature === nextFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null : null)
      }
    }).catch(() => {})
  }, [])

  const refreshVersion = useCallback((): void => {
    api.getVersionStatus().then(setVersionStatus).catch(() => {})
  }, [])

  const refreshFlights = useCallback((): void => {
    api.listFlights().then(setFlights).catch(() => {})
  }, [])

  const refreshPreFlights = useCallback((): void => {
    api.listPlanFeatures().then((r) => setPreFlights(r.tasks)).catch(() => {})
  }, [])

  // Initial flights load (feeds the pill + landing list before any event fires).
  useEffect(() => { refreshFlights() }, [refreshFlights])
  useEffect(() => { refreshPreFlights() }, [refreshPreFlights])

  // A running pre-flight settles via `pre-flight-changed`, but that push is
  // best-effort — back a running plan with a gentle poll (cl_live-state-sync)
  // so the pill catches the running→done/launched flip even if the event drops.
  const anyPreFlightRunning = preFlights.some((t) => t.status === 'running')
  useEffect(() => {
    if (!anyPreFlightRunning) return
    const id = setInterval(refreshPreFlights, 2500)
    return () => clearInterval(id)
  }, [anyPreFlightRunning, refreshPreFlights])

  // R14 (canary-first-flight): artifact surfaces (coverage ledger) render live
  // "a flight is generating this" state off the flights index. The
  // `flights-changed` broadcast is best-effort, so while any flight is active
  // back it with a gentle poll (cl_live-state-sync) — self-limiting: the
  // interval exists only while a flight is running/parked.
  const anyFlightActive = flights.some((f) => f.status === 'running' || f.status === 'waiting-for-approval')
  useEffect(() => {
    if (!anyFlightActive) return
    const id = setInterval(refreshFlights, 5000)
    return () => clearInterval(id)
  }, [anyFlightActive, refreshFlights])

  // R14: the coverage ledger's content is generated by a flight's docs /
  // prd-summary / specs-coverage stages — hand the ledger that fact so it can
  // say "generating" instead of sitting silently empty while a flight works.
  const coverageGeneratingFlight = useMemo(() => {
    if (!selectedFeature) return null
    const flight = flights.find((f) =>
      (f.status === 'running' || f.status === 'waiting-for-approval') && f.feature === selectedFeature)
    const stageKey = flight?.currentStage
    if (!flight || !stageKey) return null
    if (stageKey !== 'docs' && stageKey !== 'prd-summary' && stageKey !== 'specs-coverage') return null
    const stageStatus = flight.stages?.find((s) => s.key === stageKey)?.status ?? 'running'
    return { flightId: flight.flightId, stage: stageKey, stageStatus }
  }, [flights, selectedFeature])

  // R40: the new-flight dialog's repo picker offers every repo the workspace
  // already knows (flattened from the features' configs, deduped by path).
  const knownRepos = useMemo<RepoOption[]>(() => {
    const seen = new Map<string, RepoOption>()
    for (const f of features) {
      for (const r of f.repos ?? []) {
        const p = r.localPath
        if (typeof p === 'string' && p.length > 0 && !seen.has(p)) {
          seen.set(p, { label: r.name || p.split(/[\\/]/).pop() || p, path: p })
        }
      }
    }
    return [...seen.values()]
  }, [features])

  // R51/R68: attention toasts — diff flight statuses on every index refresh and
  // toast a flight the moment it starts needing the user (waiting-for-approval,
  // or a non-user / non-queue pause). These are STICKY (never auto-dismiss) so a
  // laptop-sleep-reconnect nag isn't gone by the time the user looks. R68 fixes:
  //  - the seed pass no longer swallows already-waiting flights: on first load,
  //    if N flights already need input, fire ONE aggregate sticky toast (a storm
  //    of per-flight toasts on boot would be noise);
  //  - a flight FIRST SEEN in an attention state after seed fires its own toast
  //    (the old code skipped `was === undefined`, so a reconnect that revealed a
  //    freshly-parked flight never toasted);
  //  - queued flights never toast (they wait on capacity, not the user).
  // An individual flight's toast is suppressed only while THAT flight's detail is
  // on screen; the aggregate + other flights' toasts still show.
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const dismissToast = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const prevFlightKeyRef = useRef<Map<string, string> | null>(null)
  const openFlight = useCallback((flightId: string) => {
    setSelectedFlightId(flightId)
    setView('flights')
  }, [])
  useEffect(() => {
    const prev = prevFlightKeyRef.current
    prevFlightKeyRef.current = new Map(flights.map((f) => [f.flightId, attentionKey(f)]))

    // Seed pass (first index load): don't fire a per-flight toast for every
    // already-parked flight — collapse them into a single aggregate sticky
    // toast so a fresh page never opens under a wall of notifications.
    if (prev === null) {
      const waiting = flights.filter(flightNeedsAttention)
      if (waiting.length > 0) {
        setToasts((t) => [
          ...t.filter((x) => x.id !== AGGREGATE_TOAST_ID),
          {
            id: AGGREGATE_TOAST_ID,
            title: `${waiting.length} flight${waiting.length === 1 ? '' : 's'} need your input`,
            body: 'Open the flights view to respond',
            sticky: true,
            onClick: () => setView('flights'),
          },
        ])
      }
      return
    }

    for (const f of flights) {
      // A flight that is first seen (post-seed) already in an attention state,
      // or that transitions into one, both qualify. Skip when the attention key
      // is unchanged (already toasted) and when the flight no longer needs input.
      const was = prev.get(f.flightId)
      if (was === attentionKey(f)) continue
      if (!flightNeedsAttention(f)) continue
      // Suppress only while THIS flight's detail is on screen.
      if (view === 'flights' && selectedFlightId === f.flightId) continue
      const stageLabel = f.currentStage ? STAGE_LABEL[f.currentStage] ?? f.currentStage : null
      const isCheckpoint = f.status === 'waiting-for-approval'
      setToasts((t) => [
        ...t.filter((x) => x.id !== f.flightId),
        {
          id: f.flightId,
          title: isCheckpoint ? `${f.feature} needs input` : `${f.feature} paused`,
          body: isCheckpoint
            ? (stageLabel ? `${stageLabel} is waiting for you` : 'A checkpoint is waiting for you')
            : (stageLabel ? `${stageLabel} failed — open to resume` : 'A stage failed — open to resume'),
          sticky: true,
          onClick: () => openFlight(f.flightId),
        },
      ])
    }
  }, [flights, view, selectedFlightId, openFlight])

  // Initial version check on mount.
  useEffect(() => { refreshVersion() }, [refreshVersion])

  useEffect(() => {
    selectedFeatureRef.current = selectedFeature
  }, [selectedFeature])

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId
  }, [selectedRunId])

  useEffect(() => {
    let conn: { close(): void } | null = null
    try {
      conn = connectWorkspaceEvents({
        onEvent: (event) => {
          if (event.type === 'feature-created' || event.type === 'feature-deleted' || event.type === 'features-changed') {
            refreshFeatures(event.type === 'feature-created' ? event.feature : undefined)
            // A branch checkout (and other feature mutations) emits features-changed;
            // bump so an open Repos tab refetches its git-status row live.
            if (event.type === 'features-changed') setReposRefreshKey((key) => key + 1)
            return
          }
          if (event.type === 'tests-changed' && selectedFeatureRef.current === event.feature) {
            setTestsRefreshKey((key) => key + 1)
          }
          if (event.type === 'envsets-changed') {
            refreshFeatures(selectedFeatureRef.current)
          }
          if (event.type === 'coverage-changed') {
            setCoverageRefreshKey((key) => key + 1)
          }
          if (event.type === 'tests-dirty-changed') {
            // Dirty status is folded into the feature-list payload — refetch it
            // so the red cue + status pill update live (preserves selection).
            refreshFeatures(selectedFeatureRef.current)
          }
          if (event.type === 'verification-config-changed' && selectedFeatureRef.current === event.feature) {
            setVerificationRefreshKey((key) => key + 1)
          }
          if (event.type === 'journal-changed') {
            setJournalRefreshKeys((keys) => ({ ...keys, [event.runId]: (keys[event.runId] ?? 0) + 1 }))
          }
          if (event.type === 'version-changed') {
            refreshVersion()
          }
          if (event.type === 'flights-changed') {
            refreshFlights()
            setFlightsRefreshKey((key) => key + 1)
          }
          if (event.type === 'pre-flight-changed') {
            refreshPreFlights()
          }
        },
        // The bus has no replay, so any mutation that happened while the socket
        // was down (e.g. across a canary-apply server restart) was never
        // pushed. Resync the feature-derived surfaces on reconnect rather than
        // waiting for the next live event.
        onReconnect: () => {
          refreshFeatures(selectedFeatureRef.current)
          setReposRefreshKey((key) => key + 1)
          setTestsRefreshKey((key) => key + 1)
          setCoverageRefreshKey((key) => key + 1)
          setVerificationRefreshKey((key) => key + 1)
          const currentRunId = selectedRunIdRef.current
          if (currentRunId) {
            setJournalRefreshKeys((keys) => ({ ...keys, [currentRunId]: (keys[currentRunId] ?? 0) + 1 }))
          }
          refreshVersion()
          refreshFlights()
          setFlightsRefreshKey((key) => key + 1)
          refreshPreFlights()
        },
      })
    } catch {
      // Initial REST load and direct UI callbacks still keep the page usable.
    }
    return () => conn?.close()
  }, [refreshFeatures, refreshVersion, refreshFlights, refreshPreFlights])

  const selectedFeatureEnvs =
    features.find((f) => f.name === selectedFeature)?.envs ?? []

  const panels = [
    {
      id: 'features',
      minWidth: 180,
      defaultWidth: 220,
      collapsible: true,
      collapseButtonY: 'top' as const,
      content: (
        <FeaturesColumn
          features={features}
          selectedFeature={selectedFeature}
          activeRunFeature={globalActiveRunEntry?.feature ?? null}
          activeRunStatus={globalActiveRunEntry?.status ?? null}
          activeRunExecutionType={globalActiveRunEntry?.executionType ?? null}
          onSelectFeature={(name) => {
            pendingRunSelectionRef.current = null
            setSelectedFeature(name)
            setSelectedRunId(allRuns.find((r) => r.feature === name && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null)
          }}
          onFeaturesChanged={refreshFeatures}
          coverageRefreshKey={coverageRefreshKey}
          portsRefreshKey={portsRefreshKey}
          versionStatus={versionStatus}
          onOpenCoverage={(f) => { setSelectedFeature(f); setView('coverage') }}
          onStartNewFlight={() => setFlightStartNew(true)}
        />
      ),
    },
    {
      id: 'tests',
      minWidth: 280,
      defaultWidth: 360,
      collapsible: true,
      collapseButtonY: 'bottom' as const,
      content: (
        <TestCasesColumn
          feature={selectedFeature}
          activeRunSummary={summaryForSelectedFeature}
          activeRunStatus={statusForSelectedFeature}
          refreshKey={testsRefreshKey}
          onTotalTestsChange={setSpecTotalTests}
          dirtySpecs={features.find((f) => f.name === selectedFeature)?.dirty?.specs ?? []}
        />
      ),
    },
    {
      id: 'runs',
      minWidth: 400,
      defaultWidth: 500,
      collapsible: false,
      content: (
        <VerticalSplit
          storageKey="canary-lab.runs-detail-split-v2"
          defaultTopPercent={25}
          minTopPx={120}
          minBottomPx={320}
          collapsible
          top={(
            <RunsColumn
              feature={selectedFeature}
              envs={selectedFeatureEnvs}
              runs={featureRuns}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
              onStartRun={handleStartRun}
              onStartVerification={handleStartVerification}
              runDisabled={false}
              verifyOpen={verifyOpen}
              onVerifyOpenChange={setVerifyOpen}
              verificationRefreshKey={verificationRefreshKey}
            />
          )}
          bottom={<RunDetailColumn runId={selectedRunId} onOpenPlaywrightSettings={setConfigFor} totalTests={specTotalTests} journalRefreshKey={selectedRunId ? journalRefreshKeys[selectedRunId] ?? 0 : 0} />}
        />
      ),
    },
  ]

  return (
    <div className="flex h-full w-full flex-col">
      <GlobalStatusBar
        activeRunDetail={activeRunDetail}
        features={features}
        onOpenCleanup={() => setView('cleanup')}
        flights={flights}
        preFlights={preFlights}
        onOpenPreFlight={(taskId) => { setResumePlanTaskId(taskId); setFlightStartNew(true) }}
        activity={featureActivity}
        onOpenFlight={(flightId) => { setSelectedFlightId(flightId); setView('flights') }}
        flightsPickerOpen={view === 'flights' && !selectedFlightId}
        onFlightsPickerOpenChange={(open) => {
          if (open) { setSelectedFlightId(null); setView('flights') }
          else setView('workspace')
        }}
        onOpenActivity={openActivity}
        onStartFlight={(feature) => { setSelectedFeature(feature); setFlightStartFor(feature) }}
        onNavigateToRun={(feature, runId) => {
          pendingRunSelectionRef.current = null
          setSelectedFeature(feature)
          setSelectedRunId(runId)
          setView('workspace')
        }}
      />
      <div className="min-h-0 flex-1">
        {view === 'cleanup'
          ? <LogCleanupPage
              onClose={() => setView('workspace')}
              onNavigateToRun={(feature, runId) => {
                pendingRunSelectionRef.current = null
                setSelectedFeature(feature)
                setSelectedRunId(runId)
                setView('workspace')
              }}
              onNavigateToPortify={(workflowId) => {
                setView('workspace')
                setPortifyTarget({ kind: 'revisit', workflowId })
              }}
            />
          : view === 'coverage' && selectedFeature
          ? <CoverageLedgerPage
              feature={selectedFeature}
              onClose={() => setView('workspace')}
              coverageRefreshKey={coverageRefreshKey}
              generatingFlight={coverageGeneratingFlight}
              onOpenFlight={(flightId) => { setSelectedFlightId(flightId); setView('flights') }}
            />
          : view === 'flights' && selectedFlightId
          ? <FlightPage
              flightId={selectedFlightId}
              refreshKey={flightsRefreshKey}
              activity={featureActivity}
              onOpenConfig={(feature) => setConfigFor(feature)}
              configRefreshKey={reposRefreshKey}
              docsRefreshKey={coverageRefreshKey}
              onSelectFlight={setSelectedFlightId}
              onClose={() => { setSelectedFlightId(null); setView('workspace') }}
              onOpenRun={(feature, runId) => {
                pendingRunSelectionRef.current = null
                setSelectedFeature(feature)
                setSelectedRunId(runId)
                setView('workspace')
              }}
              onOpenCoverage={(feature) => { setSelectedFeature(feature); setView('coverage') }}
              onOpenPortify={(workflowId) => setPortifyTarget({ kind: 'revisit', workflowId })}
              onStartFlight={(feature) => { setSelectedFeature(feature); setFlightStartFor(feature) }}
            />
          : <ResizablePanels panels={panels} />}
      </div>
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
      {(flightStartFor !== null || flightStartNew) && (
        <FlightStartDialog
          feature={flightStartNew ? null : flightStartFor}
          resumePlanTaskId={flightStartNew ? resumePlanTaskId : null}
          knownRepos={knownRepos}
          onClose={() => { setFlightStartFor(null); setFlightStartNew(false); setResumePlanTaskId(null) }}
          onOpenFlight={(flightId) => {
            setFlightStartFor(null)
            setFlightStartNew(false)
            setResumePlanTaskId(null)
            setSelectedFlightId(flightId)
            setView('flights')
            refreshFlights()
          }}
        />
      )}
      {configFor && (
        <FeatureConfigEditor
          feature={configFor}
          initialTab="playwright"
          portsRefreshKey={portsRefreshKey}
          reposRefreshKey={reposRefreshKey}
          onClose={() => setConfigFor(null)}
          onRenamed={(_, nextFeature) => {
            setConfigFor(nextFeature)
            api.listFeatures().then((data) => {
              setFeatures(data)
              pendingRunSelectionRef.current = null
              setSelectedFeature(nextFeature)
              setSelectedRunId(allRuns.find((r) => r.feature === nextFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null)
            }).catch(() => {})
          }}
          onDeleted={(deletedFeature) => {
            setConfigFor(null)
            api.listFeatures().then((data) => {
              setFeatures(data)
              if (selectedFeature === deletedFeature) {
                const nextFeature = data[0]?.name ?? null
                pendingRunSelectionRef.current = null
                setSelectedFeature(nextFeature)
                setSelectedRunId(nextFeature ? allRuns.find((r) => r.feature === nextFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null : null)
              }
            }).catch(() => {})
          }}
        />
      )}
      {collisionPrompt && (
        <CollisionConfirmDialog
          info={collisionPrompt.info}
          feature={collisionPrompt.feature}
          portsConfigured={collisionPrompt.portsConfigured}
          onPortify={() => { const f = collisionPrompt.feature; setCollisionPrompt(null); setPortifyTarget({ kind: 'new', feature: f }) }}
          onChoose={resolveCollision}
          onCancel={() => setCollisionPrompt(null)}
        />
      )}
      {startError && (
        <RunStartErrorDialog
          error={startError.error}
          feature={startError.feature}
          onRetry={() => {
            const { env, mode } = startError
            setStartError(null)
            void handleStartRun(env, mode)
          }}
          onSwitchBranches={switchBranchesAndRun}
          onPinCurrent={pinCurrentAndRun}
          onClose={() => setStartError(null)}
        />
      )}
      {portifyTarget && (
        <PortifyWizard
          // Key on the target identity so switching new→revisit (e.g. the blocked
          // Plan screen's "Open running workflow") remounts with fresh state —
          // workflowId is seeded from a prop via useState, which only runs at mount.
          key={portifyTarget.kind === 'new' ? `new:${portifyTarget.feature}` : `revisit:${portifyTarget.workflowId}`}
          {...(portifyTarget.kind === 'new'
            ? { feature: portifyTarget.feature, agent: 'claude' as const }
            : { workflowId: portifyTarget.workflowId })}
          onOpenActive={(workflowId) => setPortifyTarget({ kind: 'revisit', workflowId })}
          onClose={() => setPortifyTarget(null)}
          onSaved={() => {
            setPortifyTarget(null)
            // The overlay now exists — refresh /api/features so the "Portified"
            // badge + Ports-tab indicator reflect it immediately.
            refreshFeatures(selectedFeatureRef.current)
            // The overlay also rewrote the port slots; bump the key so the open
            // Ports tab refetches its config doc instead of waiting for a tab
            // switch / refresh. (features-changed alone only refreshes the list.)
            setPortsRefreshKey((key) => key + 1)
          }}
        />
      )}
    </div>
  )
}
