import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import * as api from '../api/client'
import type { Feature, RunIndexEntry, VersionStatus } from '../api/types'
import type { FlightIndexEntry, FlightManifest, PlanFeaturesTask } from '../api/client'
import { connectWorkspaceEvents } from '@/shared/api/workspace-socket'
import { useFlightsStream } from '@/features/flights'
import type { InvalidationTopic } from './invalidation-bus'

// Owns the workspace's server-sourced data — the features list, the flights +
// pre-flights indexes, the version status — plus the refresh helpers, the
// initial loads, the poll-while-active backstops, and the /ws/workspace event
// wiring that keeps them (and the invalidation bus) live. Lifted out of App so
// the shell is layout + composition, not a fetch/socket controller.
//
// The nav selection it must touch (auto-select the first feature, re-select
// when a feature is renamed/deleted/gone) comes in as injected setters + mirror
// refs — the data layer stays free of nav STATE, and the render-coupled
// run-selection reconciliation remains in App where `featureRuns` is derived.

const NON_TEST = (r: RunIndexEntry) => r.executionType !== 'boot' && r.executionType !== 'benchmark'

export interface WorkspaceDataDeps {
  invalidate: (topic: InvalidationTopic, scope?: string) => void
  /** Live runs index — mirrored to a ref so refreshFeatures can pick a feature's
   *  latest run without the WS connect effect churning on every run tick. */
  allRuns: RunIndexEntry[]
  /** The mount-time selected feature (auto-select fills it only when empty). */
  initialSelectedFeature: string | null
  setSelectedFeature: (f: string | null) => void
  setSelectedRunId: (r: string | null) => void
  selectedFeatureRef: MutableRefObject<string | null>
  selectedRunIdRef: MutableRefObject<string | null>
  pendingRunSelectionRef: MutableRefObject<string | null>
  /** A suite was renamed elsewhere (another tab, an MCP client, this tab's own
   *  save). Anything App holds keyed by the old name — an open config dialog —
   *  must re-point at the new one; the selection itself is handled here. */
  onFeatureRenamed?: (from: string, to: string) => void
}

export interface WorkspaceData {
  features: Feature[]
  flights: FlightIndexEntry[]
  /** Full manifests the flights channel pushed, by flight id. The open flight
   *  detail reads its own from here instead of polling for it. */
  flightDetails: Record<string, FlightManifest>
  flightsRef: MutableRefObject<FlightIndexEntry[]>
  preFlights: PlanFeaturesTask[]
  versionStatus: VersionStatus | null
  refreshFeatures: (preferredFeature?: string | null) => void
  refreshFlights: () => void
  refreshPreFlights: () => void
  refreshVersion: () => void
}

