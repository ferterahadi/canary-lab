import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'

const spawnMock = vi.fn(() => ({ unref: vi.fn() }))
const spawnSyncMock = vi.fn(() => ({ status: 1 }))
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

describe('GET /api/project-config', () => {
  it('returns the default config when canary-lab.config.json is missing', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/project-config' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ healAgent: 'external', editor: 'auto', personalWikiPath: null })
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
      expect(r.json()).toEqual({ healAgent: 'manual', editor: 'auto', personalWikiPath: null })
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
      expect(written).toEqual({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
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
      expect(r.json()).toEqual({ healAgent: 'codex', editor: 'auto', personalWikiPath: null })
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

  it('writes and preserves the editor preference', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { editor: 'cursor' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ healAgent: 'external', editor: 'cursor', personalWikiPath: null })
      const written = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'canary-lab.config.json'), 'utf-8'),
      )
      expect(written).toEqual({ healAgent: 'external', editor: 'cursor', personalWikiPath: null })
    } finally {
      await app.close()
    }
  })

  it('rejects an invalid editor value', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { editor: 'vim' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('writes a normalized personal wiki directory path', async () => {
    const wiki = path.join(projectRoot, 'wiki')
    fs.mkdirSync(wiki)
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { personalWikiPath: wiki },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({
        healAgent: 'external',
        editor: 'auto',
        personalWikiPath: fs.realpathSync(wiki),
      })
    } finally {
      await app.close()
    }
  })

  it('does not create agent docs when personal wiki path is set', async () => {
    const wiki = path.join(projectRoot, 'wiki')
    fs.mkdirSync(wiki)
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { personalWikiPath: wiki },
      })
      expect(r.statusCode).toBe(200)
      expect(fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))).toBe(false)
      expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('expands ~ for personal wiki path input', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { personalWikiPath: '~' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json().personalWikiPath).toBe(fs.realpathSync(os.homedir()))
    } finally {
      await app.close()
    }
  })

  it('clears the personal wiki path with null or empty string', async () => {
    const wiki = path.join(projectRoot, 'wiki')
    fs.mkdirSync(wiki)
    fs.writeFileSync(
      path.join(projectRoot, 'canary-lab.config.json'),
      JSON.stringify({ personalWikiPath: wiki }),
    )
    const app = await makeApp()
    try {
      const r1 = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { personalWikiPath: null },
      })
      expect(r1.statusCode).toBe(200)
      expect(r1.json().personalWikiPath).toBe(null)
      expect(fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))).toBe(false)
      expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(false)

      const r2 = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { personalWikiPath: '' },
      })
      expect(r2.statusCode).toBe(200)
      expect(r2.json().personalWikiPath).toBe(null)
    } finally {
      await app.close()
    }
  })

  it('rejects non-string personal wiki path values', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { personalWikiPath: 123 },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('rejects missing, relative, and non-directory personal wiki paths', async () => {
    const file = path.join(projectRoot, 'note.md')
    fs.writeFileSync(file, 'x')
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'original claude')
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'original agents')
    const app = await makeApp()
    try {
      for (const personalWikiPath of [path.join(projectRoot, 'missing'), 'relative/wiki', file]) {
        const r = await app.inject({
          method: 'PUT',
          url: '/api/project-config',
          payload: { personalWikiPath },
        })
        expect(r.statusCode).toBe(400)
      }
      expect(fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf-8')).toBe('original claude')
      expect(fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf-8')).toBe('original agents')
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

  it('uses cmd /c start on win32', async () => {
    spawnMock.mockClear()
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const app = await makeApp()
      try {
        const r = await app.inject({
          method: 'POST',
          url: '/api/open-agent',
          payload: { agent: 'claude' },
        })
        expect(r.statusCode).toBe(200)
        expect(spawnMock.mock.calls[0][0]).toBe('cmd')
      } finally {
        await app.close()
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('falls back to lowercased binary on linux', async () => {
    spawnMock.mockClear()
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const app = await makeApp()
      try {
        const r = await app.inject({
          method: 'POST',
          url: '/api/open-agent',
          payload: { agent: 'codex' },
        })
        expect(r.statusCode).toBe(200)
        expect(spawnMock.mock.calls[0][0]).toBe('codex')
      } finally {
        await app.close()
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
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
