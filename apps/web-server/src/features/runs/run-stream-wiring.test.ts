import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRegistry, RunStore, type OrchestratorRegistry } from './logic/run-store'
import { DirtySpecStore } from './logic/dirty-specs/store'
import { PaneBroker, type PaneMessage } from './logic/pane-broker'
import { writeManifest, type RunManifest } from './logic/runtime/manifest'
import { runDirFor, buildRunPaths } from './logic/runtime/run-paths'
import { RunnerLog } from './logic/runtime/runner-log'
import type { PtyFactory } from './logic/runtime/pty-spawner'
import type { BackupRecord } from './logic/runtime/env-switcher/types'
import type { RunOrchestrator } from './logic/runtime/orchestrator'
import { makeAttachRunStreams, makeRestartExternalRun } from './run-stream-wiring'
import type { ServerContext } from '../../server-context'
import type { ClientKind } from '../../../../../shared/run-mode'

/**
 * The orchestrator is this module's process-spawning edge: constructing one is
 * harmless, but `restartTerminalRun` boots every service, launches Playwright
 * and spawns a heal-agent PTY. Its own behaviour is covered by the two dozen
 * `orchestrator.*.test.ts` suites beside it, so here it is a fake — which is
 * also the only way to drive the construction-failure arm, since the real
 * constructor is pure bookkeeping and has no input that makes it throw.
 * `importOriginal` keeps the module's other exports real: `run-primitives`
 * imports `collectPortSlots` from this same module id.
 */
const orchHarness = vi.hoisted(() => ({
  constructFails: false,
  options: [] as Array<Record<string, unknown>>,
  instances: [] as unknown[],
  restart: (_guidance?: string): Promise<string> => Promise.resolve('passed'),
}))

vi.mock('./logic/runtime/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logic/runtime/orchestrator')>()
  const { EventEmitter: Emitter } = await import('events')
  class FakeRunOrchestrator extends Emitter {
    readonly runId: string
    constructor(opts: Record<string, unknown>) {
      super()
      if (orchHarness.constructFails) throw new Error('posix_spawnp failed')
      this.runId = opts.runId as string
      orchHarness.options.push(opts)
      orchHarness.instances.push(this)
    }

    restartTerminalRun(guidance?: string): Promise<string> {
      return orchHarness.restart(guidance)
    }

    stop(): Promise<void> {
      return Promise.resolve()
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

let tmpDir: string
let logsDir: string
let featuresDir: string
let registry: OrchestratorRegistry
let runStore: RunStore
let brokers: Map<string, PaneBroker>
let activeEnvsets: Map<string, BackupRecord[]>
let claims: Array<{ runId: string; input: Record<string, unknown> }>

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-streamwire-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
  registry = createRegistry()
  runStore = new RunStore(logsDir, registry)
  brokers = new Map()
  activeEnvsets = new Map()
  claims = []
  orchHarness.constructFails = false
  orchHarness.options = []
  orchHarness.instances = []
  orchHarness.restart = () => Promise.resolve('passed')
})

/**
 * Both factories destructure the whole `ServerContext`, but between them read
 * only these members. The rest is process-lifetime state owned by other
 * features, so the fixture builds what this module can observe and casts away
 * the remainder rather than constructing nine unrelated stores.
 */
function makeCtx(): ServerContext {
  return {
    projectRoot: tmpDir,
    featuresDir,
    logsDir,
    registry,
    runStore,
    dirtySpecStore: new DirtySpecStore(logsDir),
    workspaceEvents: { publish: () => { /* unused by this module */ } },
    // A recording stand-in: the claim's observable consequence here is that the
    // broker was handed exactly this client identity. What the real broker then
    // does with it is `external-heal-broker.test.ts`'s subject.
    externalHealBroker: {
      claim: (runId: string, input: Record<string, unknown>) => { claims.push({ runId, input }) },
    },
    brokers,
    activeEnvsets,
    ptyFactory: inertPtyFactory,
  } as unknown as ServerContext
}

/** A bare emitter is all `attachRunStreams` needs — it only subscribes. */
function fakeOrch(runId: string): EventEmitter & { asOrch: RunOrchestrator } {
  const emitter = new EventEmitter() as EventEmitter & { runId: string; asOrch: RunOrchestrator }
  emitter.runId = runId
  emitter.asOrch = emitter as unknown as RunOrchestrator
  return emitter
}

