import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'

const spawnMock = vi.fn((_command: string, _args: readonly string[], _options?: unknown) => ({
  unref: vi.fn(),
}))

const spawnSyncMock = vi.fn(
  (_command: string, _args: readonly string[], _options?: unknown) => ({ status: 1 }),
)

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock }
})

const { projectConfigRoutes } = await import('./project-config')

let projectRoot: string

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pcfg-')))
  spawnMock.mockClear()
  spawnSyncMock.mockClear()
  spawnSyncMock.mockReturnValue({ status: 1 })
})

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('POST /api/project-config/port', () => {
  async function makePortApp(deps: { countActiveRuns?: () => number; onPortChange?: (port: number) => void } = {}): Promise<FastifyInstance> {
    const app = Fastify()
    await app.register(async (a) => {
      await projectConfigRoutes(a, { projectRoot, ...deps })
    })
    await app.ready()
    return app
  }

  function readConfig() {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'canary-lab.config.json'), 'utf-8'))
  }

  it('rejects an invalid port', async () => {
    const app = await makePortApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/project-config/port', payload: { port: 99999 } })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('short-circuits when the port is unchanged', async () => {
    fs.writeFileSync(path.join(projectRoot, 'canary-lab.config.json'), JSON.stringify({ port: 8200 }))
    const onPortChange = vi.fn()
    const app = await makePortApp({ onPortChange })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/project-config/port', payload: { port: 8200 } })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ restarting: false })
      expect(onPortChange).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('treats active runs as zero when no countActiveRuns dep is provided', async () => {
    const onPortChange = vi.fn()
    // No countActiveRuns → `deps.countActiveRuns?.() ?? 0` → 0 → no confirm gate.
    const app = await makePortApp({ onPortChange })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/project-config/port', payload: { port: 8300 } })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ restarting: true, port: 8300 })
    } finally {
      await app.close()
    }
  })

  it('requires confirmation when runs are active', async () => {
    const onPortChange = vi.fn()
    const app = await makePortApp({ countActiveRuns: () => 2, onPortChange })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/project-config/port', payload: { port: 8300 } })
      expect(r.statusCode).toBe(409)
      expect(r.json()).toMatchObject({ needsConfirm: true, activeRuns: 2 })
      expect(onPortChange).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(projectRoot, 'canary-lab.config.json'))).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('saves the new port, returns the new origin, and triggers the restart hook', async () => {
    const onPortChange = vi.fn()
    const app = await makePortApp({ countActiveRuns: () => 0, onPortChange })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/project-config/port', payload: { port: 8300 } })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ restarting: true, port: 8300, newOrigin: 'http://localhost:8300' })
      expect(readConfig().port).toBe(8300)
      expect(onPortChange).toHaveBeenCalledExactlyOnceWith(8300)
    } finally {
      await app.close()
    }
  })

  it('proceeds past the active-run guard when confirm is true', async () => {
    const onPortChange = vi.fn()
    const app = await makePortApp({ countActiveRuns: () => 3, onPortChange })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/project-config/port', payload: { port: 8400, confirm: true } })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ restarting: true, port: 8400 })
      expect(readConfig().port).toBe(8400)
      expect(onPortChange).toHaveBeenCalledExactlyOnceWith(8400)
    } finally {
      await app.close()
    }
  })
})
