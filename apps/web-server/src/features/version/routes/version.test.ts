import { describe, it, expect, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { versionRoutes, type VersionRouteDeps } from './version'
import { UpdateJobConflictError, type InstallRunner, type UpdateJobStore } from '../logic/update-job'
import type { VersionState, VersionStatus } from '../logic/version-state'

async function makeApp(deps: VersionRouteDeps): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(async (a) => {
    await versionRoutes(a, deps)
  })
  await app.ready()
  return app
}

const baseStatus = (over: Partial<VersionStatus> = {}): VersionStatus => ({
  current: '1.4.1',
  latest: '1.4.2',
  updateAvailable: true,
  packageName: 'canary-lab',
  update: null,
  ...over,
})

/** A fake store that never reports a running job (no single-flight conflict). */
const idleStore = () => ({ current: () => null, save: () => {} }) as unknown as UpdateJobStore

describe('GET /api/version', () => {
  it('lazily refreshes when latest is still null, then returns status', async () => {
    let latest: string | null = null
    const refresh = vi.fn(async () => { latest = '1.4.2' })
    const state = {
      status: () => baseStatus({ latest }),
      refresh,
      pendingTarget: () => null,
    } as unknown as VersionState
    const app = await makeApp({ projectRoot: '/x', state, updateStore: idleStore() })
    try {
      const r = await app.inject({ method: 'GET', url: '/api/version' })
      expect(r.statusCode).toBe(200)
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(r.json()).toMatchObject({ latest: '1.4.2' })
    } finally {
      await app.close()
    }
  })

  it('skips the refresh when latest is already resolved', async () => {
    const refresh = vi.fn(async () => {})
    const state = {
      status: () => baseStatus({ latest: '1.4.2' }),
      refresh,
      pendingTarget: () => null,
    } as unknown as VersionState
    const app = await makeApp({ projectRoot: '/x', state, updateStore: idleStore() })
    try {
      const r = await app.inject({ method: 'GET', url: '/api/version' })
      expect(r.statusCode).toBe(200)
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})

describe('POST /api/version/update', () => {
  it('409s when nothing newer is available', async () => {
    const state = {
      status: () => baseStatus(),
      refresh: async () => {},
      pendingTarget: () => null,
    } as unknown as VersionState
    const app = await makeApp({ projectRoot: '/x', state, updateStore: idleStore() })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/version/update' })
      expect(r.statusCode).toBe(409)
      expect(r.json()).toMatchObject({ error: expect.stringContaining('latest') })
    } finally {
      await app.close()
    }
  })

  it('409s when the package name cannot be resolved', async () => {
    const state = {
      status: () => baseStatus({ packageName: null }),
      refresh: async () => {},
      pendingTarget: () => '1.4.2',
    } as unknown as VersionState
    const app = await makeApp({ projectRoot: '/x', state, updateStore: idleStore() })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/version/update' })
      expect(r.statusCode).toBe(409)
      expect(r.json()).toMatchObject({ error: expect.stringContaining('package name') })
    } finally {
      await app.close()
    }
  })

  it('202s with the running manifest on a successful kickoff', async () => {
    const saved: unknown[] = []
    const store = {
      current: () => null,
      save: (m: unknown) => { saved.push(m) },
    } as unknown as UpdateJobStore
    const state = {
      status: () => baseStatus(),
      refresh: async () => {},
      pendingTarget: () => '1.4.2',
    } as unknown as VersionState
    const run: InstallRunner = async () => 0
    const app = await makeApp({ projectRoot: '/x', state, updateStore: store, run })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/version/update' })
      expect(r.statusCode).toBe(202)
      expect(r.json()).toMatchObject({ status: 'running', targetVersion: '1.4.2' })
    } finally {
      await app.close()
    }
  })

  it('409s when an update is already in progress', async () => {
    const store = {
      current: () => ({ status: 'running' }),
      save: () => {},
    } as unknown as UpdateJobStore
    const state = {
      status: () => baseStatus(),
      refresh: async () => {},
      pendingTarget: () => '1.4.2',
    } as unknown as VersionState
    const app = await makeApp({ projectRoot: '/x', state, updateStore: store })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/version/update' })
      expect(r.statusCode).toBe(409)
      expect(r.json()).toMatchObject({ error: new UpdateJobConflictError().message })
    } finally {
      await app.close()
    }
  })

  it('rethrows a non-conflict error from the job start (500)', async () => {
    const store = {
      current: () => null,
      save: () => { throw new Error('disk full') },
    } as unknown as UpdateJobStore
    const state = {
      status: () => baseStatus(),
      refresh: async () => {},
      pendingTarget: () => '1.4.2',
    } as unknown as VersionState
    const app = await makeApp({ projectRoot: '/x', state, updateStore: store })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/version/update' })
      expect(r.statusCode).toBe(500)
    } finally {
      await app.close()
    }
  })
})

// The install job announces itself from its own record (the store-owns-its-events
// rule). Every case above wires the routes WITHOUT a bus, so `bridgeStoreEvents`
// returns before subscribing and the mapper never runs — leaving the one rule
// that keeps an install from spamming the workspace untested.
describe('version-changed bridging', () => {
  /** A store whose events can be driven, unlike the inert `idleStore`. */
  function drivableStore(status: () => string | null) {
    const listeners = new Set<() => void>()
    return {
      store: {
        current: () => (status() === null ? null : { status: status() }),
        save: () => {},
        onEvent: (fn: () => void) => { listeners.add(fn) },
        offEvent: (fn: () => void) => { listeners.delete(fn) },
      } as unknown as UpdateJobStore,
      emit: () => { for (const fn of listeners) fn() },
    }
  }

  const state = () => ({
    status: () => baseStatus(),
    refresh: async () => {},
    pendingTarget: () => null,
  } as unknown as VersionState)

  it('stays silent while the install is still running', async () => {
    const events: unknown[] = []
    const { store, emit } = drivableStore(() => 'running')
    const app = await makeApp({
      projectRoot: '/x', state: state(), updateStore: store,
      workspaceEvents: { publish: (e) => events.push(e) },
    })
    try {
      // The runner saves on every chunk of npm output. Broadcasting those would
      // make each client refetch /api/version dozens of times per install to
      // learn nothing it renders.
      emit(); emit(); emit()
      expect(events).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('announces the job once it settles', async () => {
    const events: unknown[] = []
    let status: string | null = 'running'
    const { store, emit } = drivableStore(() => status)
    const app = await makeApp({
      projectRoot: '/x', state: state(), updateStore: store,
      workspaceEvents: { publish: (e) => events.push(e) },
    })
    try {
      emit()
      expect(events).toEqual([])
      status = 'done'
      emit()
      expect(events).toEqual([{ type: 'version-changed' }])
    } finally {
      await app.close()
    }
  })

  it('announces a job whose record is gone, rather than going quiet', async () => {
    const events: unknown[] = []
    const { store, emit } = drivableStore(() => null)
    const app = await makeApp({
      projectRoot: '/x', state: state(), updateStore: store,
      workspaceEvents: { publish: (e) => events.push(e) },
    })
    try {
      // `current()` is null — not running, so the client is told to refetch.
      emit()
      expect(events).toEqual([{ type: 'version-changed' }])
    } finally {
      await app.close()
    }
  })
})
