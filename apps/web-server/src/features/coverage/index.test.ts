import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { RunStore, createRegistry, type OrchestratorLike, type OrchestratorRegistry } from '../runs/logic/run-store'
import { PaneBroker } from '../runs/logic/pane-broker'
import { DirtySpecStore } from '../runs/logic/dirty-specs/store'
import { writeManifest } from '../runs/logic/runtime/manifest'
import { buildRunPaths, runDirFor } from '../runs/logic/runtime/run-paths'
import { RunnerLog } from '../runs/logic/runtime/runner-log'
import { CoverageJobRunStore } from './logic/coverage/jobs/store'
import type { CoverageJobManifest } from './logic/coverage/jobs/types'
import { FlightRunStore } from '../flights/logic/store'
import { coverageRoutes } from './routes/coverage'
import { verificationRoutes } from './routes/verification'
import type { ResolveVerificationInput } from './logic/verification'
import type { RunsFeature } from '../runs/index'
import type { PtyFactory } from '../runs/logic/runtime/pty-spawner'
import type { WorkspaceEventPublisher } from '../../shared/workspace-events'
import type { ServerContext } from '../../server-context'
import { register } from './index'

/**
 * The orchestrator is this module's process edge: `runVerification` launches
 * Playwright against a deployed environment. Its own behaviour belongs to the
 * `orchestrator.*.test.ts` suites; faking it is also the only way to drive the
 * construction-failure arm (the real constructor is bookkeeping and has no
 * input that makes it throw) and to decide when the verification settles.
 * `importOriginal` keeps the module's other exports real.
 */
const orchHarness = vi.hoisted(() => ({
  constructFails: false,
  stopFails: false,
  options: [] as Array<Record<string, unknown>>,
  stops: [] as (string | undefined)[],
  settle: null as null | ((status: string) => void),
  reject: null as null | ((err: Error) => void),
}))

vi.mock('../runs/logic/runtime/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs/logic/runtime/orchestrator')>()
  class FakeRunOrchestrator {
    readonly runId: string
    constructor(opts: Record<string, unknown>) {
      if (orchHarness.constructFails) throw new Error('posix_spawnp failed')
      this.runId = opts.runId as string
      orchHarness.options.push(opts)
    }

    runVerification(): Promise<string> {
      return new Promise((resolve, reject) => {
        orchHarness.settle = resolve
        orchHarness.reject = reject
      })
    }

    stop(status?: string): Promise<void> {
      orchHarness.stops.push(status)
      return orchHarness.stopFails
        ? Promise.reject(new Error('services would not die'))
        : Promise.resolve()
    }
  }
  return { ...actual, RunOrchestrator: FakeRunOrchestrator }
})

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

/**
 * Module-scope so both registrations can be identity-checked. `workspaceEvents`
 * is OPTIONAL on `CoverageRouteDeps` and `VerificationRouteDeps`, and
 * `publishWorkspaceEvent` is `publisher?.publish(...)` — so a registrar that
 * stops passing it compiles, boots, and silently stops pushing
 * `coverage-changed` / `tests-changed`. The only symptom is a user whose
 * Coverage panel needs a manual refresh (the `cl_ws-driven-state` bug class).
 */
const workspaceEvents: WorkspaceEventPublisher = {
  publish: () => { /* nothing subscribes in this suite */ },
}

let tmpDir: string
let logsDir: string
let featuresDir: string
let registry: OrchestratorRegistry
let runStore: RunStore
let coverageJobStore: CoverageJobRunStore
let flightStore: FlightRunStore
let dirtySpecStore: DirtySpecStore
let brokers: Map<string, PaneBroker>
let attached: Array<{ runId: string; feature: string; backups: unknown }>
let runs: RunsFeature
let app: FastifyInstance

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-coverage-reg-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
  registry = createRegistry()
  runStore = new RunStore(logsDir, registry)
  coverageJobStore = new CoverageJobRunStore(logsDir)
  flightStore = new FlightRunStore(logsDir)
  dirtySpecStore = new DirtySpecStore(logsDir)
  brokers = new Map()
  attached = []
  orchHarness.constructFails = false
  orchHarness.stopFails = false
  orchHarness.options = []
  orchHarness.stops = []
  orchHarness.settle = null
  orchHarness.reject = null
  // The real attachRunStreams registers the run's broker when none exists, and
  // that is the invariant behind the non-null `brokers.get(runId)!` on the very
  // next line of the code under test — a stub that skipped it would make every
  // verification throw.
  runs = {
    attachRunStreams: (orch: { runId: string }, _log: unknown, feature: string, backups: unknown) => {
      attached.push({ runId: orch.runId, feature, backups })
      brokers.set(orch.runId, brokers.get(orch.runId) ?? new PaneBroker())
      registry.set(orch.runId, orch as unknown as OrchestratorLike)
    },
    scheduler: { fits: () => ({ ok: true }) },
    restartExternalRun: () => Promise.reject(new Error('unused by coverage')),
  } as unknown as RunsFeature
  app = Fastify()
})

