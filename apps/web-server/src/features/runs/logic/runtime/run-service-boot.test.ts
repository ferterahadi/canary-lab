// Service boot arms the orchestrator tests never reach: a feature with no
// services at all, a health probe that passes while a heal cycle is already in
// flight, and a TCP probe that never comes up.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunContext } from './run-context'
import type { ServiceSpec } from './orchestrator'

const h = vi.hoisted(() => ({ recordLifecycle: vi.fn() }))
vi.mock('./run-manifest-writer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-manifest-writer')>()),
  recordLifecycle: h.recordLifecycle,
}))

const { ensureServicesRunning, pollUntilReady, spawnService, testPortEnv, testPortEnvKey, waitForHealth, waitForServiceReady } = await import('./run-service-boot')
const { makeHealLoopContext } = await import('./__fixtures__/heal-loop-context')

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-svc-boot-')))
  vi.clearAllMocks()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function svcSpec(over: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    name: 'api',
    safeName: 'api',
    command: 'noop',
    cwd: tmpDir,
    healthProbe: { tcp: { port: 5999, deadlineMs: 5 } },
    ...over,
  } as unknown as ServiceSpec
}

function ctxFor(state: Partial<RunContext> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

describe('waitForHealth', () => {
  it('returns immediately when the feature declares no services', async () => {
    const { ctx } = ctxFor()
    // A feature with no `services:` entry — nothing to probe, so nothing to
    // wait for. Without the guard this would `Promise.all([])` anyway, but the
    // early return keeps a service-less run from touching the state sink.
    expect(ctx.services).toEqual([])

    await expect(waitForHealth(ctx)).resolves.toBeUndefined()
    expect(h.recordLifecycle).not.toHaveBeenCalled()
  })
})

describe('dependency preflight', () => {
  it('rechecks and replaces evidence even when rerun keeps every service process warm', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'))
    fs.writeFileSync(path.join(tmpDir, 'dependencies-ready'), 'ready')
    const { ctx } = ctxFor({
      feature: {
        name: 'demo', description: 'demo', envs: [], featureDir: tmpDir,
        repos: [{ name: 'api', localPath: tmpDir, dependencyPreparation: { mode: 'isolated', validateCommand: 'test -f dependencies-ready' } }],
      },
      worktreeHandles: [{ repoName: 'api', sourceRoot: tmpDir, worktreeRoot: tmpDir, localPath: tmpDir }],
      services: [svcSpec({ repoName: 'api', healthProbe: undefined })],
      ptyFactory: vi.fn(),
    })
    const warm = { pid: 0 } as ReturnType<RunContext['ptyFactory']>
    ctx.servicePtys.set('api', warm)
    await expect(ensureServicesRunning(ctx)).resolves.toEqual([])
    const first = ctx.dependencyProvenance
    expect(first[0].verdict).toBe('compatible')

    fs.unlinkSync(path.join(tmpDir, 'dependencies-ready'))
    await expect(ensureServicesRunning(ctx)).resolves.toEqual([])
    expect(ctx.dependencyProvenance).not.toBe(first)
    expect(ctx.dependencyProvenance).toHaveLength(1)
    expect(ctx.dependencyProvenance[0]).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'validation-failed' })
    expect(ctx.stateSink.patchManifest).toHaveBeenCalledWith(ctx.runId, { dependencyProvenance: ctx.dependencyProvenance })
    expect(ctx.bootFailure?.reason).toBe('dependency-incompatible')
    expect(ctx.ptyFactory).not.toHaveBeenCalled()
    expect(ctx.servicePtys.get('api')).toBe(warm)
  })

  it('persists a confirmed incompatibility and starts no service process', async () => {
    const logPath = path.join(tmpDir, 'dependency-api.log')
    fs.writeFileSync(logPath, 'TOKEN=private\nvalidator rejected generated client\n')
    const { ctx } = ctxFor({
      services: [svcSpec()],
      dependencyProvenance: [{
        repoName: 'api',
        sourceRevision: 'abc123',
        sourcePath: '/source',
        worktreePath: '/worktree',
        dependencyPath: '/worktree/node_modules',
        dependencyRealPath: '/source/node_modules',
        lockfile: null,
        dependencyLockfile: null,
        generatorInputs: [],
        dependencyGeneratorInputs: [],
        runtime: { node: process.version, packageManager: 'npm' },
        mode: 'shared',
        verdict: 'incompatible',
        validation: { command: 'npm run validate-deps', cwd: '/worktree', exitCode: 1, signal: null, logPath },
        remediation: 'Use isolated mode.',
      }],
      ptyFactory: vi.fn(),
    })

    await expect(ensureServicesRunning(ctx)).resolves.toEqual([])

    expect(ctx.ptyFactory).not.toHaveBeenCalled()
    expect(ctx.bootFailure).toMatchObject({
      reason: 'dependency-incompatible',
      command: 'npm run validate-deps',
      exitCode: 1,
      excerpt: expect.stringContaining('TOKEN=[REDACTED]'),
      nextAction: 'Use isolated mode.',
    })
    expect(ctx.bootFailure?.excerpt).not.toContain('private')
    expect(ctx.stateSink.patchManifest).toHaveBeenCalledWith(ctx.runId, { bootFailure: ctx.bootFailure })
  })
})

