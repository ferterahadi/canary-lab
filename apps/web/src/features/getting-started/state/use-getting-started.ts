import { useCallback, useEffect, useMemo } from 'react'
import * as api from '@/shared/api/client'
import type { GettingStartedTarget, OnboardingWorkflowAction, OnboardingWorkflowId } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import type { FlightIndexEntry, FlightStageKey } from '@shared/flights/types'
import { isAuxiliaryExecution } from '@shared/verification'
import { DEMO_FLIGHT_STAGE, demoFlightLaunch, useDemoLauncher } from './demo-launcher'

interface GettingStartedInput {
  allRuns: RunIndexEntry[]
  flights: FlightIndexEntry[]
  setDemoOpen: (open: boolean) => void
  setSelectedFeature: (feature: string) => void
  navigateToRun: (feature: string, runId: string) => void
  navigateToCoverage: (feature: string) => void
  openFlight: (flightId: string) => void
  openFlightStage: (flightId: string, stage: FlightStageKey) => void
  openFeatureStage: (feature: string, stage: FlightStageKey) => void
}

/** Owns demo launches while the shell retains URL state and navigation. */
export function useGettingStarted({
  allRuns, flights, setDemoOpen, setSelectedFeature, navigateToRun,
  navigateToCoverage, openFlight, openFlightStage, openFeatureStage,
}: GettingStartedInput) {
  const demo = useDemoLauncher(allRuns, flights)
  const { markSeen } = demo
  const openDemo = useCallback((): void => {
    markSeen()
    setDemoOpen(true)
  }, [markSeen, setDemoOpen])
  // Push once: a workspace that still has its samples and has never produced a
  // run verdict or a flight opens the chooser itself, so nobody has to discover
  // a pill they have never seen. Opening it is what retires the prompt —
  // `markSeen` flips `autoOpen` false, so this fires at most once per browser
  // and never reopens over a user who closed it.
  useEffect(() => {
    if (!demo.autoOpen) return
    openDemo()
  }, [demo.autoOpen, openDemo])
  const demoExportRun = useMemo(() => {
    const feature = demo.workflows.find((workflow) => workflow.id === 'export')?.internalAction
    if (!feature || feature.kind !== 'export') return null
    // Mirrors the server's standalonePassedRun gate exactly. A boot, benchmark,
    // or observational verification is not the normal run Export requires.
    return allRuns.find((run) =>
      run.feature === feature.feature
      && !isAuxiliaryExecution(run.executionType)
      && run.executionType !== 'verify'
      && run.status === 'passed') ?? null
  }, [allRuns, demo.workflows])

  const launchDemo = useCallback(async (action: OnboardingWorkflowAction): Promise<void> => {
    if (action.kind === 'run' || action.kind === 'heal') {
      const { runId } = await api.startRun(action.feature, {
        gettingStartedSource: 'internal',
        gettingStartedWorkflow: action.kind,
      })
      setSelectedFeature(action.feature)
      setDemoOpen(false)
      navigateToRun(action.feature, runId)
      return
    }
    if (action.kind === 'flight') {
      const feature = action.repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'flight-app'
      const manifest = await api.startFlight({
        feature,
        repoPaths: [action.repoPath],
        description: action.description,
        gettingStartedSource: 'internal',
      })
      setDemoOpen(false)
      openFlight(manifest.flightId)
      return
    }
    if (action.kind === 'coverage') {
      // NOT the specs-coverage flight stage: that stage is an author-to-target
      // loop, so routing "Measure Coverage" through it wrote the missing R2 spec
      // itself — closing the intentional gap the card promises to expose (and
      // leaving the Author demo nothing to do). The standalone mapping job reads
      // the shipped PRD summary and only reports.
      try {
        await api.startCoverageJob(action.feature, 'coverage', { gettingStartedSource: 'internal' })
      } catch (error) {
        // Already mapping (started from another tab/agent) — the ledger page
        // attaches to the running job on mount, so just go look at it.
        if (!(error instanceof api.ApiError && error.status === 409)) throw error
      }
      setSelectedFeature(action.feature)
      setDemoOpen(false)
      navigateToCoverage(action.feature)
      return
    }
    // The remaining action kinds all enter their corresponding Flight stage.
    const stage = DEMO_FLIGHT_STAGE[action.kind]
    const entry = await api.getFlightEntryOptions(action.feature)
    const launch = demoFlightLaunch(action.kind, action.feature, entry)
    const flightId = launch.kind === 'start'
      ? (await api.startFlight(launch.body)).flightId
      : launch.flightId
    setSelectedFeature(action.feature)
    setDemoOpen(false)
    openFlightStage(flightId, stage)
    return
  }, [navigateToCoverage, navigateToRun, openFlight, openFlightStage, setDemoOpen, setSelectedFeature])

  const openTarget = useCallback((target: GettingStartedTarget): void => {
    setDemoOpen(false)
    if (target.kind === 'flight') {
      openFlight(target.id)
      return
    }
    if (target.kind === 'coverage-job') {
      setSelectedFeature(target.feature)
      navigateToCoverage(target.feature)
      return
    }
    if (target.kind === 'draft' || target.kind === 'portify' || target.kind === 'export') {
      // These demos live on the suite's flight page, pinned to their stage —
      // a stage completed standalone still routes there via the derived token.
      const stage = DEMO_FLIGHT_STAGE[target.kind === 'draft' ? 'author' : target.kind]
      openFeatureStage(target.feature, stage)
      return
    }
    // kind 'run' — a run demo's target, or a verify demo's verification run.
    // Resolve the run's own feature; fall back to the run workflow's fixture
    // for a record the list hasn't loaded yet.
    const runFeature = allRuns.find((run) => run.runId === target.id)?.feature
    const runWorkflow = demo.workflows.find((workflow) => workflow.id === 'run')?.internalAction
    const feature = runFeature ?? (runWorkflow?.kind === 'run' ? runWorkflow.feature : null)
    if (feature) navigateToRun(feature, target.id)
  }, [allRuns, demo.workflows, navigateToCoverage, navigateToRun, openFeatureStage, openFlight, setDemoOpen, setSelectedFeature])

  const actionBlockers: Partial<Record<OnboardingWorkflowId, string>> = demoExportRun
    ? {} : { export: 'Complete Run and Heal first.' }
  return { demo, openDemo, launchDemo, openTarget, actionBlockers }
}
