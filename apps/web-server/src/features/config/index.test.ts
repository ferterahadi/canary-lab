import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { RunStore, createRegistry, type OrchestratorRegistry } from '../runs/logic/run-store'
import { writeRunsIndex, readRunsIndex, type RunIndexEntry } from '../runs/logic/runtime/manifest'
import { DirtySpecStore } from '../runs/logic/dirty-specs/store'
import { BenchmarkRunStore } from '../benchmark/logic/runtime/store'
import { PortifyRunStore } from '../portify/logic/runtime/store'
import { CoverageJobRunStore } from '../coverage/logic/coverage/jobs/store'
import { FlightRunStore } from '../flights/logic/store'
import type { FlightManifest, FlightStatus } from '../../../../../shared/flights/types'
import type { CoverageJobManifest } from '../coverage/logic/coverage/jobs/types'
import type { PortifyManifest } from '../portify/logic/runtime/types'
import type { BenchmarkManifest } from '../benchmark/logic/runtime/types'
import { agentJobStore } from '../agent-sessions/logic/agent-jobs/store'
import type { AgentJobManifest } from '../agent-sessions/logic/agent-jobs/types'
import type { WorkspaceEventPublisher } from '../../shared/workspace-events'
import { featuresRoutes } from './routes/features'
import { featureConfigRoutes } from './routes/feature-config'
import { projectConfigRoutes } from './routes/project-config'
import { onboardingRoutes } from './routes/onboarding'
import type { ServerContext } from '../../server-context'
import { register } from './index'

let tmpDir: string
let logsDir: string
let featuresDir: string
let registry: OrchestratorRegistry
let runStore: RunStore
let benchmarkStore: BenchmarkRunStore
let portifyStore: PortifyRunStore
let coverageJobStore: CoverageJobRunStore
let flightStore: FlightRunStore
let dirtySpecStore: DirtySpecStore
let gettingStarted: unknown
let onPortChange: (port: number) => void
let app: FastifyInstance

/**
 * Module-scope so the registrations can be identity-checked. `workspaceEvents`
 * is OPTIONAL on both `FeatureConfigRouteDeps` and the project-config deps, and
 * `publishWorkspaceEvent` is `publisher?.publish(...)` — so a registrar that
 * stops passing it compiles, boots, and silently stops pushing
 * `features-changed` / `envsets-changed` / `project-config-changed`. The only
 * symptom is a user who has to refresh to see their own edit (the
 * `cl_ws-driven-state` bug class).
 */
const workspaceEvents: WorkspaceEventPublisher = {
  publish: () => { /* nothing subscribes in this suite */ },
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-config-reg-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
  registry = createRegistry()
  runStore = new RunStore(logsDir, registry)
  benchmarkStore = new BenchmarkRunStore(logsDir)
  portifyStore = new PortifyRunStore(logsDir)
  coverageJobStore = new CoverageJobRunStore(logsDir)
  flightStore = new FlightRunStore(logsDir)
  dirtySpecStore = new DirtySpecStore(logsDir)
  // Only `.read()` is ever called on it, by the onboarding route.
  gettingStarted = { read: () => null }
  onPortChange = () => { /* the host relaunch, absent from this suite */ }
  app = Fastify()
})

afterEach(async () => {
  await app.close()
})

function makeCtx(): ServerContext {
  return {
    options: { projectRoot: tmpDir, onPortChange },
    projectRoot: tmpDir,
    featuresDir,
    logsDir,
    runStore,
    benchmarkStore,
    portifyStore,
    coverageJobStore,
    flightStore,
    dirtySpecStore,
    workspaceEvents,
    gettingStarted,
  } as unknown as ServerContext
}

interface Registration {
  plugin: unknown
  opts: Record<string, unknown>
}

async function registerFeature(): Promise<Registration[]> {
  const spy = vi.spyOn(app, 'register')
  await register(app, makeCtx())
  const registrations = spy.mock.calls.map((call) => ({
    plugin: call[0] as unknown,
    opts: (call[1] ?? {}) as Record<string, unknown>,
  }))
  spy.mockRestore()
  return registrations
}

/** Seed the runs index directly: every closure here reads runs through
 *  `runStore.list`, which is an index read — no manifest or run dir needed. */
function seedRuns(...entries: Array<{ runId: string; feature: string; status: string }>): void {
  writeRunsIndex(logsDir, entries.map((e) => ({
    runId: e.runId,
    feature: e.feature,
    startedAt: '2026-08-21T00:00:00.000Z',
    status: e.status,
  })) as RunIndexEntry[])
}

function seedFlight(flightId: string, feature: string, status: FlightStatus): void {
  flightStore.save({
    flightId,
    feature,
    repoPaths: [],
    description: 'd',
    opts: { env: 'local', coverageTarget: 80, yolo: false },
    status,
    currentStage: null,
    stages: [],
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  } satisfies FlightManifest)
}

type Blocked = (featureName: string) => string | null

