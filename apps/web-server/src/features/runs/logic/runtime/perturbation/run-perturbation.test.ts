// Booting a run under a perturbation (D14): one shim per declared slot, with
// Playwright and the envsets pointed at the shims while the services keep the
// real ports. Real loopback sockets throughout — the wiring IS the behaviour.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { makeHealLoopContext } from '../__fixtures__/heal-loop-context'
import type { RunContext } from '../run-context'
import type { ServiceSpec } from '../run-orchestrator-types'
import type { PtyHandle } from '../pty-spawner'
import { ROBUSTNESS_ENVELOPE_FORMAT } from '../../../../../../../../shared/robustness/envelope'
import type { RobustnessEnvelope } from '../../../../../../../../shared/robustness/types'
import { allocatePerturbationPorts, clientPortMap, resetPerturbationShims, startPerturbationShims, stopPerturbationShims } from './run-perturbation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-run-pert-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ENVELOPE: RobustnessEnvelope = { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 0 } }

async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) }
}

function get(port: number, p = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // No keep-alive: a pooled socket the shim has since closed would surface as
    // ECONNRESET on reuse instead of the ECONNREFUSED a fresh connect gets.
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
  })
}

function post(port: number, p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end('x')
  })
}

/** Exits shortly after a kill, as a real process does on SIGTERM — a restart
 *  waits for that exit (bounded at 5s) before booting the replacement. */
function fakePty(): PtyHandle {
  const exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = []
  return {
    pid: 0,
    kill: () => { setTimeout(() => { for (const cb of exitCbs) cb({ exitCode: 0, signal: 15 }) }, 5) },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCbs.push(cb); return { dispose() {} } },
    write: () => {},
    resize: () => {},
  }
}

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, opts: { ptyFactory: fakePty, ...opts }, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

describe('allocatePerturbationPorts', () => {
  it('is nothing when the run carries no envelope', async () => {
    expect(await allocatePerturbationPorts(undefined, new Map([['api', 4100]]))).toBeUndefined()
  })

  // Same bar Portify sets: a service on a fixed port cannot be fronted, because
  // nothing tells Playwright to talk to the shim instead.
  it('refuses, as a 400, a feature that declares no port slots', async () => {
    await expect(allocatePerturbationPorts(ENVELOPE, undefined)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/declares no port slots/),
    })
    await expect(allocatePerturbationPorts(ENVELOPE, new Map())).rejects.toMatchObject({ statusCode: 400 })
  })

  it('allocates one distinct free shim port per slot, never the real port', async () => {
    const real = new Map([['api', 4100], ['inventory', 4200]])
    const p = await allocatePerturbationPorts(ENVELOPE, real)
    expect(p?.envelope).toBe(ENVELOPE)
    expect([...p!.shimPorts.keys()]).toEqual(['api', 'inventory'])
    const ports = [...p!.shimPorts.values()]
    expect(new Set(ports).size).toBe(2)
    for (const port of ports) {
      expect(port).toBeGreaterThan(1024)
      expect([...real.values()]).not.toContain(port)
    }
  })
})

describe('clientPortMap', () => {
  it('is the real port map for an unperturbed run and the shim map for a perturbed one', () => {
    const portMap = new Map([['api', 4100]])
    const shimPorts = new Map([['api', 4900]])
    expect(clientPortMap({ portMap, perturbation: undefined })).toBe(portMap)
    expect(clientPortMap({ portMap: undefined, perturbation: undefined })).toBeUndefined()
    expect(clientPortMap({ portMap, perturbation: { envelope: ENVELOPE, shimPorts } })).toBe(shimPorts)
  })
})

