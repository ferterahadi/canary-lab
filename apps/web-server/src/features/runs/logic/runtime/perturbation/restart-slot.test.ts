// The restart atom's runtime half: recycle the one service that owns a port
// slot, through the same spawn + readiness primitives the run boot uses.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { makeHealLoopContext } from '../__fixtures__/heal-loop-context'
import type { RunContext } from '../run-context'
import type { ServiceSpec } from '../run-orchestrator-types'
import type { PtyHandle } from '../pty-spawner'
import { restartSlotService } from './restart-slot'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-restart-slot-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

interface FakePty extends PtyHandle { kills: string[]; exit: () => void }

/** pid 0 keeps `killTree`'s process-group path inert (its guard refuses pid ≤ 1),
 *  so a kill lands on this handle and nowhere on the host. `exitOnKill` mirrors a
 *  real service: SIGTERM → the process exits a moment later. */
function fakePty(exitOnKill = true): FakePty {
  const kills: string[] = []
  const exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = []
  const exit = () => { for (const cb of exitCbs) cb({ exitCode: 0, signal: 15 }) }
  return {
    pid: 0,
    kills,
    exit,
    kill: vi.fn((sig?: string) => {
      kills.push(sig ?? 'SIGTERM')
      if (exitOnKill) setTimeout(exit, 5)
    }),
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCbs.push(cb); return { dispose() {} } },
    write: () => {},
    resize: () => {},
  }
}

function svc(over: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    repoName: 'app',
    name: 'api',
    safeName: 'api',
    command: 'noop',
    cwd: tmpDir,
    allocatedPorts: { api: 4100 },
    ...over,
  } as ServiceSpec
}

function ctxFor(services: ServiceSpec[], factory: () => PtyHandle, state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({
    root: tmpDir,
    opts: { ptyFactory: factory, healthPollIntervalMs: 5, delay: (ms: number) => new Promise((r) => setTimeout(r, ms)), ...opts },
    state: { services, ...state },
  })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

describe('restartSlotService', () => {
  it('SIGTERMs the owning service, waits for it to exit, respawns it and marks it ready', async () => {
    const old = fakePty()
    const fresh = fakePty()
    const factory = vi.fn(() => fresh)
    const { ctx, sink } = ctxFor([svc({ healthProbe: undefined })], factory)
    ctx.servicePtys.set('api', old)

    await restartSlotService(ctx, 'api')

    expect(old.kills).toEqual(['SIGTERM'])
    expect(factory).toHaveBeenCalledTimes(1)
    expect(ctx.servicePtys.get('api')).toBe(fresh)
    expect(sink.setServiceStatus).toHaveBeenCalledWith('r-heal-loop', 'api', 'starting')
    expect(sink.setServiceStatus).toHaveBeenLastCalledWith('r-heal-loop', 'api', 'ready')
  })

  it('waits for the readiness probe of the respawned service', async () => {
    const listener = net.createServer()
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r))
    const port = (listener.address() as net.AddressInfo).port
    const { ctx } = ctxFor([svc({ healthProbe: { tcp: { port, deadlineMs: 2000 } } })], () => fakePty())
    ctx.servicePtys.set('api', fakePty())

    await restartSlotService(ctx, 'api')

    expect(ctx.bootFailure).toBeUndefined()
    await new Promise<void>((r) => listener.close(() => r()))
  })

  it('throws with the boot failure when the service does not come back healthy', async () => {
    const dead = net.createServer()
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
    const port = (dead.address() as net.AddressInfo).port
    await new Promise<void>((r) => dead.close(() => r()))
    const { ctx } = ctxFor([svc({ healthProbe: { tcp: { port, deadlineMs: 40, timeoutMs: 10 } } })], () => fakePty())
    ctx.servicePtys.set('api', fakePty())

    await expect(restartSlotService(ctx, 'api')).rejects.toThrow(/Timed out waiting for TCP readiness/)
  })

  it('spawns straight away when the owning service is already down', async () => {
    const factory = vi.fn(() => fakePty())
    const { ctx } = ctxFor([svc({ healthProbe: undefined })], factory)

    await restartSlotService(ctx, 'api')

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('gives up waiting for a process that ignores SIGTERM and respawns anyway, after the bounded wait', async () => {
    const stubborn = fakePty(false)
    const factory = vi.fn(() => fakePty())
    const { ctx } = ctxFor([svc({ healthProbe: undefined })], factory)
    ctx.servicePtys.set('api', stubborn)

    await restartSlotService(ctx, 'api', { exitWaitMs: 30 })

    expect(stubborn.kills[0]).toBe('SIGTERM')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('names the slot when no service declares it', async () => {
    const { ctx } = ctxFor([svc()], () => fakePty())
    await expect(restartSlotService(ctx, 'inventory')).rejects.toThrow('no service in this run declares port slot "inventory"')
  })
})
