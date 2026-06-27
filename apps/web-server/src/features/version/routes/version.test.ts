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