describe('service process evidence', () => {
  it('persists a redacted spawn failure with command and cwd', () => {
    const { ctx } = ctxFor({
      ptyFactory: () => { throw new Error('TOKEN=private spawn denied') },
    })

    spawnService(ctx, svcSpec({ command: 'node server.js --token private' }))

    expect(ctx.bootFailure).toMatchObject({
      reason: 'spawn-failed',
      command: 'node server.js --token [REDACTED]',
      cwd: tmpDir,
      exitCode: null,
      signal: null,
    })
    expect(ctx.bootFailure?.classification).toBeUndefined()
    expect(ctx.bootFailure?.excerpt).toContain('TOKEN=[REDACTED]')
    expect(ctx.bootFailure?.excerpt).not.toContain('private')
  })

  it('retains the process exit code, signal and typed compiler evidence', async () => {
    let onData: ((chunk: string) => void) | undefined
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined
    const { ctx } = ctxFor({
      ptyFactory: () => ({
        pid: 42,
        onData: (cb) => { onData = cb; return { dispose() {} } },
        onExit: (cb) => { onExit = cb; return { dispose() {} } },
        write() {},
        resize() {},
        kill() {},
      }),
    })
    const svc = svcSpec({ command: 'npm run dev' })
    spawnService(ctx, svc)
    onData?.('compiler failed\nTS2322: wrong type\n')
    onExit?.({ exitCode: 2, signal: 15 })

    await pollUntilReady(ctx, svc, 'tcp', async () => false)

    expect(ctx.bootFailure).toMatchObject({
      reason: 'process-exited',
      classification: 'abrupt-signal',
      command: 'npm run dev',
      cwd: tmpDir,
      exitCode: 2,
      // Normalized to the NAME at the producer; node-pty reports 15.
      signal: 'SIGTERM',
    })
    expect(ctx.bootFailure?.excerpt).toContain('TS2322')
  })
})

