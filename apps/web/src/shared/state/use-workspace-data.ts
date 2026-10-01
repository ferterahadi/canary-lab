import { repositoryConsumerKey } from '@shared/repository-observation'
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import * as flightsApi from '../api/flights'
import * as workspaceApi from '../api/workspace'
import type { Feature } from '../api/types'
import type { VersionStatus } from '@shared/version-status'
import type { FlightIndexEntry, FlightManifest, PlanFeaturesTask } from '@shared/flights/types'
import { connectWorkspaceEvents } from '@/shared/api/workspace-socket'
import { useFlightsStream } from '@/features/flights/state/use-flights-stream'
import type { InvalidationTopic } from './invalidation-bus'
import { useWorkspaceFeatures } from './use-workspace-features'
import { useLiveResource } from './use-live-resource'

// Owns the workspace's server-sourced data — the features list, the flights +
// pre-flights indexes, the version status — plus the refresh helpers, the
// initial loads, the poll-while-active backstops, and the /ws/workspace event
// wiring that keeps them (and the invalidation bus) live. Lifted out of App so
// the shell is layout + composition, not a fetch/socket controller.
//
// Selection policy belongs to useWorkspaceSelection. The read-only navigation
// mirrors here qualify event invalidations; loaded lists go to that controller.

export interface WorkspaceDataDeps {
  invalidate: (topic: InvalidationTopic, scope?: string) => void
  onInitialFeatures: (features: readonly Feature[]) => void
  onFeaturesRefreshed: (features: readonly Feature[], preferredFeature?: string | null) => void
  selectedFeatureRef: Readonly<MutableRefObject<string | null>>
  selectedRunIdRef: Readonly<MutableRefObject<string | null>>
  /** A suite was renamed elsewhere (another tab, an MCP client, this tab's own
   *  save). Anything App holds keyed by the old name — an open config dialog —
   *  must re-point at the new one; selection goes through onFeaturesRefreshed. */
  onFeatureRenamed?: (from: string, to: string) => void
}

