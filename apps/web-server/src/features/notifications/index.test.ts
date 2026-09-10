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
    logsDir: dir, workspaceEvents: { publish: vi.fn() }, flightStore, runStore, dirtySpecStore,
  } as unknown as ServerContext)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const inbox = async (): Promise<unknown[]> => (await app.inject('/api/notifications')).json()

describe('notifications feature registrar', () => {
  it('keeps serving the inbox it already built when a store read fails, rather than throwing into the event that triggered the rebuild', async () => {
    expect(await inbox()).toHaveLength(1)
    const logged = vi.spyOn(app.log, 'error')
    runStore.list.mockImplementation(() => { throw new Error('runs index unreadable') })

    // The event arrives mid-run. Letting the rebuild throw here would surface
    // as that run failing, for a reason that has nothing to do with the run.
    expect(() => runStore.fire()).not.toThrow()

    expect(logged).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Could not update notifications')
    // And the last good inbox is still served — a failed rebuild must not read
    // to the user as "you have no notifications".
    expect(await inbox()).toHaveLength(1)
  })

  it('releases all three store subscriptions when the server closes', async () => {
    for (const store of [flightStore, runStore, dirtySpecStore]) expect(store.subscriberCount()).toBe(1)
    await app.close()
    for (const store of [flightStore, runStore, dirtySpecStore]) expect(store.subscriberCount()).toBe(0)
  })
})