describe('testPortEnv', () => {
  it('normalizes a hyphenated slot into a shell-safe Playwright env key', () => {
    const { ctx } = ctxFor({ portMap: new Map([['checkout-service', 51997]]) })

    expect(testPortEnvKey('checkout-service')).toBe('CANARY_PORT_checkout_service')
    expect(testPortEnv(ctx)).toEqual({ CANARY_PORT_checkout_service: '51997' })
  })

  // Under a perturbation the SERVICE keeps the real port (its env + health probe
  // come from portMap) while Playwright is handed the shim's, so every request
  // the suite makes crosses the shim.
  it('hands Playwright the shim port, not the real one, when the run is perturbed', () => {
    const { ctx } = ctxFor({
      portMap: new Map([['api', 51997]]),
      perturbation: { envelope: { format: 'canary-lab/robustness-envelope@1' }, shimPorts: new Map([['api', 51900]]) },
    })

    expect(testPortEnv(ctx)).toEqual({ CANARY_PORT_api: '51900' })
  })

  it('normalizes every non-identifier character, not only hyphens', () => {
    expect(testPortEnvKey('checkout.service/v2')).toBe('CANARY_PORT_checkout_service_v2')
  })

  it('rejects two slots that collapse onto the same Playwright env key', () => {
    const { ctx } = ctxFor({ portMap: new Map([['checkout-service', 51997], ['checkout_service', 51996]]) })

    expect(() => testPortEnv(ctx)).toThrow(/both normalize.*CANARY_PORT_checkout_service/)
  })
})

describe('pollUntilReady', () => {
  it('files a passing probe under the heal phase when a cycle is in flight', async () => {
    const { ctx } = ctxFor({ status: 'healing' })
    const svc = svcSpec()

    await pollUntilReady(ctx, svc, 'tcp', async () => true)

    expect(h.recordLifecycle).toHaveBeenCalledWith(
      ctx,
      'agent-healing',
      'Health passed: api',
      expect.objectContaining({ severity: 'success' }),
    )
  })

  it('files the same pass under service boot on a normal run', async () => {
    const { ctx } = ctxFor({ status: 'running' })

    await pollUntilReady(ctx, svcSpec(), 'tcp', async () => true)

    expect(h.recordLifecycle).toHaveBeenCalledWith(
      ctx, 'starting-services', 'Health passed: api', expect.anything(),
    )
  })

  it('names the port, not a URL, when a TCP probe times out', async () => {
    const { ctx } = ctxFor({ status: 'running', servicePtys: new Map([['api', {} as never]]) })

    await pollUntilReady(ctx, svcSpec(), 'tcp', async () => false)

    expect(ctx.bootFailure).toMatchObject({ service: 'api', reason: 'health-timeout' })
    expect(ctx.bootFailure?.detail).toContain('port=5999')
    expect(ctx.bootFailure?.detail).not.toContain('url=')
    expect(ctx.bootFailure?.nextAction).toContain('process remained alive')
    expect(ctx.bootFailure?.nextAction).not.toContain('outer startup wrapper')
  })

  it('names the URL when an HTTP probe times out', async () => {
    const { ctx } = ctxFor({ status: 'running', servicePtys: new Map([['api', {} as never]]) })
    const svc = svcSpec({ healthProbe: { http: { url: 'http://127.0.0.1:5999/health', deadlineMs: 5 } } } as Partial<ServiceSpec>)

    await pollUntilReady(ctx, svc, 'http', async () => false)

    expect(ctx.bootFailure?.detail).toContain('url=http://127.0.0.1:5999/health')
  })

  it('fast-fails as process-exited when the pty is already gone', async () => {
    // spawnService's onExit removes the entry, so a missing one means the
    // process died — no point polling a dead port until the deadline.
    const { ctx } = ctxFor({ status: 'running', servicePtys: new Map() })

    await pollUntilReady(ctx, svcSpec(), 'tcp', async () => false)

    expect(ctx.bootFailure).toMatchObject({ reason: 'process-exited' })
    expect(ctx.bootFailure?.detail).toContain('exited before TCP readiness')
  })
})

describe('waitForServiceReady', () => {
  it('warns and passes a service that declares no probe at all', async () => {
    const { ctx, events } = ctxFor()
    const svc = svcSpec({ healthProbe: undefined })

    await waitForServiceReady(ctx, svc)

    expect(events).toContainEqual({ event: 'health-check', payload: { service: svc, healthy: true } })
  })
})