function newRunnerLog(runId: string): RunnerLog {
  return new RunnerLog(buildRunPaths(runDirFor(logsDir, runId)).runnerLogPath)
}

function readRunnerLog(runId: string): string {
  return fs.readFileSync(buildRunPaths(runDirFor(logsDir, runId)).runnerLogPath, 'utf-8')
}

/** Replay a pane through a throwaway subscriber: buffered bytes as one data
 *  message, then the exit message when the pane has exited. */
function replay(broker: PaneBroker, pane: string): PaneMessage[] {
  const seen: PaneMessage[] = []
  broker.subscribe(pane, { send: (m) => seen.push(m), close: () => { /* noop */ } })
  return seen
}

function writeFeature(name: string, cfg: Record<string, unknown> = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: [], featureDir: __dirname, ...${JSON.stringify(cfg)} } }`,
  )
  return dir
}

/** An envsets tree whose `<set>/.env` overwrites `targetPath`. The target must
 *  already exist, or `backup` records nothing and there is nothing to revert. */
function writeEnvsets(featureDir: string, setName: string, targetPath: string, content: string): void {
  const envsetsDir = path.join(featureDir, 'envsets')
  fs.mkdirSync(path.join(envsetsDir, setName), { recursive: true })
  fs.writeFileSync(path.join(envsetsDir, 'envsets.config.json'), JSON.stringify({
    appRoots: {},
    slots: { '.env': { description: 'app env', target: targetPath } },
    feature: { slots: ['.env'], testCommand: 'noop', testCwd: path.dirname(targetPath) },
  }))
  fs.writeFileSync(path.join(envsetsDir, setName, '.env'), content)
}

function writeRunManifest(over: Partial<RunManifest> & { runId: string }): void {
  const dir = runDirFor(logsDir, over.runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), {
    feature: 'foo',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'failed',
    healCycles: 0,
    services: [],
    ...over,
  })
}

function healReq(over: Partial<{
  sessionId: string
  clientKind: ClientKind
  clientVersion: string
  conversationName: string
  claimable: boolean
}> = {}) {
  return { kind: 'external' as const, sessionId: 's-1', clientKind: 'claude-desktop' as ClientKind, ...over }
}

/** Poll rather than sleep: the settle promise resolves on a later microtask. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((r) => setImmediate(r))
  expect(predicate()).toBe(true)
}

describe('makeAttachRunStreams — pane fan-out', () => {
  it('routes service, playwright and agent output into the run\'s existing broker', () => {
    const broker = new PaneBroker()
    brokers.set('r-1', broker)
    const orch = fakeOrch('r-1')
    makeAttachRunStreams(makeCtx())(orch.asOrch, newRunnerLog('r-1'), 'foo', null)

    // A restarted pty resets the pane first, so a chunk from the previous
    // attempt must not survive into the new transcript.
    orch.emit('service-output', { service: { safeName: 'api' }, chunk: 'stale\n' })
    orch.emit('service-started', { service: { safeName: 'api' } })
    expect(broker.snapshot('service:api')).toBe('')

    orch.emit('service-output', { service: { safeName: 'api' }, chunk: 'listening\n' })
    orch.emit('service-exit', { service: { safeName: 'api' }, exitCode: 3 })
    expect(replay(broker, 'service:api')).toEqual([
      { type: 'data', chunk: 'listening\n' },
      { type: 'exit', code: 3 },
    ])

    orch.emit('playwright-output', { chunk: 'stale\n' })
    orch.emit('playwright-started', {})
    orch.emit('playwright-output', { chunk: '1 failed\n' })
    orch.emit('playwright-exit', { exitCode: 1 })
    expect(replay(broker, 'playwright')).toEqual([
      { type: 'data', chunk: '1 failed\n' },
      { type: 'exit', code: 1 },
    ])

    orch.emit('agent-output', { chunk: 'stale\n' })
    orch.emit('agent-started', { redirect: false })
    orch.emit('agent-output', { chunk: 'fixing\n' })
    orch.emit('agent-exit', { exitCode: 0 })
    expect(replay(broker, 'agent')).toEqual([
      { type: 'data', chunk: 'fixing\n' },
      { type: 'exit', code: 0 },
    ])

    // The broker already registered for this run is reused, not replaced.
    expect(brokers.get('r-1')).toBe(broker)
  })

  it('keeps the agent transcript when the agent output is a redirect into an existing pane', () => {
    const orch = fakeOrch('r-1')
    makeAttachRunStreams(makeCtx())(orch.asOrch, newRunnerLog('r-1'), 'foo', null)
    // No broker was registered for this run, so attaching created one.
    const broker = brokers.get('r-1')!
    expect(broker).toBeInstanceOf(PaneBroker)

    orch.emit('agent-output', { chunk: 'cycle 1\n' })
    orch.emit('agent-started', { redirect: true })
    expect(broker.snapshot('agent')).toBe('cycle 1\n')
  })

  it('holds no envset state for a run that applied none', () => {
    const orch = fakeOrch('r-1')
    makeAttachRunStreams(makeCtx())(orch.asOrch, newRunnerLog('r-1'), 'foo', null)
    orch.emit('run-complete', { status: 'passed' })
    expect(activeEnvsets.size).toBe(0)
    expect(readRunnerLog('r-1')).toBe('')
  })
})

describe('makeAttachRunStreams — envset revert on run-complete', () => {
  function stageEnvsetBackup(): { original: string; backup: string } {
    const original = path.join(tmpDir, 'app', '.env')
    fs.mkdirSync(path.dirname(original), { recursive: true })
    fs.writeFileSync(original, 'ORIGINAL\n')
    const backup = `${original}.bak.1`
    fs.writeFileSync(backup, 'ORIGINAL\n')
    fs.writeFileSync(original, 'FROM SET\n')
    return { original, backup }
  }

  it('reverts the applied envset and records it once the run completes', () => {
    const { original, backup } = stageEnvsetBackup()
    const orch = fakeOrch('r-1')
    makeAttachRunStreams(makeCtx())(orch.asOrch, newRunnerLog('r-1'), 'foo', [
      { originalPath: original, backupPath: backup },
    ])
    expect(activeEnvsets.get('r-1')).toHaveLength(1)

    orch.emit('run-complete', { status: 'passed' })

    expect(fs.readFileSync(original, 'utf-8')).toBe('ORIGINAL\n')
    expect(fs.existsSync(backup)).toBe(false)
    expect(activeEnvsets.has('r-1')).toBe(false)
    expect(readRunnerLog('r-1')).toContain('Reverted envset for foo')
  })

  it('warns and still drops the records when the revert cannot be written', () => {
    const backup = path.join(tmpDir, 'orphan.env.bak.1')
    fs.writeFileSync(backup, 'ORIGINAL\n')
    const orch = fakeOrch('r-1')
    // The original's parent directory is gone (the repo was moved or deleted
    // mid-run), so the copy back throws.
    makeAttachRunStreams(makeCtx())(orch.asOrch, newRunnerLog('r-1'), 'foo', [
      { originalPath: path.join(tmpDir, 'vanished', '.env'), backupPath: backup },
    ])

    orch.emit('run-complete', { status: 'failed' })

    expect(activeEnvsets.has('r-1')).toBe(false)
    expect(readRunnerLog('r-1')).toContain('envset revert failed: ')
  })

  it('does not revert twice when process shutdown already reverted the run', () => {
    const { original, backup } = stageEnvsetBackup()
    const orch = fakeOrch('r-1')
    makeAttachRunStreams(makeCtx())(orch.asOrch, newRunnerLog('r-1'), 'foo', [
      { originalPath: original, backupPath: backup },
    ])
    // `revertAllEnvsets` (SIGINT/SIGTERM cleanup in server.ts) drains this map
    // itself, and the orchestrator's own run-complete can still land after it.
    activeEnvsets.delete('r-1')

    orch.emit('run-complete', { status: 'aborted' })

    expect(fs.readFileSync(original, 'utf-8')).toBe('FROM SET\n')
    expect(readRunnerLog('r-1')).toBe('')
  })
})

describe('makeRestartExternalRun — rejections', () => {
  function build() {
    const ctx = makeCtx()
    return makeRestartExternalRun(ctx, makeAttachRunStreams(ctx))
  }

  it('404s an unknown run', async () => {
    await expect(build()('ghost', healReq())).rejects.toMatchObject({
      message: 'run-not-found',
      statusCode: 404,
    })
  })

  it('409s a run that is still active', async () => {
    writeRunManifest({ runId: 'r-1', status: 'healing' })
    await expect(build()('r-1', healReq())).rejects.toMatchObject({
      message: 'not-restartable',
      statusCode: 409,
    })
  })

  it('404s when the run\'s feature is no longer in the workspace', async () => {
    writeRunManifest({ runId: 'r-1', feature: 'ghost' })
    await expect(build()('r-1', healReq())).rejects.toMatchObject({
      message: 'feature not found',
      statusCode: 404,
    })
  })

  it('500s and refuses to restart when the envset cannot be applied', async () => {
    const dir = writeFeature('foo', { envs: ['local'] })
    fs.mkdirSync(path.join(dir, 'envsets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'envsets', 'envsets.config.json'), '{ not json')
    writeRunManifest({ runId: 'r-1', env: 'local' })

    await expect(build()('r-1', healReq())).rejects.toMatchObject({ statusCode: 500 })
    expect(readRunnerLog('r-1')).toContain('envset apply failed: ')
    expect(orchHarness.options).toEqual([])
    expect(registry.get('r-1')).toBeUndefined()
  })

  it('409s a repo on the wrong branch and puts the envset back', async () => {
    const dir = writeFeature('foo', {
      envs: ['local'],
      repos: [{ name: 'r', localPath: path.join(tmpDir, 'no-such-repo'), branch: 'main' }],
    })
    const target = path.join(tmpDir, 'app', '.env')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'ORIGINAL\n')
    writeEnvsets(dir, 'local', target, 'FROM SET\n')
    writeRunManifest({ runId: 'r-1', env: 'local' })

    await expect(build()('r-1', healReq())).rejects.toMatchObject({ statusCode: 409 })
    // The rejected restart leaves the workspace exactly as it found it.
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL\n')
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.includes('.bak.'))).toEqual([])
    expect(readRunnerLog('r-1')).toContain('External restart rejected: ')
    expect(orchHarness.options).toEqual([])
  })

  it('409s a repo on the wrong branch with no envset to put back', async () => {
    writeFeature('foo', {
      repos: [{ name: 'r', localPath: path.join(tmpDir, 'no-such-repo'), branch: 'main' }],
    })
    writeRunManifest({ runId: 'r-1' })

    await expect(build()('r-1', healReq())).rejects.toMatchObject({ statusCode: 409 })
    expect(readRunnerLog('r-1')).toContain('External restart rejected: ')
  })

  it('500s an orchestrator that fails to construct and puts the envset back', async () => {
    const dir = writeFeature('foo', { envs: ['local'] })
    const target = path.join(tmpDir, 'app', '.env')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'ORIGINAL\n')
    writeEnvsets(dir, 'local', target, 'FROM SET\n')
    writeRunManifest({ runId: 'r-1', env: 'local' })
    orchHarness.constructFails = true

    await expect(build()('r-1', healReq())).rejects.toMatchObject({ statusCode: 500 })
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL\n')
    expect(readRunnerLog('r-1')).toContain('External restart failed: ')
    expect(registry.get('r-1')).toBeUndefined()
    expect(claims).toEqual([])
  })

  it('500s an orchestrator that fails to construct with no envset to put back', async () => {
    writeFeature('foo')
    writeRunManifest({ runId: 'r-1' })
    orchHarness.constructFails = true

    await expect(build()('r-1', healReq())).rejects.toMatchObject({ statusCode: 500 })
    expect(readRunnerLog('r-1')).toContain('External restart failed: ')
  })
})

describe('makeRestartExternalRun — restart', () => {
  function build() {
    const ctx = makeCtx()
    return makeRestartExternalRun(ctx, makeAttachRunStreams(ctx))
  }

  it('rebuilds the orchestrator in external mode, claims the session and drives it', async () => {
    const dir = writeFeature('foo', { envs: ['local'] })
    const target = path.join(tmpDir, 'app', '.env')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'ORIGINAL\n')
    writeEnvsets(dir, 'local', target, 'FROM SET\n')
    writeRunManifest({ runId: 'r-1', env: 'local', healCycles: 2, status: 'aborted' })
    const restartCalls: Array<string | undefined> = []
    orchHarness.restart = (guidance) => { restartCalls.push(guidance); return Promise.resolve('passed') }

    const orch = await build()('r-1', healReq({
      clientVersion: '1.4.0',
      conversationName: 'repair chat',
      claimable: true,
    }), 'the checkout total is wrong')

    expect(orch).toBe(orchHarness.instances[0])
    expect(orchHarness.options[0]).toMatchObject({
      runId: 'r-1',
      env: 'local',
      runDir: runDirFor(logsDir, 'r-1'),
      externalHeal: true,
      initialHealCycles: 2,
      repoBranchSnapshots: [],
      externalHealSession: {
        sessionId: 's-1',
        clientKind: 'claude-desktop',
        clientVersion: '1.4.0',
        conversationName: 'repair chat',
        status: 'connected',
        cycleCount: 0,
      },
    })
    // The run's own state sink must be the shared store, or the restarted run's
    // manifest writes would never reach the UI.
    expect(orchHarness.options[0].runStateSink).toBe(runStore)
    expect(orchHarness.options[0].ptyFactory).toBe(inertPtyFactory)

    expect(claims).toEqual([{
      runId: 'r-1',
      input: {
        sessionId: 's-1',
        clientKind: 'claude-desktop',
        clientVersion: '1.4.0',
        conversationName: 'repair chat',
      },
    }])

    // The envset is applied for the restart, and the agent pane announces it.
    expect(fs.readFileSync(target, 'utf-8')).toBe('FROM SET\n')
    expect(readRunnerLog('r-1')).toContain('Applied envset "local" for external restart foo')
    expect(replay(brokers.get('r-1')!, 'agent')).toEqual([
      { type: 'data', chunk: '\n[orchestrator] Restarting external heal: the checkout total is wrong\n' },
    ])

    expect(restartCalls).toEqual(['the checkout total is wrong'])
    // Settled through the shared completion path: the run leaves the registry.
    await until(() => registry.get('r-1') === undefined)
  })

  it('re-enters external mode without a session when the caller may not own the heal loop', async () => {
    writeFeature('foo', { envs: ['staging'] })
    writeRunManifest({ runId: 'r-1' })

    const orch = await build()('r-1', healReq({ clientKind: 'other', claimable: false }))

    // A CLI / 'other' client triggers the restart but gets no claim, so nothing
    // spawns a local auto-heal agent behind the user's back.
    expect(claims).toEqual([])
    expect(orchHarness.options[0].externalHealSession).toBeUndefined()
    expect(orchHarness.options[0].externalHeal).toBe(true)
    // No env on the manifest → the feature's first configured env.
    expect(orchHarness.options[0].env).toBe('staging')
    // No envsets configured for it, so nothing was applied.
    expect(readRunnerLog('r-1')).not.toContain('Applied envset')
    expect(replay(brokers.get('r-1')!, 'agent')).toEqual([
      { type: 'data', chunk: '\n[orchestrator] Restarting external heal\n' },
    ])
    expect(registry.get('r-1')).toBe(orch)
    await until(() => registry.get('r-1') === undefined)
  })

  it('restarts a feature that declares no envs at all', async () => {
    writeFeature('foo')
    writeRunManifest({ runId: 'r-1' })

    await build()('r-1', healReq())

    expect(orchHarness.options[0].env).toBeUndefined()
    expect(readRunnerLog('r-1')).not.toContain('Applied envset')
    await until(() => registry.get('r-1') === undefined)
  })

  it('reuses the pane broker the previous attempt left behind', async () => {
    writeFeature('foo')
    writeRunManifest({ runId: 'r-1' })
    const broker = new PaneBroker()
    broker.push('agent', 'previous attempt\n')
    brokers.set('r-1', broker)

    await build()('r-1', healReq())

    // resetPane wiped the old transcript before the restart banner landed.
    expect(brokers.get('r-1')).toBe(broker)
    expect(broker.snapshot('agent')).toBe('\n[orchestrator] Restarting external heal\n')
    await until(() => registry.get('r-1') === undefined)
  })

  it('still deregisters the run when the restart itself throws', async () => {
    writeFeature('foo')
    writeRunManifest({ runId: 'r-1' })
    orchHarness.restart = () => Promise.reject(new Error('playwright never started'))

    await build()('r-1', healReq())

    await until(() => registry.get('r-1') === undefined)
    // The cause is persisted, not only pushed to a pane nobody may have open.
    await until(() => readRunnerLog('r-1').includes('Run failed to complete: '))
  })
})