describe('startPerturbationShims / stopPerturbationShims', () => {
  it('is a no-op for a run without a perturbation', async () => {
    const { ctx } = ctxFor()
    await startPerturbationShims(ctx)
    expect(ctx.perturbationShims).toEqual([])
    await stopPerturbationShims(ctx)
  })

  it('fronts every slot on its allocated shim port, forwarding to the real one', async () => {
    const api = await listen((_q, r) => r.end('api'))
    const inv = await listen((_q, r) => r.end('inventory'))
    const portMap = new Map([['api', api.port], ['inventory', inv.port]])
    const perturbation = await allocatePerturbationPorts(ENVELOPE, portMap)
    const { ctx } = ctxFor({}, { portMap, perturbation })

    await startPerturbationShims(ctx)

    expect(ctx.perturbationShims.map((s) => s.slot).sort()).toEqual(['api', 'inventory'])
    expect((await get(perturbation!.shimPorts.get('api')!)).body).toBe('api')
    expect((await get(perturbation!.shimPorts.get('inventory')!)).body).toBe('inventory')

    await stopPerturbationShims(ctx)
    expect(ctx.perturbationShims).toEqual([])
    await expect(get(perturbation!.shimPorts.get('api')!)).rejects.toThrow(/ECONNREFUSED/)
    await api.close(); await inv.close()
  })

  it('binds each restart entry to its own slot and recycles that slot\'s service on the Nth match', async () => {
    const api = await listen((_q, r) => r.end('api'))
    const inv = await listen((_q, r) => r.end('inventory'))
    const portMap = new Map([['api', api.port], ['inventory', inv.port]])
    const envelope: RobustnessEnvelope = {
      format: ROBUSTNESS_ENVELOPE_FORMAT,
      restart: [{ slot: 'inventory', afterNth: 1, match: 'POST /reserve' }],
    }
    const perturbation = await allocatePerturbationPorts(envelope, portMap)
    const spawned: string[] = []
    const services: ServiceSpec[] = [
      { repoName: 'app', name: 'inventory-service', safeName: 'inventory-service', command: 'serve-inventory', cwd: tmpDir, allocatedPorts: { inventory: inv.port } },
      { repoName: 'app', name: 'api-service', safeName: 'api-service', command: 'serve-api', cwd: tmpDir, allocatedPorts: { api: api.port } },
    ] as ServiceSpec[]
    const { ctx } = ctxFor({ services }, {
      portMap,
      perturbation,
      ptyFactory: (o: { command: string }) => { spawned.push(o.command); return fakePty() },
    })
    await startPerturbationShims(ctx)

    // The api slot has no restart entry: a matching request there recycles nothing.
    await post(perturbation!.shimPorts.get('api')!, '/reserve')
    expect(spawned).toEqual([])
    await post(perturbation!.shimPorts.get('inventory')!, '/reserve')
    // The one spawn is the inventory service, through the shared service boot
    // (which prefixes the plain-log mode) — not the api service and not both.
    expect(spawned).toEqual(['LOG_MODE=plain serve-inventory'])
    expect(ctx.servicePtys.has('inventory-service')).toBe(true)
    expect(ctx.perturbationShims.find((s) => s.slot === 'inventory')!.events.map((e) => e.kind)).toEqual(['restarted', 'forwarded'])

    await stopPerturbationShims(ctx)
    await api.close(); await inv.close()
  })

  // Every Playwright pass — the first run and each heal-cycle rerun — must meet
  // the same perturbation, or a rerun after a repair would pass because the
  // restart already happened, not because the app now survives it.
  it('re-arms every shim\'s restart on reset', async () => {
    const inv = await listen((_q, r) => r.end('inventory'))
    const portMap = new Map([['inventory', inv.port]])
    const envelope: RobustnessEnvelope = { format: ROBUSTNESS_ENVELOPE_FORMAT, restart: [{ slot: 'inventory', afterNth: 1, match: 'POST /reserve' }] }
    const perturbation = await allocatePerturbationPorts(envelope, portMap)
    const spawned: string[] = []
    const services = [{ repoName: 'app', name: 'inventory-service', safeName: 'inventory-service', command: 'noop', cwd: tmpDir, allocatedPorts: { inventory: inv.port } }] as ServiceSpec[]
    const { ctx } = ctxFor({ services }, { portMap, perturbation, ptyFactory: (o: { command: string }) => { spawned.push(o.command); return fakePty() } })
    await startPerturbationShims(ctx)
    const shimPort = perturbation!.shimPorts.get('inventory')!

    await post(shimPort, '/reserve')
    await post(shimPort, '/reserve')
    expect(spawned).toHaveLength(1)
    resetPerturbationShims(ctx)
    await post(shimPort, '/reserve')
    expect(spawned).toHaveLength(2)

    await stopPerturbationShims(ctx)
    await inv.close()
  })
})
