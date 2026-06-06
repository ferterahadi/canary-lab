import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  openBrowser: vi.fn(),
}))

vi.mock('../apps/web-server/server', () => ({ createServer: mocks.createServer }))
vi.mock('../apps/web-server/lib/open-browser', () => ({ openBrowser: mocks.openBrowser }))

const { parsePort, runUi } = await import('./ui-command')

const originalBeforeExitListeners = process.listeners('beforeExit')
const originalSigintListeners = process.listeners('SIGINT')
const originalSigtermListeners = process.listeners('SIGTERM')

function restoreProcessListeners(): void {
  for (const listener of process.listeners('beforeExit')) {
    if (!originalBeforeExitListeners.includes(listener)) {
      process.removeListener('beforeExit', listener)
    }
  }
  for (const listener of process.listeners('SIGINT')) {
    if (!originalSigintListeners.includes(listener)) {
      process.removeListener('SIGINT', listener)
    }
  }
  for (const listener of process.listeners('SIGTERM')) {
    if (!originalSigtermListeners.includes(listener)) {
      process.removeListener('SIGTERM', listener)
    }
  }
}

beforeEach(() => {
  mocks.createServer.mockReset()
  mocks.openBrowser.mockReset()
})

afterEach(() => {
  restoreProcessListeners()
})

describe('runUi signal cleanup', () => {
  it('does not start the server when --port is passed', async () => {
    const exit = vi.fn()
    const messages: string[] = []

    await runUi(['--port', '8123'], {
      projectRoot: '/tmp/canary-lab-workspace',
      log: (msg) => { messages.push(msg) },
      exit,
    })

    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(messages[0]).toContain('was removed')
    expect(mocks.createServer).not.toHaveBeenCalled()
  })

  it('asks for confirmation before stopping active runs on SIGINT', async () => {
    const events: string[] = []
    const runStore = {
      abortAllActiveOrStale: vi.fn(async () => { events.push('abort-all') }),
    }
    const app = {
      listen: vi.fn(async () => {}),
      close: vi.fn(async () => { events.push('close') }),
    }
    const revertAllEnvsets = vi.fn(() => { events.push('revert') })
    const cancelAllWizardAgents = vi.fn(() => { events.push('cancel-wizard') })
    const exit = vi.fn((code: number) => { events.push(`exit-${code}`) })

    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets,
      cancelAllWizardAgents,
      runStore,
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], {
      projectRoot: '/tmp/canary-lab-workspace',
      log: () => {},
      exit,
      confirmShutdown: async () => {
        events.push('confirm')
        return true
      },
    })

    expect(app.listen).toHaveBeenCalledExactlyOnceWith({ port: 7421, host: '127.0.0.1' })

    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cancelAllWizardAgents).toHaveBeenCalledOnce()
    expect(runStore.abortAllActiveOrStale).toHaveBeenCalledOnce()
    expect(revertAllEnvsets).toHaveBeenCalledOnce()
    expect(app.close).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledExactlyOnceWith(130)
    expect(events).toEqual([
      'confirm',
      'cancel-wizard',
      'abort-all',
      'revert',
      'close',
      'exit-130',
    ])
  })

  it('keeps the UI running when SIGINT shutdown is cancelled', async () => {
    const messages: string[] = []
    const runStore = {
      abortAllActiveOrStale: vi.fn(),
    }
    const app = {
      listen: vi.fn(async () => {}),
      close: vi.fn(),
    }
    const revertAllEnvsets = vi.fn()
    const cancelAllWizardAgents = vi.fn()
    const exit = vi.fn()

    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets,
      cancelAllWizardAgents,
      runStore,
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], {
      projectRoot: '/tmp/canary-lab-workspace',
      log: (msg) => { messages.push(msg) },
      exit,
      confirmShutdown: async () => false,
    })

    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cancelAllWizardAgents).not.toHaveBeenCalled()
    expect(runStore.abortAllActiveOrStale).not.toHaveBeenCalled()
    expect(revertAllEnvsets).not.toHaveBeenCalled()
    expect(app.close).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(messages).toContain('Shutdown cancelled. Canary Lab is still running.')
  })
})

