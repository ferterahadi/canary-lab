import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoveryRepairRoutes, type DiscoveryRepairRouteDeps } from './discovery-repair'
import { DiscoveryRepairService } from '../logic/discovery-repair-service'
import type { runDiscoveryRepairAgent } from '../logic/discovery-repair-agent'

// A real workspace on disk per test. The routes read `feature.config.cjs`,
// `canary-lab.config.json` and the repair records themselves, and the record
// store is memoized per logs directory — a shared root would carry one test's
// repairs into the next.
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

interface Workspace extends DiscoveryRepairRouteDeps { projectRoot: string }
function workspace(features: string[] = ['suite']): Workspace {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-route-')))
  const featuresDir = path.join(projectRoot, 'features')
  for (const name of features) {
    fs.mkdirSync(path.join(featuresDir, name), { recursive: true })
    fs.writeFileSync(path.join(featuresDir, name, 'feature.config.cjs'), `module.exports={config:{name:'${name}',featureDir:__dirname,repos:[],envs:[]}}`)
  }
  cleanups.push(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  return { projectRoot, featuresDir, logsDir: path.join(projectRoot, 'logs') }
}

/** Discovery that fails the way a broken suite does: a reason, and no roster. */
const failingList = () => vi.fn(async (_feature: unknown, diagnostic: (message: string) => void) => { diagnostic('missing import'); return null })

async function serve(deps: DiscoveryRepairRouteDeps, service?: DiscoveryRepairService): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(websocket)
  await app.register(discoveryRepairRoutes, { ...deps, service })
  await app.ready()
  cleanups.push(() => app.close())
  return app
}

const external = { kind: 'external', clientKind: 'codex', sessionId: 'owner' } as const

