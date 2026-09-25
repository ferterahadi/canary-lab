import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { register } from './index'
import type { ServerContext } from '../../server-context'
import type { FlightIndexEntry } from '../../../../../shared/flights/types'

// The registrar's own wiring: which store events rebuild the inbox, what a
// store it cannot read does to the event that triggered the rebuild, and what
// it releases on shutdown. The inbox itself is `store.test.ts`; the mapping
// from store rows to messages is `sources.test.ts`.

/** A paused flight — the shape that actually produces a notification. */
const flight = { flightId: 'f1', feature: 'shop', status: 'paused', pauseReason: 'stage-failed', currentStage: 'run' } as FlightIndexEntry

type Listener = () => void

/**
 * Each of the three stores reduced to what the registrar uses: a listing, and
 * a subscription it is expected to hand back. `fire` stands in for the store's
 * own emit, which is private on all three.
 */
function stubStore<T>(rows: T[]) {
  const listeners = new Set<Listener>()
  return {
    list: vi.fn((): T[] => rows),
    onEvent: (fn: Listener): void => { listeners.add(fn) },
    offEvent: (fn: Listener): void => { listeners.delete(fn) },
    fire: (): void => { for (const fn of [...listeners]) fn() },
    subscriberCount: (): number => listeners.size,
  }
}

let dir: string
let app: FastifyInstance
let flightStore: ReturnType<typeof stubStore<FlightIndexEntry>>
let runStore: ReturnType<typeof stubStore<never>>
let dirtySpecStore: ReturnType<typeof stubStore<never>>

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-notifications-reg-')))
  flightStore = stubStore([flight])
  runStore = stubStore<never>([])
  dirtySpecStore = stubStore<never>([])
  app = Fastify()
  await register(app, {
    logsDir: dir, featuresDir: dir, workspaceEvents: { publish: vi.fn() }, flightStore, runStore, dirtySpecStore,
  } as unknown as ServerContext)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const inbox = async (): Promise<unknown[]> => (await app.inject('/api/notifications')).json()

describe('notifications feature registrar', () => {
  it('resolves a Flight alert from the store event when the Flight resumes', async () => {
    const [active] = await inbox() as Array<{ id: string; resolvedAt?: string }>
    expect(active.resolvedAt).toBeUndefined()

    flightStore.list.mockReturnValue([{ ...flight, status: 'running', pauseReason: undefined }])
    flightStore.fire()

    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'notifications', 'state.json'), 'utf8')) as { items: Array<{ id: string; resolvedAt?: string }> }
    expect(persisted.items).toEqual([expect.objectContaining({ id: active.id, resolvedAt: expect.any(String) })])
  })

  it('keeps serving the inbox it already built when a store read fails, rather than throwing into the event that triggered the rebuild', async () => {
    const previous = await inbox()
    expect(previous).toHaveLength(1)
    const logged = vi.spyOn(app.log, 'error')
    runStore.list.mockImplementation(() => { throw new Error('runs index unreadable') })

    // The event arrives mid-run. Letting the rebuild throw here would surface
    // as that run failing, for a reason that has nothing to do with the run.
    expect(() => runStore.fire()).not.toThrow()

    expect(logged).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Could not update notifications')
    // And the last good inbox is still served — a failed rebuild must not read
    // to the user as "you have no notifications".
    expect(await inbox()).toEqual(previous)

    // A later successful read still projects authoritative resolution, without
    // needing another source event or restarting the server.
    runStore.list.mockReturnValue([])
    flightStore.list.mockReturnValue([])
    expect(await inbox()).toEqual([expect.objectContaining({ resolvedAt: expect.any(String) })])
  })

  it('marks an existing Flight alert unavailable when its source cannot be read', async () => {
    const [active] = await inbox() as Array<{ id: string }>
    flightStore.list.mockImplementation(() => { throw new Error('flight index unreadable') })

    expect(() => flightStore.fire()).not.toThrow()

    const rows = await inbox() as Array<{ id: string; unavailable?: boolean }>
    expect(rows).toEqual([expect.objectContaining({ id: active.id, unavailable: true })])
  })

  it('returns a bounded feature projection and reports a missing action', async () => {
    const active = (await app.inject('/api/notifications/feature/shop')).json()
    expect(active).toMatchObject({ feature: 'shop', attentionCount: 1, items: [expect.objectContaining({ state: 'attention' })] })

    flightStore.list.mockReturnValue([{ ...flight, status: 'running', pauseReason: undefined }])
    flightStore.fire()
    const resolved = (await app.inject('/api/notifications/feature/shop')).json()
    expect(resolved).toMatchObject({ attentionCount: 0, items: [expect.objectContaining({ state: 'resolved' })] })

    const missing = (await app.inject({ method: 'POST', url: '/api/notifications/not-here/resolve-action' })).json()
    expect(missing.status).toBe('missing')
  })

  it('does not replace a corrupt inbox with an empty success when refresh fails', async () => {
    fs.writeFileSync(path.join(dir, 'notifications', 'state.json'), '{invalid')

    expect((await app.inject('/api/notifications')).statusCode).toBe(500)
  })

  it('releases all three store subscriptions when the server closes', async () => {
    for (const store of [flightStore, runStore, dirtySpecStore]) expect(store.subscriberCount()).toBe(1)
    await app.close()
    for (const store of [flightStore, runStore, dirtySpecStore]) expect(store.subscriberCount()).toBe(0)
  })
})

it('settles a healthy Flight even when test source reads fail', async () => {
  const [active] = await inbox() as Array<{ id: string }>
  runStore.list.mockImplementation(() => { throw new Error('run source unavailable') })
  flightStore.list.mockReturnValue([{ ...flight, status: 'running', pauseReason: undefined }])
  flightStore.fire()
  expect(await inbox()).toEqual([expect.objectContaining({ id: active.id, resolvedAt: expect.any(String) })])
})
