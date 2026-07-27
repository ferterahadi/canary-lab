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
  spawnMock.mockClear()
  spawnSyncMock.mockClear()
  spawnSyncMock.mockReturnValue({ status: 1 })
})

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('POST /api/open-editor', () => {
  function writeSpec(name = 'a.spec.ts'): string {
    const file = path.join(projectRoot, name)
    fs.writeFileSync(file, "test('a', async () => {})\n")
    return file
  }

  it('rejects missing files in the request body', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: {},
      })
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({ error: 'file is required' })
    } finally {
      await app.close()
    }
  })

  it('rejects a missing request body', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
      })
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({ error: 'file is required' })
    } finally {
      await app.close()
    }
  })

  it('rejects relative paths', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file: 'a.spec.ts' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('rejects paths outside the project root', async () => {
    const outside = path.join(fs.realpathSync(os.tmpdir()), `outside-${Date.now()}.spec.ts`)
    fs.writeFileSync(outside, "test('outside', async () => {})\n")
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file: outside },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      fs.rmSync(outside, { force: true })
      await app.close()
    }
  })

  it('rejects missing files', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file: path.join(projectRoot, 'missing.spec.ts') },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('rejects directories inside the project root', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file: projectRoot },
      })
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({ error: 'file must be a file' })
    } finally {
      await app.close()
    }
  })

  it('rejects invalid editor values', async () => {
    const file = writeSpec()
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, editor: 'vim' },
      })
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({ error: 'editor must be one of: auto, vscode, cursor, system' })
    } finally {
      await app.close()
    }
  })

  it('uses cursor -g when editor is cursor', async () => {
    const file = writeSpec()
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, line: 12, column: 3, editor: 'cursor' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'cursor' })
      expect(spawnMock).toHaveBeenCalledWith('cursor', ['-g', `${file}:12:3`], expect.any(Object))
    } finally {
      await app.close()
    }
  })

  it('uses code -g when editor is vscode', async () => {
    const file = writeSpec()
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, line: 2, editor: 'vscode' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'vscode' })
      expect(spawnMock).toHaveBeenCalledWith('code', ['-g', `${file}:2:1`], expect.any(Object))
    } finally {
      await app.close()
    }
  })

  it('falls back to the platform opener for system', async () => {
    const file = writeSpec()
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, line: 2, editor: 'system' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'system' })
      expect(spawnMock).toHaveBeenCalledWith('open', [file], expect.any(Object))
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
      await app.close()
    }
  })

  it('uses cmd start for the system opener on windows', async () => {
    const file = writeSpec()
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, editor: 'system' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'system' })
      expect(spawnMock).toHaveBeenCalledWith('cmd', ['/c', 'start', '', file], expect.any(Object))
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
      await app.close()
    }
  })

  it('uses xdg-open for the system opener on linux', async () => {
    const file = writeSpec()
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, editor: 'system' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'system' })
      expect(spawnMock).toHaveBeenCalledWith('xdg-open', [file], expect.any(Object))
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
      await app.close()
    }
  })

  it('auto-detects cursor before vscode', async () => {
    const file = writeSpec()
    spawnSyncMock.mockImplementation((command, args) => ({
      status: command === 'which' && args[0] === 'cursor' ? 0 : 1,
    }))
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, editor: 'auto' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'cursor' })
      expect(spawnMock.mock.calls[0][0]).toBe('cursor')
    } finally {
      await app.close()
    }
  })

  it('uses the configured editor when the request omits one', async () => {
    const file = writeSpec()
    fs.writeFileSync(
      path.join(projectRoot, 'canary-lab.config.json'),
      JSON.stringify({ editor: 'cursor' }),
    )
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'cursor' })
      expect(spawnMock.mock.calls[0][0]).toBe('cursor')
    } finally {
      await app.close()
    }
  })

  it('auto-detects vscode when cursor is unavailable', async () => {
    const file = writeSpec()
    spawnSyncMock.mockImplementation((command, args) => ({
      status: command === 'which' && args[0] === 'code' ? 0 : 1,
    }))
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, editor: 'auto' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'vscode' })
      expect(spawnMock.mock.calls[0][0]).toBe('code')
    } finally {
      await app.close()
    }
  })

  it('auto-detects the system opener when cli editors are unavailable', async () => {
    const file = writeSpec()
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    spawnSyncMock.mockReturnValue({ status: 1 })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, editor: 'auto' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'system' })
      expect(spawnMock).toHaveBeenCalledWith('open', [file], expect.any(Object))
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
      await app.close()
    }
  })

  it('uses where for auto-detection on windows', async () => {
    const file = writeSpec()
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    spawnSyncMock.mockImplementation((command, args) => ({
      status: command === 'where' && args[0] === 'cursor' ? 0 : 1,
    }))
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, editor: 'auto' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ opened: true, editor: 'cursor' })
      expect(spawnSyncMock.mock.calls[0][0]).toBe('where')
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
      await app.close()
    }
  })

  it('returns 500 when spawning the editor throws', async () => {
    const file = writeSpec()
    spawnMock.mockImplementationOnce(() => { throw new Error('boom') })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/open-editor',
        payload: { file, editor: 'cursor' },
      })
      expect(r.statusCode).toBe(500)
      expect(r.json()).toEqual({ error: 'boom' })
    } finally {
      await app.close()
    }
  })

})

describe('POST /api/open-workspace', () => {
  it('opens the project root in the configured editor', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/open-workspace' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { opened: boolean; path: string; editor: string }
      expect(body.opened).toBe(true)
      expect(body.path).toBe(projectRoot)
      expect(spawnMock).toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('respects the configured editor choice', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'canary-lab.config.json'),
      JSON.stringify({ editor: 'cursor' }),
    )
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/open-workspace' })
      expect(r.statusCode).toBe(200)
      expect(spawnMock).toHaveBeenCalledWith('cursor', [projectRoot], expect.anything())
    } finally {
      await app.close()
    }
  })

  it('returns opened:false instead of erroring when the launch throws', async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error('boom') })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/open-workspace' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { opened: boolean; error?: string }
      expect(body.opened).toBe(false)
      expect(body.error).toBe('boom')
    } finally {
      await app.close()
    }
  })

  it('stringifies a non-Error throw from the launch', async () => {
    spawnMock.mockImplementationOnce(() => { throw 'boom-string' })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/open-workspace' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { opened: boolean; error?: string }
      expect(body.opened).toBe(false)
      expect(body.error).toBe('boom-string')
    } finally {
      await app.close()
    }
  })
})