describe('discovery repair transport', () => {
  it('pushes external creation, milestones and terminal state to an already-open Tests stream and replays on reconnect', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-stream-'))
    const featuresDir = path.join(projectRoot, 'features')
    const dir = path.join(featuresDir, 'suite')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'feature.config.cjs'), "module.exports={config:{name:'suite',featureDir:__dirname,repos:[],envs:[]}}")
    const listTests = vi.fn(async (_f: unknown, diagnostics: (message: string) => void) => { diagnostics('missing import'); return null })
    const deps = { projectRoot, featuresDir, logsDir: path.join(projectRoot, 'logs'), listTests }
    const service = new DiscoveryRepairService(deps)
    const app = Fastify()
    await app.register(websocket)
    await app.register(discoveryRepairRoutes, { ...deps, service })
    await app.ready()
    const socket = await app.injectWS('/ws/features/suite/discovery-repairs')
    const snapshots: Array<{ repairs: Array<{ status: string; message: string }> }> = []
    socket.on('message', (raw) => snapshots.push(JSON.parse(raw.toString())))
    try {
      const started = await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: { kind: 'external', clientKind: 'codex', sessionId: 'owner' } })
      expect(started.statusCode).toBe(202)
      const id = started.json().id
      await service.settled()
      await app.inject({ method: 'POST', url: `/api/discovery-repairs/${id}`, payload: { sessionId: 'owner', action: 'progress', message: 'Inspecting imports' } })
      await vi.waitFor(() => expect(snapshots.some((s) => s.repairs[0]?.message === 'Inspecting imports')).toBe(true))
      await app.inject({ method: 'POST', url: `/api/discovery-repairs/${id}`, payload: { sessionId: 'owner', action: 'verify' } })
      await service.settled()
      await vi.waitFor(() => expect(snapshots.some((s) => s.repairs[0]?.status === 'failed')).toBe(true))
      socket.close()
      let replay: string | undefined
      const resumed = await app.injectWS('/ws/features/suite/discovery-repairs', {}, { onInit: (ws) => { ws.on('message', (raw) => { replay = raw.toString() }) } })
      await vi.waitFor(() => expect(replay).toContain('missing import'))
      resumed.close()
      const invalid = await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: { kind: 'external', sessionId: '', clientKind: 'codex' } })
      expect(invalid.statusCode).toBe(400)
    } finally { socket.close(); await app.close(); fs.rmSync(projectRoot, { recursive: true, force: true }) }
  })

  it('says on every row whether the instructions the agent is told to read exist yet', async () => {
    const deps = workspace()
    // Discovery held open, so the "no prompt yet" window is a state the test
    // controls rather than a race it hopes to win.
    let finish: (tests: null) => void = () => {}
    const service = new DiscoveryRepairService({ ...deps, listTests: () => new Promise<null>((resolve) => { finish = resolve }) })
    const app = await serve(deps, service)
    const id = (await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: external })).json().id
    expect((await app.inject({ url: `/api/discovery-repairs/${id}` })).json()).toMatchObject({ id, promptReady: false })
    finish(null)
    await service.settled()
    expect((await app.inject({ url: '/api/features/suite/discovery-repairs' })).json()).toMatchObject([{ id, promptReady: true }])
  })

  it('refuses a report whose action is not one of the three the protocol defines', async () => {
    const deps = workspace()
    const service = new DiscoveryRepairService({ ...deps, listTests: failingList() })
    const app = await serve(deps, service)
    const id = (await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: external })).json().id
    await service.settled()
    const res = await app.inject({ method: 'POST', url: `/api/discovery-repairs/${id}`, payload: { sessionId: 'owner', action: 'finished' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Invalid repair update' })
  })

  it('takes a deep link back to the owning conversation, but only in a scheme a client can open', async () => {
    const deps = workspace()
    const service = new DiscoveryRepairService({ ...deps, listTests: failingList() })
    const app = await serve(deps, service)
    const ok = await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: { ...external, clientKind: 'claude', sessionUrl: 'claude://session/abc' } })
    expect(ok.statusCode).toBe(202)
    // Parseable is not enough: the UI renders this as a clickable hand-back, so
    // a scheme nothing registers is refused at the door rather than stored and
    // shown as a dead link.
    const bad = await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: { ...external, sessionUrl: 'ftp://files.example.com/session' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: 'Invalid discovery repair owner' })
    await service.settled()
  })

  it("starts Canary's own agent with the CLI the project configured", async () => {
    const deps = workspace()
    const codex = path.join(deps.projectRoot, 'codex-stub')
    fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(codex, 0o755)
    // The env override is how the resolver is pointed at a CLI without asking
    // the machine running the test to have one installed.
    vi.stubEnv('CANARY_LAB_CODEX_BIN', codex)
    fs.writeFileSync(path.join(deps.projectRoot, 'canary-lab.config.json'), JSON.stringify({ healAgent: 'codex' }))
    const runAgent = vi.fn<typeof runDiscoveryRepairAgent>(async () => {})
    const service = new DiscoveryRepairService({ ...deps, listTests: failingList(), runAgent })
    const app = await serve(deps, service)
    const res = await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: { kind: 'internal' } })
    expect(res.statusCode).toBe(202)
    expect(res.json().owner).toEqual({ kind: 'internal', agent: 'codex' })
    await service.settled()
    expect(runAgent).toHaveBeenCalledOnce()
  })

  it('refuses an internal start when no CLI answers, pointing the caller at the agent-side command instead', async () => {
    const deps = workspace()
    // `manual` means "do not pick one for me", so the resolver falls back to its
    // env default — set here to a name no CLI answers to, which it refuses
    // rather than quietly trying claude.
    fs.writeFileSync(path.join(deps.projectRoot, 'canary-lab.config.json'), JSON.stringify({ healAgent: 'manual' }))
    vi.stubEnv('CANARY_LAB_HEAL_AGENT', 'neither')
    const service = new DiscoveryRepairService({ ...deps, listTests: failingList() })
    const app = await serve(deps, service)
    const res = await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: { kind: 'internal' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('No repair agent is available')
    expect(service.list('suite')).toEqual([])
  })

  it('reports a session log that has not been written yet instead of an empty transcript, and serves it once it lands', async () => {
    const deps = workspace()
    const configDir = path.join(deps.projectRoot, 'claude-config')
    fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true })
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
    const sessionId = '11111111-2222-3333-4444-555555555555'
    const runAgent = vi.fn<typeof runDiscoveryRepairAgent>(async (_repair, _root, onSession) => { onSession({ agent: 'claude', sessionId }) })
    const service = new DiscoveryRepairService({ ...deps, listTests: failingList(), runAgent })
    const app = await serve(deps, service)
    const repair = service.start('suite', { kind: 'internal', agent: 'claude' })
    await service.settled()
    // The ref is pinned at spawn, but claude writes its JSONL a moment later —
    // between the two the view must say "not here" rather than "nothing said".
    expect((await app.inject({ url: `/api/discovery-repairs/${repair.id}/agent-session` })).json()).toEqual({ absent: true, reason: 'session-log-missing' })
    fs.writeFileSync(path.join(configDir, 'projects', 'p', `${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'user', timestamp: '2026-09-10T00:00:00.000Z', message: { content: 'Fix test discovery.' } })}\n`)
    expect((await app.inject({ url: `/api/discovery-repairs/${repair.id}/agent-session` })).json()).toMatchObject({
      agent: 'claude', sessionId, events: [{ kind: 'user-message', text: 'Fix test discovery.' }],
    })
  })

  it('streams the session over the socket as soon as the log appears', async () => {
    const deps = workspace()
    const configDir = path.join(deps.projectRoot, 'claude-config')
    fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true })
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
    const sessionId = '22222222-3333-4444-5555-666666666666'
    const runAgent = vi.fn<typeof runDiscoveryRepairAgent>(async (_repair, _root, onSession) => { onSession({ agent: 'claude', sessionId }) })
    const service = new DiscoveryRepairService({ ...deps, listTests: failingList(), runAgent })
    const app = await serve(deps, service)
    const repair = service.start('suite', { kind: 'internal', agent: 'claude' })
    await service.settled()
    const frames: Array<{ type: string; sessionId?: string }> = []
    // Subscribing before the log exists is the normal case — the UI opens the
    // rail the moment the repair starts — so the socket has to keep asking.
    const socket = await app.injectWS(`/ws/discovery-repairs/${repair.id}/agent-session`, {}, { onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))) })
    fs.writeFileSync(path.join(configDir, 'projects', 'p', `${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'user', timestamp: '2026-09-10T00:00:00.000Z', message: { content: 'Fix test discovery.' } })}\n`)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'session' && f.sessionId === sessionId)).toBe(true), { timeout: 10_000 })
    socket.close()
  }, 20_000)

  it('closes an agent-session socket for a repair id that cannot name a repair, with the reason on the wire', async () => {
    const deps = workspace()
    const app = await serve(deps, new DiscoveryRepairService({ ...deps, listTests: failingList() }))
    let frame = ''
    const socket = await app.injectWS('/ws/discovery-repairs/nope/agent-session', {}, { onInit: (ws) => ws.on('message', (raw) => { frame = raw.toString() }) })
    await vi.waitFor(() => expect(frame).toContain('Invalid repair id'))
    socket.close()
  })

  it("ignores another suite's repair, and releases the subscription when the subscriber goes away", async () => {
    const deps = workspace(['suite', 'other'])
    const service = new DiscoveryRepairService({ ...deps, listTests: failingList() })
    const app = await serve(deps, service)
    // A real socket over a real port, not `injectWS`: the injected transport
    // never delivers the client's close frame, so the server would never run
    // the teardown this test is about.
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const onEvent = vi.spyOn(service.store, 'onEvent')
    const offEvent = vi.spyOn(service.store, 'offEvent')
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(address).port}/ws/features/suite/discovery-repairs`)
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
    const changed = onEvent.mock.calls[0][0]
    const listed = vi.spyOn(service, 'list')

    // A repair on a different suite reaches the same store listener; it must
    // not recompute — and therefore not push — this subscriber's snapshot.
    service.start('other', external)
    await service.settled()
    expect(listed.mock.calls.map(([feature]) => feature)).not.toContain('suite')
    const mine = service.start('suite', external)
    await service.settled()
    expect(listed.mock.calls.map(([feature]) => feature)).toContain('suite')

    socket.close()
    // Closing releases the subscription: the store stops calling a listener
    // whose socket is gone, and the 15s snapshot timer goes with it.
    await vi.waitFor(() => expect(offEvent).toHaveBeenCalledWith(changed))
    listed.mockClear()
    // That released listener is exactly what a store event already in flight
    // would still reach. Dispatching it must not write to a socket that is
    // gone: a `ws` send after close raises on the socket rather than returning.
    expect(() => changed({ kind: 'changed', id: mine.id })).not.toThrow()
    expect(listed).not.toHaveBeenCalled()
  })

  it('writes off a repair the last server left running, before it serves the first list', async () => {
    const deps = workspace()
    // The agent is held mid-repair, which is the only way a record is still
    // `repairing` when a second server comes up over the same logs directory.
    let release: () => void = () => {}
    const runAgent = vi.fn<typeof runDiscoveryRepairAgent>(() => new Promise<void>((resolve) => { release = resolve }))
    const seed = new DiscoveryRepairService({ ...deps, listTests: failingList(), runAgent })
    const stranded = seed.start('suite', { kind: 'internal', agent: 'claude' })
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalled())
    // No injected service: the route builds its own and reconciles on the way up.
    const app = await serve(deps)
    const rows = (await app.inject({ url: '/api/features/suite/discovery-repairs' })).json()
    expect(rows).toMatchObject([{ id: stranded.id, status: 'failed', message: 'Repair interrupted by server restart' }])
    expect(rows[0].endedAt).toEqual(expect.any(String))
    release()
    await seed.settled()
  })
})