export interface WorkspaceData {
  features: Feature[]
  flights: FlightIndexEntry[]
  /** Full manifests the flights channel pushed, by flight id. The open flight
   *  detail reads its own from here instead of polling for it. */
  flightDetails: Record<string, FlightManifest>
  flightsHydrated: boolean
  forgetFlight: (id: string) => void
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
    invalidate, onInitialFeatures, onFeaturesRefreshed,
    selectedFeatureRef, selectedRunIdRef,
    onFeatureRenamed,
  } = deps

  // Read through a ref so the WS connect effect keeps a stable dep list — a
  // teardown/reconnect would drop events in the gap (the bus has no replay).
  const onFeatureRenamedRef = useRef(onFeatureRenamed)
  useEffect(() => { onFeatureRenamedRef.current = onFeatureRenamed }, [onFeatureRenamed])

  const { features, refreshFeatures } = useWorkspaceFeatures(onInitialFeatures, onFeaturesRefreshed)
  // REST-loaded list, used until `/ws/flights` sends its first snapshot (and as
  // the fallback where no WebSocket exists at all — a component unit test).
  const [restFlights, setRestFlights] = useState<FlightIndexEntry[]>([])
  // The push channel is the live source: the server sends the full manifest on
  // every flight write, so the list advances without a refetch and without the
  // 5s poll that used to cover a dropped `flights-changed`.
  const flightsStream = useFlightsStream()
  const forgetStreamFlight = flightsStream.forgetFlight
  const forgetFlight = useCallback((id: string) => {
    forgetStreamFlight(id)
    setRestFlights((rows) => rows.filter((row) => row.flightId !== id))
  }, [forgetStreamFlight])
  const flights = flightsStream.hydrated ? flightsStream.flights : restFlights
  const { value: planningTasks, refresh: refreshPreFlights } = useLiveResource<PlanFeaturesTask[]>(
    'pre-flights', 'workspace', async () => (await flightsApi.listPlanFeatures()).tasks,
    {
      cache: 'pre-flight-plans',
      // Unknown initial reads must recover too, including a hung first request.
      pollWhile: (tasks) => tasks === null || tasks.some((task) => task.status === 'running'),
    },
  )
  const preFlights = planningTasks ?? []
  const [versionStatus, setVersionStatus] = useState<VersionStatus | null>(null)

  const flightsRef = useRef(flights)
  useEffect(() => { flightsRef.current = flights }, [flights])

  const refreshVersion = useCallback((): void => {
    workspaceApi.getVersionStatus().then(setVersionStatus).catch(() => {})
  }, [])
  const refreshFlights = useCallback((): void => {
    flightsApi.listFlights().then(setRestFlights).catch(() => {})
  }, [])
  // Initial flights / version loads; useLiveResource owns the planning list.
  useEffect(() => { refreshFlights() }, [refreshFlights])
  useEffect(() => { refreshVersion() }, [refreshVersion])

  // /ws/workspace events → refetch the feature-derived surfaces + publish topic
  // invalidations for the fetch-owning leaves. On reconnect (e.g. across a server
  // restart) resync everything, since the bus has no replay.
  useEffect(() => {
    let conn: { close(): void } | null = null
    const resyncWorkspace = (): void => {
      refreshFeatures(selectedFeatureRef.current)
      for (const resource of ['runs', 'worktrees', 'portify']) invalidate('cleanup', resource)
      invalidate('repos')
      invalidate('configuration')
      invalidate('tests')
      invalidate('coverage')
      invalidate('verification')
      const currentRunId = selectedRunIdRef.current
      if (currentRunId) invalidate('journal', currentRunId)
      refreshVersion()
      refreshFlights()
      invalidate('flights')
      invalidate('pre-flights')
      invalidate('project-config')
      invalidate('onboarding')
      invalidate('notifications')
    }
    try {
      conn = connectWorkspaceEvents({
        onEvent: (event) => {
          // The server handshake is the authoritative recovery point. Keep the
          // resync on that frame so canary-apply recovery does not depend on a
          // client-local "has this socket opened before?" classification.
          if (event.type === 'connected') {
            resyncWorkspace()
            return
          }
          if (event.type === 'cleanup-changed') {
            invalidate('cleanup', event.resource)
            return
          }
          if (event.type === 'repos-changed') {
            for (const consumer of event.consumers) invalidate('repos', repositoryConsumerKey(consumer))
            return
          }
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
            invalidate('configuration', event.from)
            invalidate('configuration', event.to)
            return
          }
          if (event.type === 'feature-created' || event.type === 'feature-deleted' || event.type === 'features-changed') {
            refreshFeatures(event.type === 'feature-created' ? event.feature : undefined)
            if (event.type === 'features-changed') {
              invalidate('repos')
              invalidate('configuration')
            }
            if (event.type === 'feature-deleted') invalidate('configuration', event.feature)
            return
          }
          if (event.type === 'tests-changed') {
            invalidate('coverage')
            if (selectedFeatureRef.current === event.feature) invalidate('tests')
            // Authored specs light the picker's derived rail (specs evidence).
            refreshFeatures(selectedFeatureRef.current)
          }
          if (event.type === 'envsets-changed') {
            refreshFeatures(selectedFeatureRef.current)
            invalidate('configuration', event.feature)
          }
          if (event.type === 'coverage-changed') {
            invalidate('coverage')
            // A generated PRD summary lights the derived rail (prdSummary evidence).
            refreshFeatures(selectedFeatureRef.current)
          }
          if (event.type === 'tests-dirty-changed') {
            invalidate('coverage')
            refreshFeatures(selectedFeatureRef.current)
            if (selectedFeatureRef.current === event.feature) invalidate('tests')
          }
          if (event.type === 'verification-config-changed' && selectedFeatureRef.current === event.feature) invalidate('verification')
          if (event.type === 'journal-changed') invalidate('journal', event.runId)
          if (event.type === 'version-changed') refreshVersion()
          // The list itself rides `/ws/flights`; this nudge stays for the
          // surfaces keyed to flights that are NOT the list (a stage's artifact
          // reads), which is what the `flights` topic invalidates.
          if (event.type === 'flights-changed') invalidate('flights')
          if (event.type === 'notifications-changed') invalidate('notifications')
          if (event.type === 'pre-flight-changed') invalidate('pre-flights')
          // canary-lab.config.json changed — in this tab or another client.
          // The demo launcher reads `showDemo` from it, so the status-bar pill
          // appears/disappears live instead of on the next reload.
          if (event.type === 'project-config-changed') invalidate('project-config')
          if (event.type === 'getting-started-changed') invalidate('onboarding')
        },
      })
    } catch {
      // Initial REST load and direct UI callbacks still keep the page usable.
    }
    return () => conn?.close()
  }, [refreshFeatures, refreshVersion, refreshFlights, invalidate, selectedFeatureRef, selectedRunIdRef])

  return { features, flights, forgetFlight, flightsHydrated: flightsStream.hydrated, flightDetails: flightsStream.details, flightsRef, preFlights, versionStatus, refreshFeatures, refreshFlights, refreshPreFlights, refreshVersion }
}