afterEach(async () => {
  await app.close()
})

function makeCtx(): ServerContext {
  return {
    projectRoot: tmpDir,
    featuresDir,
    logsDir,
    registry,
    runStore,
    coverageJobStore,
    flightStore,
    dirtySpecStore,
    workspaceEvents,
    brokers,
    ptyFactory: inertPtyFactory,
  } as unknown as ServerContext
}

interface Registration {
  plugin: unknown
  opts: Record<string, unknown>
}

type StartVerification = (
  featureName: string,
  input: ResolveVerificationInput,
  options?: { cleanupBootRunId: string },
) => Promise<{ runId: string }>

async function registerFeature(): Promise<{
  registrations: Registration[]
  startVerification: StartVerification
}> {
  const spy = vi.spyOn(app, 'register')
  await register(app, makeCtx(), runs)
  const registrations = spy.mock.calls.map((call) => ({
    plugin: call[0] as unknown,
    opts: (call[1] ?? {}) as Record<string, unknown>,
  }))
  spy.mockRestore()
  return {
    registrations,
    startVerification: registrations[1].opts.startVerification as StartVerification,
  }
}

/** What the `staging` envset writes over the target file, including the deployed
 *  URL the verification is supposed to point Playwright at. */
const ENVSET_ENV = 'APPLIED=1\nWEB_URL=https://envset.example.com\n'

