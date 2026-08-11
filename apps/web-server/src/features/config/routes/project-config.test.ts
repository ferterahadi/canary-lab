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

async function makeApp(
  extra: Partial<Parameters<typeof projectConfigRoutes>[1]> = {},
): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(async (a) => {
    await projectConfigRoutes(a, { projectRoot, ...extra })
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
      expect(r.json()).toEqual({ healAgent: 'external', editor: 'auto', personalWikiPath: null , autoProposePr: true, showDemo: true})
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
      expect(r.json()).toEqual({ healAgent: 'manual', editor: 'auto', personalWikiPath: null , autoProposePr: true, showDemo: true})
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
      expect(written).toEqual({ healAgent: 'claude', editor: 'auto', personalWikiPath: null , autoProposePr: true, showDemo: true})
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
      expect(r.json()).toEqual({ healAgent: 'codex', editor: 'auto', personalWikiPath: null , autoProposePr: true, showDemo: true})
    } finally {
      await app.close()
    }
  })

  it('preserves a pinned port when an unrelated setting changes', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'canary-lab.config.json'),
      JSON.stringify({ healAgent: 'external', port: 7420 }),
    )
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/project-config',
        payload: { editor: 'cursor' },
      })
      expect(r.statusCode).toBe(200)
      const written = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'canary-lab.config.json'), 'utf-8'),
      )
      // `port` is settings-adjacent but never travels in this body: it is owned
      // by POST /api/project-config/port, which rebinds the server as it saves.
      // Dropping the pin here is silent — nothing rereads the file until the
      // next boot, which then lands on DEFAULT_PORT and strands every client
      // still pointed at the pinned one.
      expect(written.port).toBe(7420)
      expect(r.json().port).toBe(7420)
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
      expect(r.json()).toEqual({ healAgent: 'external', editor: 'cursor', personalWikiPath: null , autoProposePr: true, showDemo: true})
      const written = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'canary-lab.config.json'), 'utf-8'),
      )
      expect(written).toEqual({ healAgent: 'external', editor: 'cursor', personalWikiPath: null , autoProposePr: true, showDemo: true})
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

  it('writes the auto-PR preference and rejects a non-boolean', async () => {
    const app = await makeApp()
    try {
      const off = await app.inject({ method: 'PUT', url: '/api/project-config', payload: { autoProposePr: false } })
      expect(off.statusCode).toBe(200)
      expect(off.json().autoProposePr).toBe(false)

      // Omitting it preserves the stored choice rather than silently re-enabling
      // a push the user turned off.
      const other = await app.inject({ method: 'PUT', url: '/api/project-config', payload: { editor: 'vscode' } })
      expect(other.json().autoProposePr).toBe(false)

      const bad = await app.inject({ method: 'PUT', url: '/api/project-config', payload: { autoProposePr: 'yes' } })
      expect(bad.statusCode).toBe(400)
      expect(bad.json()).toEqual({ error: 'autoProposePr must be a boolean' })
    } finally {
      await app.close()
    }
  })

  it('writes the show-demo preference and rejects a non-boolean', async () => {
    const app = await makeApp()
    try {
      const off = await app.inject({ method: 'PUT', url: '/api/project-config', payload: { showDemo: false } })
      expect(off.statusCode).toBe(200)
      expect(off.json().showDemo).toBe(false)

      // Omitting it preserves the stored choice — saving an unrelated setting
      // must not put the demos back in a status bar the user cleared.
      const other = await app.inject({ method: 'PUT', url: '/api/project-config', payload: { editor: 'vscode' } })
      expect(other.json().showDemo).toBe(false)

      const bad = await app.inject({ method: 'PUT', url: '/api/project-config', payload: { showDemo: 'no' } })
      expect(bad.statusCode).toBe(400)
      expect(bad.json()).toEqual({ error: 'showDemo must be a boolean' })
    } finally {
      await app.close()
    }
  })

  it('announces a persisted write so every open client refetches', async () => {
    const publish = vi.fn()
    const app = await makeApp({ workspaceEvents: { publish } })
    try {
      await app.inject({ method: 'PUT', url: '/api/project-config', payload: { showDemo: false } })
      expect(publish).toHaveBeenCalledWith({ type: 'project-config-changed' })
    } finally {
      await app.close()
    }
  })

  it('stays silent when the write is rejected — a 400 changed nothing', async () => {
    const publish = vi.fn()
    const app = await makeApp({ workspaceEvents: { publish } })
    try {
      const bad = await app.inject({ method: 'PUT', url: '/api/project-config', payload: { showDemo: 'no' } })
      expect(bad.statusCode).toBe(400)
      expect(publish).not.toHaveBeenCalled()
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
        autoProposePr: true,
        showDemo: true,
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
