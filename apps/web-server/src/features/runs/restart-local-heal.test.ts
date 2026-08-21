import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PaneBroker } from './logic/pane-broker'
import { RunStore, createRegistry, type OrchestratorRegistry } from './logic/run-store'
import { buildRunPaths, runDirFor } from './logic/runtime/run-paths'
import { writeManifest, type RunManifest } from './logic/runtime/manifest'
import { MODE_COPY } from './logic/runtime/auto-heal'
import type { BackupRecord } from './logic/runtime/env-switcher/types'
import type { PtyFactory } from './logic/runtime/pty-spawner'
import type { ServerContext } from '../../server-context'
import type { makeAttachRunStreams } from './run-stream-wiring'
import { makeRestartLocalHeal } from './restart-local-heal'

// `pickAvailableHealAgent` shells out to look for `claude` / `codex` on PATH,
// which is the one edge a unit test can't reproduce. Everything ELSE in
// auto-heal stays real — the spawn-command builder and the heal-prompt renderer
// are exactly what this module is responsible for wiring, and faking them would
// prove only that the fakes were called.
const probe = vi.hoisted(() => ({
  answer: 'claude' as 'claude' | 'codex' | null,
  asked: [] as (string | undefined)[],
}))

vi.mock('./logic/runtime/auto-heal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logic/runtime/auto-heal')>()),
  pickAvailableHealAgent: (requested?: string) => {
    probe.asked.push(requested)
    return probe.answer
  },
}))

interface FakeOrchestrator {
  runId: string
  opts: Record<string, never>
}

// A real RunOrchestrator boots services and drives a live agent REPL. The fake
// keeps the options object it was handed, because that object IS the contract
// this module owns, and it lets each test decide when the heal promise settles.
// `collectPortSlots` is re-exported from this module and used by
// run-primitives, so the actual module is spread back in rather than replaced.
const fakeOrch = vi.hoisted(() => ({
  built: [] as { runId: string; opts: Record<string, never> }[],
  failWith: null as string | null,
  guidance: [] as string[],
  stops: [] as (string | undefined)[],
  heal: (async () => 'failed') as (text: string) => Promise<string>,
}))

vi.mock('./logic/runtime/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logic/runtime/orchestrator')>()
  class FakeRunOrchestrator {
    readonly runId: string

    constructor(readonly opts: Record<string, never>) {
      if (fakeOrch.failWith) throw new Error(fakeOrch.failWith)
      this.runId = String((opts as unknown as { runId: string }).runId)
      fakeOrch.built.push(this)
    }

    restartHealFromFailure(text: string): Promise<string> {
      fakeOrch.guidance.push(text)
      return fakeOrch.heal(text)
    }

    async stop(status?: string): Promise<void> {
      fakeOrch.stops.push(status)
    }
  }
  return { ...actual, RunOrchestrator: FakeRunOrchestrator }
})

let tmpDir: string
let projectRoot: string
let featuresDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-restart-heal-')))
  projectRoot = path.join(tmpDir, 'project')
  featuresDir = path.join(projectRoot, 'features')
  logsDir = path.join(projectRoot, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  probe.answer = 'claude'
  probe.asked = []
  fakeOrch.built = []
  fakeOrch.failWith = null
  fakeOrch.guidance = []
  fakeOrch.stops = []
  fakeOrch.heal = async () => 'failed'
})

interface FeatureSpec {
  envs?: string[]
  repos?: { name: string; localPath: string; branch?: string }[]
}