describe('runUi port resolution', () => {
  const tmpDirs: string[] = []
  function mkProject(config?: Record<string, unknown>): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ui-port-')))
    tmpDirs.push(dir)
    if (config) fs.writeFileSync(path.join(dir, 'canary-lab.config.json'), JSON.stringify(config))
    return dir
  }
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  })

  function mockServer() {
    const app = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets: vi.fn(),
      cancelAllWizardAgents: vi.fn(),
      runStore: { abortAllActiveOrStale: vi.fn() },
      brokers: new Map(),
      draftBrokers: new Map(),
    })
    return app
  }

  it('binds the port configured in the project canary-lab.config.json', async () => {
    const projectRoot = mkProject({ port: 8200 })
    const app = mockServer()

    await runUi(['--no-open'], { projectRoot, log: () => {}, exit: vi.fn(), registerWorkspace: () => {} })

    expect(app.listen).toHaveBeenCalledExactlyOnceWith({ port: 8200, host: '127.0.0.1' })
  })

  it('falls back to the default port when none is configured', async () => {
    const projectRoot = mkProject()
    const app = mockServer()

    await runUi(['--no-open'], { projectRoot, log: () => {}, exit: vi.fn(), registerWorkspace: () => {} })

    expect(app.listen).toHaveBeenCalledExactlyOnceWith({ port: 7421, host: '127.0.0.1' })
  })

  it('marks the workspace active on boot so the MCP bridge follows the running UI', async () => {
    const projectRoot = mkProject({ port: 8300 })
    mockServer()
    const registerWorkspace = vi.fn()

    await runUi(['--no-open'], { projectRoot, log: () => {}, exit: vi.fn(), registerWorkspace })

    expect(registerWorkspace).toHaveBeenCalledExactlyOnceWith(projectRoot)
  })

  it('relaunches the UI and shuts down when a port change is requested', async () => {
    const projectRoot = mkProject({ port: 8000 })
    let captured: ((port: number) => void) | undefined
    const app = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    mocks.createServer.mockImplementation(async (o: { onPortChange?: (p: number) => void }) => {
      captured = o.onPortChange
      return {
        app,
        registry: {},
        revertAllEnvsets: vi.fn(),
        cancelAllWizardAgents: vi.fn(),
        runStore: { abortAllActiveOrStale: vi.fn() },
        brokers: new Map(),
        draftBrokers: new Map(),
      }
    })
    const relaunch = vi.fn()
    const exit = vi.fn()

    await runUi(['--no-open'], {
      projectRoot,
      log: () => {},
      exit,
      registerWorkspace: () => {},
      relaunch,
      schedule: (fn) => { fn() },
    })

    expect(captured).toBeTypeOf('function')
    captured!(9000)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(relaunch).toHaveBeenCalledExactlyOnceWith(projectRoot)
    expect(app.close).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('reports the configured port when it is already in use', async () => {
    const projectRoot = mkProject({ port: 8400 })
    const messages: string[] = []
    const app = { listen: vi.fn(async () => { throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }) }), close: vi.fn(async () => {}) }
    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets: vi.fn(),
      cancelAllWizardAgents: vi.fn(),
      runStore: { abortAllActiveOrStale: vi.fn() },
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], { projectRoot, log: (m) => messages.push(m), exit: vi.fn(), registerWorkspace: () => {} })

    expect(messages.some((m) => m.includes('8400'))).toBe(true)
  })
})

describe('parsePort', () => {
  it('rejects removed --port forms', () => {
    const messages: string[] = []
    const exit = vi.fn()
    const opts = {
      log: (msg: string) => { messages.push(msg) },
      exit,
    }

    expect(parsePort(['--port'], opts)).toBe('removed-port-option')
    expect(parsePort(['--port=8123'], opts)).toBe('removed-port-option')

    expect(exit).toHaveBeenCalledTimes(2)
    expect(messages).toEqual([
      '`canary-lab ui --port` was removed. Set the port in canary-lab.config.json or the Project Settings dialog.',
      '`canary-lab ui --port` was removed. Set the port in canary-lab.config.json or the Project Settings dialog.',
    ])
  })
})