async function renameDeps(): Promise<{
  blockedBy: Blocked
  apply: (from: string, to: string) => number
  isRepoActive: (featureName: string) => boolean
  removeFlightRecordsFor: (featureName: string) => { removed: number; error?: string }
}> {
  const registrations = await registerFeature()
  const opts = registrations[1].opts
  const rename = opts.featureRename as { blockedBy: Blocked; apply: (from: string, to: string) => number }
  return {
    blockedBy: rename.blockedBy,
    apply: rename.apply,
    isRepoActive: opts.isRepoActive as (featureName: string) => boolean,
    removeFlightRecordsFor: opts.removeFlightRecordsFor as
      (featureName: string) => { removed: number; error?: string },
  }
}

describe('config feature registrar', () => {
  it('mounts the four configuration surfaces with the stores each one reads', async () => {
    const registrations = await registerFeature()

    expect(registrations.map((r) => r.plugin)).toEqual([
      featuresRoutes,
      featureConfigRoutes,
      projectConfigRoutes,
      onboardingRoutes,
    ])
    expect(registrations[0].opts).toEqual({ featuresDir, logsDir, dirtySpecStore })
    expect(registrations[1].opts).toMatchObject({ featuresDir })
    expect(registrations[2].opts).toMatchObject({ projectRoot: tmpDir, onPortChange })
    // The live-update bus on both writing surfaces, by identity — see the
    // fixture comment for what an omission silently costs.
    expect(registrations[1].opts.workspaceEvents).toBe(workspaceEvents)
    expect(registrations[2].opts.workspaceEvents).toBe(workspaceEvents)
    expect(registrations[3].opts).toMatchObject({ projectRoot: tmpDir, featuresDir, sessionStore: gettingStarted })

    const res = await app.inject({ method: 'GET', url: '/api/features' })
    expect(res.statusCode).toBe(200)
  })

  it('reports a suite\'s repo busy only while one of ITS runs is active', async () => {
    const { isRepoActive } = await renameDeps()
    seedRuns(
      { runId: 'r1', feature: 'checkout', status: 'passed' },
      { runId: 'r2', feature: 'billing', status: 'running' },
    )

    // Terminal runs of the same suite do not hold the repo; another suite's
    // active run must not hold this one's either.
    expect(isRepoActive('checkout')).toBe(false)
    expect(isRepoActive('billing')).toBe(true)
  })

  it('counts every active run across suites for the port-change gate', async () => {
    const registrations = await registerFeature()
    const countActiveRuns = registrations[2].opts.countActiveRuns as () => number

    expect(countActiveRuns()).toBe(0)
    seedRuns(
      { runId: 'r1', feature: 'checkout', status: 'running' },
      { runId: 'r2', feature: 'billing', status: 'healing' },
      { runId: 'r3', feature: 'billing', status: 'failed' },
    )
    // A restart would abort two runs, not three — a failed run has nothing left
    // to lose.
    expect(countActiveRuns()).toBe(2)
  })

  it('refuses a rename while a run or a flight still holds the old name', async () => {
    const { blockedBy } = await renameDeps()

    expect(blockedBy('checkout')).toBeNull()

    seedRuns({ runId: 'r1', feature: 'checkout', status: 'healing' })
    expect(blockedBy('checkout')).toBe('run r1 is healing — stop it before renaming the suite')

    // With the run finished the flight becomes the blocker: a live conductor
    // addresses its suite by name and would lose it mid-pipeline.
    seedRuns({ runId: 'r1', feature: 'checkout', status: 'passed' })
    seedFlight('fl_1', 'checkout', 'waiting-for-approval')
    expect(blockedBy('checkout'))
      .toBe('flight fl_1 is waiting-for-approval — pause it before renaming the suite')

    // A terminal flight of the same suite is history, not live work.
    seedFlight('fl_1', 'checkout', 'done')
    expect(blockedBy('checkout')).toBeNull()
  })

  it('carries a rename into the run history and reports how much moved', async () => {
    const { apply } = await renameDeps()
    seedRuns(
      { runId: 'r1', feature: 'checkout', status: 'passed' },
      { runId: 'r2', feature: 'billing', status: 'passed' },
    )
    seedFlight('fl_1', 'checkout', 'done')

    // The flight record and the run row both stamped the old name, so both must
    // travel or the history orphans behind a name nothing resolves.
    expect(apply('checkout', 'basket')).toBe(2)
    expect(readRunsIndex(logsDir).map((e) => e.feature).sort()).toEqual(['basket', 'billing'])
    expect(flightStore.list().map((e) => e.feature)).toEqual(['basket'])
  })

  it('deletes a suite\'s flight history with it, unless a flight is still live', async () => {
    const { removeFlightRecordsFor } = await renameDeps()
    seedFlight('fl_1', 'checkout', 'done')
    seedFlight('fl_2', 'checkout', 'aborted')
    seedFlight('fl_3', 'billing', 'done')

    expect(removeFlightRecordsFor('checkout')).toEqual({ removed: 2 })
    expect(flightStore.list().map((e) => e.flightId)).toEqual(['fl_3'])

    seedFlight('fl_4', 'billing', 'running')
    expect(removeFlightRecordsFor('billing').error).toContain('fl_4 is running')
  })
})