/** Real on-disk feature config — `loadFeatures` requires and re-reads it. */
function writeFeature(name: string, spec: FeatureSpec = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  const config = { name, description: 'd', ...spec }
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { ...${JSON.stringify(config)}, featureDir: __dirname } }`,
  )
  return dir
}

function seedRun(runId: string, patch: Partial<RunManifest> = {}): string {
  const runDir = runDirFor(logsDir, runId)
  fs.mkdirSync(runDir, { recursive: true })
  writeManifest(buildRunPaths(runDir).manifestPath, {
    runId,
    feature: 'demo',
    startedAt: '2026-08-21T00:00:00.000Z',
    status: 'failed',
    healCycles: 2,
    services: [],
    // Non-empty repoPaths is load-bearing: `detectHealMode` reads it off this
    // manifest and a run with no editable repos gets the `test` heal mode,
    // whose prompt copy deliberately differs from `service`.
    repoPaths: [path.join(tmpDir, 'app')],
    ...patch,
  })
  return runDir
}

function writeProjectConfig(healAgent: string): void {
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'canary-lab.config.json'), JSON.stringify({ healAgent }))
}

/**
 * A non-null `backups` needs the complete real envset shape: a config naming a
 * slot, a target file that already exists (nothing to back up otherwise), and
 * a set directory to copy from. Anything less and `applyFeatureEnvset` returns
 * null, which is a different branch of the code under test. Returns the target
 * path so a test can prove the revert actually put the original file back.
 */
function writeEnvset(featureDir: string, setName: string, rawConfig?: string): string {
  const envsetsDir = path.join(featureDir, 'envsets')
  const target = path.join(tmpDir, 'app', '.env')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'ORIGINAL=1\n')
  fs.mkdirSync(path.join(envsetsDir, setName), { recursive: true })
  fs.writeFileSync(path.join(envsetsDir, setName, '.env'), 'APPLIED=1\n')
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

interface AttachCall {
  orch: unknown
  runnerLogPath: string
  featureName: string
  backups: BackupRecord[] | null
}

interface Harness {
  restart: (runId: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  registry: OrchestratorRegistry
  runStore: RunStore
  brokers: Map<string, PaneBroker>
  attached: AttachCall[]
  ptyFactory: PtyFactory
  dirtySpecStore: unknown
}

function harness(): Harness {
  const registry = createRegistry()
  const runStore = new RunStore(logsDir, registry)
  const brokers = new Map<string, PaneBroker>()
  const attached: AttachCall[] = []
  // Not a stub returning a fake handle: this module only forwards the factory
  // to the orchestrator, so a CALL here means something tried to launch a real
  // agent REPL. Failing loudly is the assertion.
  const ptyFactory = (() => {
    throw new Error('no test may spawn a pty')
  }) as unknown as PtyFactory
  const dirtySpecStore = { marker: 'dirty-specs' }
  // Only the eight fields the module actually reads. The other four it
  // destructures (benchmarkStore, workspaceEvents, externalHealBroker,
  // activeEnvsets) are never referenced in its body, so leaving them absent
  // keeps the fixture honest about what this closure depends on.
  const ctx = {
    projectRoot, featuresDir, logsDir, registry, runStore, brokers, ptyFactory, dirtySpecStore,
  } as unknown as ServerContext
  const attachRunStreams = ((
    orch: { runId: string },
    runnerLog: { logPath: string },
    featureName: string,
    backups: BackupRecord[] | null,
  ) => {
    attached.push({ orch, runnerLogPath: runnerLog.logPath, featureName, backups })
    // Creating the broker when absent is load-bearing, not fixture padding:
    // the real attachRunStreams does exactly this, and it is the invariant
    // behind the non-null `brokers.get(runId)!` on the line after the call.
    // A stub that skipped it would make the restart throw on any run whose
    // pane nobody had opened yet.
    brokers.set(orch.runId, brokers.get(orch.runId) ?? new PaneBroker())
  }) as unknown as ReturnType<typeof makeAttachRunStreams>
  return {
    restart: makeRestartLocalHeal(ctx, attachRunStreams),
    registry, runStore, brokers, attached, ptyFactory, dirtySpecStore,
  }
}

function runnerLogText(runId: string): string {
  return fs.readFileSync(buildRunPaths(runDirFor(logsDir, runId)).runnerLogPath, 'utf-8')
}

describe('makeRestartLocalHeal — rejections', () => {
  it('reports run-not-found when no manifest exists on disk', async () => {
    const h = harness()

    expect(await h.restart('ghost', 'go')).toEqual({ ok: false, reason: 'run-not-found' })
    expect(fakeOrch.built).toHaveLength(0)
  })

  it('refuses a verification execution, which has no heal loop to restart', async () => {
    writeFeature('demo')
    seedRun('v1', { executionType: 'verify' })

    expect(await harness().restart('v1', 'go')).toEqual({ ok: false, reason: 'not-restartable' })
  })

  it('refuses a run whose status is neither failed nor aborted', async () => {
    writeFeature('demo')
    seedRun('p1', { status: 'passed' })

    expect(await harness().restart('p1', 'go')).toEqual({ ok: false, reason: 'not-restartable' })
  })

  it('refuses a run pinned to manual heal', async () => {
    writeFeature('demo')
    seedRun('m1', { healMode: 'manual' })

    expect(await harness().restart('m1', 'go')).toEqual({ ok: false, reason: 'manual-mode' })
  })

  it('refuses when the run names a feature that no longer exists', async () => {
    seedRun('f1', { feature: 'deleted-feature' })

    expect(await harness().restart('f1', 'go')).toEqual({ ok: false, reason: 'not-restartable' })
  })

  it('rejects and records the reason when the project config is set to manual', async () => {
    writeProjectConfig('manual')
    writeFeature('demo')
    seedRun('c1')

    expect(await harness().restart('c1', 'go')).toEqual({ ok: false, reason: 'manual-mode' })
    expect(runnerLogText('c1')).toContain('project config is set to "manual"')
    // Probing PATH would be wrong, not merely wasteful: a manual project has
    // decided the heal is the user's job, so no local agent may be selected.
    expect(probe.asked).toEqual([])
  })

  it('reports spawn-failed and records that no CLI is installed', async () => {
    writeProjectConfig('auto')
    writeFeature('demo')
    seedRun('a1')
    probe.answer = null

    expect(await harness().restart('a1', 'go')).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(runnerLogText('a1')).toContain('no `claude` or `codex` CLI on PATH')
    expect(fakeOrch.built).toHaveLength(0)
  })

  it('reports spawn-failed when the envset cannot be applied', async () => {
    writeProjectConfig('auto')
    const featureDir = writeFeature('demo', { envs: ['local'] })
    writeEnvset(featureDir, 'local', '{ not json')
    seedRun('e1', { env: 'local' })

    expect(await harness().restart('e1', 'go')).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(runnerLogText('e1')).toContain('envset apply failed')
    expect(fakeOrch.built).toHaveLength(0)
  })

  it('refuses when a configured repo is not on its pinned branch', async () => {
    writeProjectConfig('auto')
    writeFeature('demo', {
      repos: [{ name: 'app', localPath: path.join(tmpDir, 'not-a-repo'), branch: 'main' }],
    })
    seedRun('b1')

    expect(await harness().restart('b1', 'go')).toEqual({ ok: false, reason: 'not-restartable' })
    expect(runnerLogText('b1')).toContain('Heal restart rejected: Repo branch check failed')
    expect(fakeOrch.built).toHaveLength(0)
  })

  it('reverts the applied envset when the repo-branch check refuses the restart', async () => {
    writeProjectConfig('auto')
    const featureDir = writeFeature('demo', {
      envs: ['local'],
      repos: [{ name: 'app', localPath: path.join(tmpDir, 'not-a-repo'), branch: 'main' }],
    })
    const target = writeEnvset(featureDir, 'local')
    seedRun('b2', { env: 'local' })

    expect(await harness().restart('b2', 'go')).toEqual({ ok: false, reason: 'not-restartable' })
    // A rejected restart must leave the workspace exactly as it found it —
    // otherwise the next run inherits this run's env files.
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL=1\n')
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.includes('.bak.'))).toEqual([])
  })

  it('reports spawn-failed when the orchestrator cannot be constructed', async () => {
    writeProjectConfig('auto')
    writeFeature('demo')
    seedRun('o1')
    fakeOrch.failWith = 'pty binding unavailable'

    const h = harness()

    expect(await h.restart('o1', 'go')).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(runnerLogText('o1')).toContain('Heal restart failed: pty binding unavailable')
    expect(h.registry.get('o1')).toBeUndefined()
    expect(h.attached).toEqual([])
  })

  it('reverts the applied envset when the orchestrator cannot be constructed', async () => {
    writeProjectConfig('auto')
    const featureDir = writeFeature('demo', { envs: ['local'] })
    const target = writeEnvset(featureDir, 'local')
    seedRun('o2', { env: 'local' })
    fakeOrch.failWith = 'pty binding unavailable'

    expect(await harness().restart('o2', 'go')).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL=1\n')
  })
})

describe('makeRestartLocalHeal — envset selection', () => {
  it('defaults a legacy run with no persisted env to the feature\'s first envset', async () => {
    writeProjectConfig('auto')
    const featureDir = writeFeature('demo', { envs: ['local', 'staging'] })
    const target = writeEnvset(featureDir, 'local')
    seedRun('n1')

    const h = harness()

    expect(await h.restart('n1', 'go')).toEqual({ ok: true })
    const log = runnerLogText('n1')
    expect(log).toContain('legacy run without persisted env; defaulting to "local"')
    expect(log).toContain('Applied envset "local" for restarted heal demo')
    expect(fs.readFileSync(target, 'utf-8')).toBe('APPLIED=1\n')
    // The backups travel to attachRunStreams, which owns reverting them when
    // the run completes — a restart that swallowed them would leak the envset.
    expect(h.attached[0].backups).toEqual([
      { originalPath: target, backupPath: expect.stringContaining(`${target}.bak.`) },
    ])
  })

  it('applies no envset when neither the run nor the feature names one', async () => {
    writeProjectConfig('auto')
    writeFeature('demo')
    seedRun('n2')

    const h = harness()

    expect(await h.restart('n2', 'go')).toEqual({ ok: true })
    expect(h.attached[0].backups).toBeNull()
    const log = runnerLogText('n2')
    expect(log).not.toContain('defaulting to')
    expect(log).not.toContain('Applied envset')
  })

  it('leaves backups null when the named env has no envsets config to apply', async () => {
    writeProjectConfig('auto')
    writeFeature('demo', { envs: ['local'] })
    seedRun('n3', { env: 'local' })

    const h = harness()

    expect(await h.restart('n3', 'go')).toEqual({ ok: true })
    expect(h.attached[0].backups).toBeNull()
    expect(runnerLogText('n3')).not.toContain('Applied envset')
  })
})

describe('makeRestartLocalHeal — success', () => {
  it('registers the fresh orchestrator, clears the dead pane and attaches the streams', async () => {
    writeProjectConfig('claude')
    writeFeature('demo', { envs: ['local'] })
    const runDir = seedRun('s1', { env: 'local', healCycles: 3 })
    const h = harness()
    const broker = new PaneBroker()
    broker.push('agent', 'transcript of the agent that already died')
    h.brokers.set('s1', broker)
    let settle: (status: string) => void = () => {}
    fakeOrch.heal = () => new Promise<string>((resolve) => { settle = resolve })

    expect(await h.restart('s1', 'check the login redirect')).toEqual({ ok: true })

    expect(fakeOrch.built).toHaveLength(1)
    const built = fakeOrch.built[0] as unknown as FakeOrchestrator
    // Registered while the heal is still in flight — that registration is what
    // makes pause/cancel/agent-input reach the NEW agent.
    expect(h.registry.get('s1')).toBe(built)
    // resetPane wiped the dead agent's transcript, so the banner is the only
    // thing a client attaching now replays.
    expect(broker.snapshot('agent')).toBe('\n[orchestrator] Restarting heal with claude...\n')
    expect(fakeOrch.guidance).toEqual(['check the login redirect'])

    const opts = built.opts as unknown as Record<string, unknown>
    expect(opts.runId).toBe('s1')
    expect(opts.runDir).toBe(runDir)
    expect(opts.env).toBe('local')
    expect((opts.feature as { name: string }).name).toBe('demo')
    expect(opts.ptyFactory).toBe(h.ptyFactory)
    expect(opts.repoBranchSnapshots).toEqual([])
    // The restarted agent continues the cycle count instead of resetting it,
    // so the cap that stops a runaway heal loop still applies.
    expect(opts.initialHealCycles).toBe(3)
    expect(opts.runStateSink).toBe(h.runStore)
    expect(opts.dirtySpecHooks).toBe(h.dirtySpecStore)
    expect((opts.autoHeal as { agent: string }).agent).toBe('claude')

    expect(h.attached).toHaveLength(1)
    expect(h.attached[0].orch).toBe(built)
    expect(h.attached[0].featureName).toBe('demo')
    expect(h.attached[0].backups).toBeNull()
    expect(h.attached[0].runnerLogPath).toBe(buildRunPaths(runDir).runnerLogPath)

    settle('failed')
    await vi.waitFor(() => {
      expect(fakeOrch.stops).toEqual(['failed'])
      expect(h.registry.get('s1')).toBeUndefined()
    })
  })

  it('keeps a run healing on its persisted agent over a project config set to manual', async () => {
    writeProjectConfig('manual')
    writeFeature('demo')
    seedRun('s2', { healAgent: 'codex' })
    probe.answer = 'codex'

    const h = harness()

    expect(await h.restart('s2', 'go')).toEqual({ ok: true })
    // The persisted choice both skips the manual gate and is the only agent
    // whose availability gets probed.
    expect(probe.asked).toEqual(['codex'])
    const opts = (fakeOrch.built[0] as unknown as FakeOrchestrator).opts as unknown as Record<string, unknown>
    expect((opts.autoHeal as { agent: string }).agent).toBe('codex')
  })

  it('hands the restarted agent a run-scoped spawn command and a fix-the-app prompt', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    const runDir = seedRun('s3')
    const h = harness()

    expect(await h.restart('s3', 'the checkout total is wrong')).toEqual({ ok: true })

    const opts = (fakeOrch.built[0] as unknown as FakeOrchestrator).opts as unknown as Record<string, unknown>
    const autoHeal = opts.autoHeal as {
      buildSpawnCommand: (args: { mcpOutputDir: string }) => string
      buildCyclePrompt: (args: { cycle: number; outputDir: string; userGuidance: string }) => string
    }
    const paths = buildRunPaths(runDir)
    expect(autoHeal.buildSpawnCommand({ mcpOutputDir: paths.failedDir }))
      .toContain(path.join(runDir, 'mcp-config.json'))

    const prompt = autoHeal.buildCyclePrompt({
      cycle: 0, outputDir: paths.failedDir, userGuidance: 'the checkout total is wrong',
    })
    // The repair rule is the product's core guarantee, and a RESTARTED heal is
    // the easiest place for it to go missing: this run has editable repos, so
    // the fresh agent must still be told to fix the app rather than the test.
    expect(prompt).toContain(MODE_COPY.service.healingDirective)
    expect(prompt).not.toContain(MODE_COPY.test.healingDirective)
    expect(prompt).toContain('the checkout total is wrong')
  })
})