export function useWorkspaceData(deps: WorkspaceDataDeps): WorkspaceData {
  const {
    invalidate, allRuns, initialSelectedFeature,
    setSelectedFeature, setSelectedRunId,
    selectedFeatureRef, selectedRunIdRef, pendingRunSelectionRef,
    onFeatureRenamed,
  } = deps

  // Read through a ref so the WS connect effect keeps a stable dep list — a
  // teardown/reconnect would drop events in the gap (the bus has no replay).
  const onFeatureRenamedRef = useRef(onFeatureRenamed)
  useEffect(() => { onFeatureRenamedRef.current = onFeatureRenamed }, [onFeatureRenamed])

  const [features, setFeatures] = useState<Feature[]>([])
  // REST-loaded list, used until `/ws/flights` sends its first snapshot (and as
  // the fallback where no WebSocket exists at all — a component unit test).
  const [restFlights, setRestFlights] = useState<FlightIndexEntry[]>([])
  // The push channel is the live source: the server sends the full manifest on
  // every flight write, so the list advances without a refetch and without the
  // 5s poll that used to cover a dropped `flights-changed`.
  const flightsStream = useFlightsStream()
  const flights = flightsStream.hydrated ? flightsStream.flights : restFlights
  const [preFlights, setPreFlights] = useState<PlanFeaturesTask[]>([])
  const [versionStatus, setVersionStatus] = useState<VersionStatus | null>(null)

  // allRuns changes on every run-progress tick; read it via a ref inside the
  // stable refreshFeatures so the /ws/workspace connect effect (which depends on
  // refreshFeatures) doesn't tear down + reconnect on every tick — the bus has
  // no replay, so a mutation during that window would be lost ("only updates
  // after a refresh"). Same trick for the flights index (openActivity reads it).
  const allRunsRef = useRef(allRuns)
  useEffect(() => { allRunsRef.current = allRuns }, [allRuns])
  const flightsRef = useRef(flights)
  useEffect(() => { flightsRef.current = flights }, [flights])

  // Stable identity ([] deps) — reads current feature/runs via refs, not closure.
  const refreshFeatures = useCallback((preferredFeature?: string | null): void => {
    api.listFeatures().then((data) => {
      setFeatures(data)
      const runs = allRunsRef.current
      if (preferredFeature && data.some((f) => f.name === preferredFeature)) {
        pendingRunSelectionRef.current = null
        setSelectedFeature(preferredFeature)
        setSelectedRunId(runs.find((r) => r.feature === preferredFeature && NON_TEST(r))?.runId ?? null)
      } else if (!selectedFeatureRef.current || !data.some((f) => f.name === selectedFeatureRef.current)) {
        const nextFeature = data[0]?.name ?? null
        pendingRunSelectionRef.current = null
        setSelectedFeature(nextFeature)
        setSelectedRunId(nextFeature ? runs.find((r) => r.feature === nextFeature && NON_TEST(r))?.runId ?? null : null)
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshVersion = useCallback((): void => {
    api.getVersionStatus().then(setVersionStatus).catch(() => {})
  }, [])
  const refreshFlights = useCallback((): void => {
    api.listFlights().then(setRestFlights).catch(() => {})
  }, [])
  const refreshPreFlights = useCallback((): void => {
    api.listPlanFeatures().then((r) => setPreFlights(r.tasks)).catch(() => {})
  }, [])

  // Initial features load + auto-select the first feature when none is hydrated.
  useEffect(() => {
    let cancelled = false
    api.listFeatures().then((data) => {
      if (cancelled) return
      setFeatures(data)
      if (data.length > 0 && !initialSelectedFeature) setSelectedFeature(data[0].name)
    }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Initial flights / pre-flights / version loads (feed the pill + footer before
  // any event fires).
  useEffect(() => { refreshFlights() }, [refreshFlights])
  useEffect(() => { refreshPreFlights() }, [refreshPreFlights])
  useEffect(() => { refreshVersion() }, [refreshVersion])

  // A running pre-flight settles via `pre-flight-changed`, but that push is
  // best-effort — back a running plan with a gentle poll (cl_live-state-sync).
  const anyPreFlightRunning = preFlights.some((t) => t.status === 'running')
  useEffect(() => {
    if (!anyPreFlightRunning) return
    const id = setInterval(refreshPreFlights, 2500)
    return () => clearInterval(id)
  }, [anyPreFlightRunning, refreshPreFlights])

  // /ws/workspace events → refetch the feature-derived surfaces + publish topic
  // invalidations for the fetch-owning leaves. On reconnect (e.g. across a server
  // restart) resync everything, since the bus has no replay.
  useEffect(() => {
    let conn: { close(): void } | null = null
    try {
      conn = connectWorkspaceEvents({
        onEvent: (event) => {
          if (event.type === 'feature-renamed') {
            // The suite kept its identity but changed its name. Follow it —
            // otherwise the selected feature (and any surface keyed by the old
            // name) no longer matches any row and the view falls back to the
            // first suite, which reads as "my feature disappeared".
            const following = selectedFeatureRef.current === event.from
            onFeatureRenamedRef.current?.(event.from, event.to)
            refreshFeatures(following ? event.to : selectedFeatureRef.current)
            // Flight rows are keyed by feature name too.
            refreshFlights()
            invalidate('flights')
            invalidate('repos')
            return
          }
          if (event.type === 'feature-created' || event.type === 'feature-deleted' || event.type === 'features-changed') {
            refreshFeatures(event.type === 'feature-created' ? event.feature : undefined)
            if (event.type === 'features-changed') invalidate('repos')
            return
          }
          if (event.type === 'tests-changed') {
            if (selectedFeatureRef.current === event.feature) invalidate('tests')
            // Authored specs light the picker's derived rail (specs evidence).
            refreshFeatures(selectedFeatureRef.current)
          }
          if (event.type === 'envsets-changed') refreshFeatures(selectedFeatureRef.current)
          if (event.type === 'coverage-changed') {
            invalidate('coverage')
            // A generated PRD summary lights the derived rail (prdSummary evidence).
            refreshFeatures(selectedFeatureRef.current)
          }
          if (event.type === 'tests-dirty-changed') refreshFeatures(selectedFeatureRef.current)
          if (event.type === 'verification-config-changed' && selectedFeatureRef.current === event.feature) invalidate('verification')
          if (event.type === 'journal-changed') invalidate('journal', event.runId)
          if (event.type === 'version-changed') refreshVersion()
          // The list itself rides `/ws/flights`; this nudge stays for the
          // surfaces keyed to flights that are NOT the list (a stage's artifact
          // reads), which is what the `flights` topic invalidates.
          if (event.type === 'flights-changed') invalidate('flights')
          if (event.type === 'pre-flight-changed') refreshPreFlights()
          // canary-lab.config.json changed — in this tab or another client.
          // The demo launcher reads `showDemo` from it, so the status-bar pill
          // appears/disappears live instead of on the next reload.
          if (event.type === 'project-config-changed') invalidate('project-config')
        },
        onReconnect: () => {
          refreshFeatures(selectedFeatureRef.current)
          invalidate('repos')
          invalidate('tests')
          invalidate('coverage')
          invalidate('verification')
          const currentRunId = selectedRunIdRef.current
          if (currentRunId) invalidate('journal', currentRunId)
          refreshVersion()
          refreshFlights()
          invalidate('flights')
          refreshPreFlights()
          invalidate('project-config')
        },
      })
    } catch {
      // Initial REST load and direct UI callbacks still keep the page usable.
    }
    return () => conn?.close()
  }, [refreshFeatures, refreshVersion, refreshFlights, refreshPreFlights, invalidate, selectedFeatureRef, selectedRunIdRef])

  return { features, flights, flightDetails: flightsStream.details, flightsRef, preFlights, versionStatus, refreshFeatures, refreshFlights, refreshPreFlights, refreshVersion }
}
