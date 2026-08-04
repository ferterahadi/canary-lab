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

const { pollUntilReady, waitForHealth, waitForServiceReady } = await import('./run-service-boot')
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