/** A real on-disk suite config — `loadFeatures` requires and re-reads it. */
function writeFeature(name: string, cfg: Record<string, unknown> = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['staging'], featureDir: __dirname, ...${JSON.stringify(cfg)} } }`,
  )
  return dir
}

/** A complete envset tree: a config naming a slot, a target file that already
 *  exists (nothing to back up otherwise), and a set directory to copy from.
 *  Anything less and `applyFeatureEnvset` returns null — a different arm. */
function writeEnvset(featureDir: string, setName: string, rawConfig?: string): string {
  const envsetsDir = path.join(featureDir, 'envsets')
  const target = path.join(tmpDir, 'app', '.env')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'ORIGINAL=1\n')
  fs.mkdirSync(path.join(envsetsDir, setName), { recursive: true })
  // The `WEB_URL` line is load-bearing, not decoration: it is what makes the
  // envset's deployed target discoverable, so `resolveVerificationRun` infers
  // `envVar: WEB_URL` for the `web` repo and produces a NON-EMPTY
  // `playwrightEnv`. With a URL-less envset the resolved env is `{}`, and an
  // assertion that the target reached the orchestrator could not fail.
  fs.writeFileSync(path.join(envsetsDir, setName, '.env'), ENVSET_ENV)
  fs.writeFileSync(
    path.join(envsetsDir, 'envsets.config.json'),
    rawConfig ?? JSON.stringify({
      appRoots: {},
      slots: { '.env': { description: 'app env', target } },
      feature: { slots: ['.env'], testCommand: 'true', testCwd: tmpDir },
    }),
  )
  return target
}

function runnerLogText(runId: string): string {
  return fs.readFileSync(buildRunPaths(runDirFor(logsDir, runId)).runnerLogPath, 'utf-8')
}

/** A record in the context's coverage-job store, so a route read proves which
 *  instance is actually behind the mounted plugin. */
function seedCoverageJob(jobId: string, feature: string): void {
  coverageJobStore.save({
    jobId,
    feature,
    kind: 'coverage',
    status: 'done',
    startedAt: '2026-08-21T00:00:00.000Z',
    log: '',
  } satisfies CoverageJobManifest)
}

function seedManifest(runId: string, status: string): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(buildRunPaths(dir).manifestPath, {
    runId,
    feature: 'shop',
    startedAt: '2026-08-21T00:00:00.000Z',
    status,
    healCycles: 0,
    services: [],
  } as Parameters<typeof writeManifest>[1])
}

/** Poll rather than sleep: the promise chain settles on later microtasks. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i += 1) await new Promise((r) => setImmediate(r))
  expect(predicate()).toBe(true)
}

describe('coverage feature registrar', () => {
  it('mounts the coverage and verification surfaces over the shared stores', async () => {
    const { registrations } = await registerFeature()

    expect(registrations.map((r) => r.plugin)).toEqual([coverageRoutes, verificationRoutes])
    expect(registrations[0].opts).toMatchObject({ featuresDir, logsDir, projectRoot: tmpDir })
    // Store identity, not shape: `coverageJobStore` and `flightStore` are both
    // OPTIONAL on CoverageRouteDeps and the route falls back to its own
    // file-backed instance over the same logsDir — so an omission reads and
    // writes the same FILES while missing the event bridge attached to the
    // context's instance.
    expect(registrations[0].opts.coverageJobStore).toBe(coverageJobStore)
    expect(registrations[0].opts.flightStore).toBe(flightStore)
    expect(registrations[0].opts.workspaceEvents).toBe(workspaceEvents)
    expect(registrations[1].opts).toMatchObject({ featuresDir, store: runStore })
    expect(registrations[1].opts.startVerification).toBeTypeOf('function')
    expect(registrations[1].opts.workspaceEvents).toBe(workspaceEvents)

    // One live request per plugin, against a path each one really declares —
    // and the coverage read comes back off the CONTEXT's job store, so this
    // fails if the route were left to build its own.
    writeFeature('shop')
    seedCoverageJob('cj_1', 'shop')
    const jobs = await app.inject({ method: 'GET', url: '/api/coverage/jobs' })
    expect(jobs.statusCode).toBe(200)
    expect(jobs.json()).toMatchObject([{ jobId: 'cj_1', feature: 'shop' }])

    const configs = await app.inject({ method: 'GET', url: '/api/features/shop/verification-configs' })
    expect(configs.statusCode).toBe(200)
    expect(configs.json()).toEqual([])
  })
})

describe('startVerification — refusals', () => {
  it('404s a suite that is not in the workspace', async () => {
    const { startVerification } = await registerFeature()
    await expect(startVerification('ghost', {})).rejects.toMatchObject({
      message: 'feature not found: ghost',
      statusCode: 404,
    })
  })

  it('500s and starts nothing when the envset cannot be applied', async () => {
    const dir = writeFeature('shop')
    writeEnvset(dir, 'staging', '{ not json')
    const { startVerification } = await registerFeature()

    await expect(startVerification('shop', { playwrightEnvsetId: 'staging' }))
      .rejects.toMatchObject({ statusCode: 500 })
    expect(orchHarness.options).toEqual([])
    // The cause is persisted, not only thrown at the caller.
    const runId = fs.readdirSync(path.join(logsDir, 'runs'))[0]
    expect(runnerLogText(runId)).toContain('envset apply failed: ')
  })

  it('500s an orchestrator that fails to construct and puts the envset back', async () => {
    const dir = writeFeature('shop')
    const target = writeEnvset(dir, 'staging')
    orchHarness.constructFails = true
    const { startVerification } = await registerFeature()

    await expect(startVerification('shop', { playwrightEnvsetId: 'staging' }))
      .rejects.toMatchObject({ statusCode: 500 })
    // A refused verification leaves the workspace exactly as it found it.
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL=1\n')
    expect(attached).toEqual([])
  })

  it('500s an orchestrator that fails to construct with no envset to put back', async () => {
    writeFeature('shop')
    orchHarness.constructFails = true
    const { startVerification } = await registerFeature()

    await expect(startVerification('shop', { playwrightEnvsetId: 'staging' }))
      .rejects.toMatchObject({ statusCode: 500 })
    expect(attached).toEqual([])
  })
})

describe('startVerification — the run it builds', () => {
  it('runs observationally: no repos, no services, the Playwright envset applied', async () => {
    const dir = writeFeature('shop', { repos: [{ name: 'web', localPath: tmpDir }] })
    const target = writeEnvset(dir, 'staging')
    const { startVerification } = await registerFeature()

    const orch = await startVerification('shop', {
      playwrightEnvsetId: 'staging',
      targetUrls: { web: 'https://staging.example.com' },
    })

    expect(orchHarness.options[0]).toMatchObject({
      runId: orch.runId,
      env: 'staging',
      runDir: runDirFor(logsDir, orch.runId),
      executionType: 'verify',
      ptyFactory: inertPtyFactory,
      runStateSink: runStore,
      // WHERE the verification points is the entire point of a verify run, and
      // `playwrightEnv` is the only channel that carries it (run-playwright
      // spreads it into Playwright's process env). It is an OPTIONAL
      // orchestrator option, so dropping it compiles and silently re-points
      // every verification at the local defaults instead of the deployed
      // environment — the caller's `targetUrls` override beating the envset's
      // own URL is what proves the resolved value, not a default, arrived.
      playwrightEnv: { WEB_URL: 'https://staging.example.com' },
      // The record of what was verified: also optional, and stamped onto the
      // run manifest at bootstrap. Without it a green verification keeps no
      // evidence of which environment it was green against.
      verification: {
        playwrightEnvsetId: 'staging',
        targetUrls: { web: 'https://staging.example.com' },
        targets: [{ id: 'web', name: 'web', envVar: 'WEB_URL', url: 'https://staging.example.com' }],
      },
    })
    // The shared dirty-spec store, by identity — a verify run that recorded its
    // spec integrity against some other instance would report a clean suite the
    // rest of the server disagrees with.
    expect(orchHarness.options[0].dirtySpecHooks).toBe(dirtySpecStore)
    // The runner log the registrar just wrote its own two lines to. Absent, the
    // orchestrator stops teeing its lifecycle into runner.log.
    expect(orchHarness.options[0].runnerLog).toBeInstanceOf(RunnerLog)
    // Verification never boots local services, so the suite's repos are
    // deliberately stripped from the orchestrator's copy of the config.
    expect((orchHarness.options[0].feature as { repos: unknown[] }).repos).toEqual([])
    expect(fs.readFileSync(target, 'utf-8')).toBe(ENVSET_ENV)
    expect(attached).toEqual([{ runId: orch.runId, feature: 'shop', backups: attached[0].backups }])
    expect(attached[0].backups).toHaveLength(1)

    const log = runnerLogText(orch.runId)
    expect(log).toContain(`Verify started: feature=shop envset=staging runId=${orch.runId}`)
    expect(log).toContain('Verify is observational only')
    expect(log).toContain('Applied Playwright envset "staging" for verification')

    orchHarness.settle!('passed')
    await until(() => registry.get(orch.runId) === undefined)
  })

  it('starts a suite that has no envset to apply', async () => {
    writeFeature('shop')
    const { startVerification } = await registerFeature()

    const orch = await startVerification('shop', { playwrightEnvsetId: 'staging' })

    expect(attached).toEqual([{ runId: orch.runId, feature: 'shop', backups: null }])
    expect(runnerLogText(orch.runId)).not.toContain('Applied Playwright envset')

    orchHarness.settle!('passed')
    await until(() => registry.get(orch.runId) === undefined)
  })
})

describe('startVerification — settling', () => {
  it('stamps failure diagnostics onto the run when the verification fails', async () => {
    writeFeature('shop')
    const { startVerification } = await registerFeature()
    const orch = await startVerification('shop', { playwrightEnvsetId: 'staging' })
    // The orchestrator here is a fake, so the manifest the real one would have
    // written is staged directly — the diagnostics are read back off it.
    seedManifest(orch.runId, 'failed')
    fs.writeFileSync(path.join(runDirFor(logsDir, orch.runId), 'playwright.log'), '1 failed\n')

    orchHarness.settle!('failed')

    await until(() => Boolean(runStore.get(orch.runId)?.manifest.verification?.diagnostics))
    const verification = runStore.get(orch.runId)!.manifest.verification!
    expect(verification.playwrightEnvsetId).toBe('staging')
    expect(verification.diagnostics!.rawPlaywrightOutput).toContain('1 failed')
    expect(orchHarness.stops).toEqual(['failed'])
    await until(() => registry.get(orch.runId) === undefined)
  })

  it('still releases the run when a failed verification left no manifest to stamp', async () => {
    writeFeature('shop')
    const { startVerification } = await registerFeature()
    const orch = await startVerification('shop', { playwrightEnvsetId: 'staging' })

    // No manifest on disk: the orchestrator died before bootstrapping one. The
    // release must not depend on a record that isn't there.
    orchHarness.settle!('failed')

    await until(() => registry.get(orch.runId) === undefined)
    expect(runStore.get(orch.runId)).toBeNull()
  })

  it('leaves a passing run\'s manifest untouched', async () => {
    writeFeature('shop')
    const { startVerification } = await registerFeature()
    const orch = await startVerification('shop', { playwrightEnvsetId: 'staging' })
    seedManifest(orch.runId, 'passed')

    orchHarness.settle!('passed')

    await until(() => registry.get(orch.runId) === undefined)
    // Diagnostics exist to explain a failure; a green verification gets none.
    expect(runStore.get(orch.runId)!.manifest.verification).toBeUndefined()
    expect(orchHarness.stops).toEqual(['passed'])
  })

  it('reports a thrown verification on the Playwright pane and aborts the run', async () => {
    writeFeature('shop')
    const { startVerification } = await registerFeature()
    const orch = await startVerification('shop', { playwrightEnvsetId: 'staging' })

    orchHarness.reject!(new Error('target url unreachable'))

    await until(() => registry.get(orch.runId) === undefined)
    expect(brokers.get(orch.runId)!.snapshot('playwright'))
      .toContain('[verification error] Error: target url unreachable')
    expect(orchHarness.stops).toEqual(['aborted'])
  })

  it('releases the run even when stopping it fails, on both the settled and the thrown path', async () => {
    writeFeature('shop')
    const { startVerification } = await registerFeature()
    orchHarness.stopFails = true

    const passing = await startVerification('shop', { playwrightEnvsetId: 'staging' })
    orchHarness.settle!('passed')
    // A teardown that cannot finish is not a reason to leak the run: the
    // registry entry is what makes the UI believe a verification is still live.
    await until(() => registry.get(passing.runId) === undefined)

    const thrown = await startVerification('shop', { playwrightEnvsetId: 'staging' })
    orchHarness.reject!(new Error('target url unreachable'))
    await until(() => registry.get(thrown.runId) === undefined)
  })

  it('tears down the boot session that was held open for it', async () => {
    writeFeature('shop')
    const { startVerification } = await registerFeature()
    seedManifest('boot-1', 'running')

    const orch = await startVerification(
      'shop',
      { playwrightEnvsetId: 'staging' },
      { cleanupBootRunId: 'boot-1' },
    )
    orchHarness.settle!('passed')

    // The boot run holds the services the verification pointed at, so it only
    // ends once the verification has.
    await until(() => runStore.get('boot-1')?.manifest.status === 'aborted')
    await until(() => registry.get(orch.runId) === undefined)
  })

  it('does not let a boot-session teardown failure escape the verification', async () => {
    writeFeature('shop')
    const { startVerification } = await registerFeature()
    seedManifest('boot-1', 'running')
    // Aborting writes the boot run's terminal manifest, so a read-only record
    // directory (a logs volume that went read-only, a permission change under
    // a live server) makes that write fail. Left unhandled it would surface as
    // an unhandled rejection out of a chain nobody awaits — which is what this
    // test would catch.
    const bootDir = runDirFor(logsDir, 'boot-1')
    fs.chmodSync(bootDir, 0o500)
    try {
      const orch = await startVerification(
        'shop',
        { playwrightEnvsetId: 'staging' },
        { cleanupBootRunId: 'boot-1' },
      )
      orchHarness.settle!('passed')

      await until(() => registry.get(orch.runId) === undefined)
      // The failed teardown is swallowed, so the boot row keeps claiming active
      // — a stale row the next boot reconcile repairs, not a crashed process.
      expect(runStore.get('boot-1')!.manifest.status).toBe('running')
    } finally {
      fs.chmodSync(bootDir, 0o700)
    }
  })
})
