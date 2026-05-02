import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'

const spawnMock = vi.fn(() => ({ unref: vi.fn() }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: spawnMock }
})

const { projectConfigRoutes } = await import('./project-config')

let projectRoot: string

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(async (a) => {
    await projectConfigRoutes(a, { projectRoot })
  })
  await app.ready()
  return app
}

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pcfg-')))
})

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('GET /api/project-config', () => {
  it('returns the default config when canary-lab.config.json is missing', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/project-config' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ healAgent: 'auto' })
    } finally {
      await app.close()
    }
  })

  it('reads an existing config file', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'canary-lab.config.json'),
      JSON.stringify({ healAgent: 'manual' }),
    )
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/project-config' })
      expect(r.json()).toEqual({ healAgent: 'manual' })
    } finally {
      await app.close()
    }
  })
})

describe('PUT /api/project-config', () => {
  it('writes a new healAgent value to disk', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { healAgent: 'claude' },
      })
      expect(r.statusCode).toBe(200)
      const written = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'canary-lab.config.json'), 'utf-8'),
      )
      expect(written).toEqual({ healAgent: 'claude' })
    } finally {
      await app.close()
    }
  })

  it('preserves the existing value when healAgent is omitted', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'canary-lab.config.json'),
      JSON.stringify({ healAgent: 'codex' }),
    )
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: {},
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ healAgent: 'codex' })
    } finally {
      await app.close()
    }
  })

  it('rejects an invalid healAgent value', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { healAgent: 'gpt' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})

describe('POST /api/open-agent', () => {
  it('rejects an unknown agent value', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-agent',
        payload: { agent: 'gpt' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('accepts a valid agent (best-effort spawn)', async () => {
    spawnMock.mockClear()
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-agent',
        payload: { agent: 'claude' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true })
      expect(spawnMock).toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('handles spawn throwing as a 500', async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error('boom') })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-agent',
        payload: { agent: 'codex' },
      })
      expect(r.statusCode).toBe(500)
    } finally {
      await app.close()
    }
  })
})
