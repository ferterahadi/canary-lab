import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  openBrowser: vi.fn(),
}))

vi.mock('../web-server/src/server', () => ({ createServer: mocks.createServer }))
vi.mock('../web-server/src/shared/open-browser', () => ({ openBrowser: mocks.openBrowser }))

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

let agentHome: string | undefined
let priorAgentHome: string | undefined
// A valid Canary Lab workspace (has a `features/` dir) so runUi's
// enabled-workspace guard passes for lifecycle tests.
let wsRoot: string

beforeEach(() => {
  mocks.createServer.mockReset()
  mocks.openBrowser.mockReset()
  // Point the boot-time skill refresh at a throwaway home so it can never touch
  // the developer's real ~/.claude during the test run. The temp home has no
  // installed skill, so refreshInstalled() is a guaranteed no-op.
  priorAgentHome = process.env.CANARY_LAB_AGENT_HOME
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-home-'))
  process.env.CANARY_LAB_AGENT_HOME = agentHome
  wsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ui-ws-')))
  fs.mkdirSync(path.join(wsRoot, 'features'))
  fs.writeFileSync(path.join(wsRoot, 'package.json'), JSON.stringify({ devDependencies: { 'canary-lab': 'file:x' } }))
})

afterEach(() => {
  restoreProcessListeners()
  vi.unstubAllEnvs()
  if (priorAgentHome === undefined) delete process.env.CANARY_LAB_AGENT_HOME
  else process.env.CANARY_LAB_AGENT_HOME = priorAgentHome
  if (agentHome) { fs.rmSync(agentHome, { recursive: true, force: true }); agentHome = undefined }
  if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true })
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
    const exit = vi.fn((code: number) => { events.push(`exit-${code}`) })
    const clearActiveServer = vi.fn()
    const stopAgents = vi.fn(async () => { events.push('stop-agents') })

    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets,
      runStore,
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], {
      projectRoot: wsRoot,
      log: () => {},
      exit,
      recordActiveServer: () => {},
      clearActiveServer,
      stopAgents,
      confirmShutdown: async () => {
        events.push('confirm')
        return true
      },
    })

    expect(app.listen).toHaveBeenCalledExactlyOnceWith({ port: 7421, host: '127.0.0.1' })

    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(clearActiveServer).toHaveBeenCalledOnce()
    expect(runStore.abortAllActiveOrStale).toHaveBeenCalledOnce()
    expect(revertAllEnvsets).toHaveBeenCalledOnce()
    expect(stopAgents).toHaveBeenCalledOnce()
    expect(app.close).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledExactlyOnceWith(130)
    // The order is the contract, not an accident. Envsets revert first because it
    // is synchronous and safety-critical (a forced exit must not strand `.env` on
    // prod); agents die next, because an agent mid-edit is more invasive than a
    // run; runs last.
    expect(events).toEqual([
      'confirm',
      'revert',
      'stop-agents',
      'abort-all',
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
    const exit = vi.fn()

    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets,
      runStore,
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], {
      projectRoot: wsRoot,
      log: (msg) => { messages.push(msg) },
      exit,
      recordActiveServer: () => {},
      clearActiveServer: () => {},
      confirmShutdown: async () => false,
    })

    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runStore.abortAllActiveOrStale).not.toHaveBeenCalled()
    expect(revertAllEnvsets).not.toHaveBeenCalled()
    expect(app.close).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(messages).toContain('Shutdown cancelled. Canary Lab is still running.')
  })

  it('forces exit when graceful shutdown stalls past the timeout', async () => {
    const messages: string[] = []
    // app.close() never resolves — simulates a socket that won't drain.
    const runStore = { abortAllActiveOrStale: vi.fn(async () => {}) }
    const app = {
      listen: vi.fn(async () => {}),
      close: vi.fn(() => new Promise<void>(() => { /* never resolves */ })),
    }
    const revertAllEnvsets = vi.fn()
    const exit = vi.fn()

    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets,
      runStore,
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], {
      projectRoot: wsRoot,
      log: (msg) => { messages.push(msg) },
      exit,
      recordActiveServer: () => {},
      clearActiveServer: () => {},
      confirmShutdown: async () => true,
      shutdownTimeoutMs: 20,
    })

    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 80))

    // The safety-critical envset revert still ran before the stall, and the
    // watchdog forced the process out despite app.close() hanging.
    expect(revertAllEnvsets).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
    expect(messages).toContain('Shutdown is taking longer than expected; forcing exit.')
  })

  it('runs one graceful shutdown when SIGINT and SIGTERM arrive together', async () => {
    const events: string[] = []
    let releaseStopAgents!: () => void
    const stopAgents = vi.fn(() => new Promise<void>((resolve) => { releaseStopAgents = resolve }))
    const runStore = { abortAllActiveOrStale: vi.fn(async () => { events.push('abort-all') }) }
    const app = {
      listen: vi.fn(async () => {}),
      close: vi.fn(async () => { events.push('close') }),
    }
    const exit = vi.fn((code: number) => { events.push(`exit-${code}`) })

    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets: vi.fn(),
      runStore,
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], {
      projectRoot: wsRoot,
      log: () => {},
      exit,
      recordActiveServer: () => {},
      clearActiveServer: () => {},
      stopAgents,
      confirmShutdown: async () => true,
    })

    process.emit('SIGINT')
    await vi.waitFor(() => expect(stopAgents).toHaveBeenCalledOnce())
    process.emit('SIGTERM')
    releaseStopAgents()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())

    expect(runStore.abortAllActiveOrStale).toHaveBeenCalledOnce()
    expect(app.close).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledExactlyOnceWith(130)
    expect(events).toEqual(['abort-all', 'close', 'exit-130'])
  })

  it('skips the stdin confirmation when its parent owns demo shutdown', async () => {
    vi.stubEnv('CANARY_LAB_PARENT_OWNS_SHUTDOWN', '1')
    const runStore = { abortAllActiveOrStale: vi.fn(async () => {}) }
    const app = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    const exit = vi.fn()

    mocks.createServer.mockResolvedValue({
      app,
      registry: {},
      revertAllEnvsets: vi.fn(),
      runStore,
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], {
      projectRoot: wsRoot,
      log: () => {},
      exit,
      recordActiveServer: () => {},
      clearActiveServer: () => {},
    })

    process.emit('SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(130))

    expect(runStore.abortAllActiveOrStale).toHaveBeenCalledOnce()
    expect(app.close).toHaveBeenCalledOnce()
  })
})

describe('runUi port resolution', () => {
  const tmpDirs: string[] = []
  function mkProject(config?: Record<string, unknown>): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ui-port-')))
    tmpDirs.push(dir)
    // A real workspace declares canary-lab as a dependency (what `init` writes);
    // the boot guard requires that, not merely a `features/` dir.
    fs.mkdirSync(path.join(dir, 'features'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { 'canary-lab': 'file:x' } }))
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
      runStore: { abortAllActiveOrStale: vi.fn() },
      brokers: new Map(),
      draftBrokers: new Map(),
    })
    return app
  }

  const noopActiveServer = { recordActiveServer: () => {}, clearActiveServer: () => {} }

  it('binds the port configured in the project canary-lab.config.json', async () => {
    const projectRoot = mkProject({ port: 8200 })
    const app = mockServer()

    await runUi(['--no-open'], { projectRoot, log: () => {}, exit: vi.fn(), ...noopActiveServer })

    expect(app.listen).toHaveBeenCalledExactlyOnceWith({ port: 8200, host: '127.0.0.1' })
  })

  it('falls back to the default port when none is configured', async () => {
    const projectRoot = mkProject()
    const app = mockServer()

    await runUi(['--no-open'], { projectRoot, log: () => {}, exit: vi.fn(), ...noopActiveServer })

    expect(app.listen).toHaveBeenCalledExactlyOnceWith({ port: 7421, host: '127.0.0.1' })
  })

  it('refuses to boot in a dir with a stray features/ but no canary-lab dependency, and never writes the registry', async () => {
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ui-home-')))
    tmpDirs.push(homeDir)
    vi.stubEnv('CANARY_LAB_HOME', homeDir)
    vi.stubEnv('CANARY_LAB_AGENT_HOME', homeDir)
    // Mirrors the real bug: a dir that happens to have features/ (e.g. a feature
    // accidentally scaffolded into ~) but is NOT an init'd workspace.
    const strayDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ui-stray-')))
    tmpDirs.push(strayDir)
    fs.mkdirSync(path.join(strayDir, 'features'))
    const app = mockServer()
    const exit = vi.fn()
    const messages: string[] = []

    await runUi(['--no-open'], { projectRoot: strayDir, log: (m) => messages.push(m), exit, ...noopActiveServer })

    expect(app.listen).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(messages.some((m) => m.includes('canary-lab init'))).toBe(true)
    expect(fs.existsSync(path.join(homeDir, '.canary-lab', 'workspaces.json'))).toBe(false)
    vi.unstubAllEnvs()
  })

  it('refuses to boot in the canary-lab source checkout, which has the marker but no features/', async () => {
    // The mirror image of the stray-features case above, and the one that
    // actually bit: `isCanaryLabWorkspace` is true for a package.json named
    // `canary-lab`, so the source tree passed the marker check while having no
    // features/ at all. A UI booted there answers `list_features` with `[]`.
    const checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ui-checkout-')))
    tmpDirs.push(checkout)
    fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'canary-lab' }))
    const app = mockServer()
    const exit = vi.fn()
    const messages: string[] = []

    await runUi(['--no-open'], { projectRoot: checkout, log: (m) => messages.push(m), exit, ...noopActiveServer })

    expect(app.listen).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(messages.some((m) => m.includes('canary-lab init'))).toBe(true)
  })

  it('records the live server with its bound port once it is listening', async () => {
    const projectRoot = mkProject({ port: 8300 })
    mockServer()
    const recordActiveServer = vi.fn()

    await runUi(['--no-open'], { projectRoot, log: () => {}, exit: vi.fn(), recordActiveServer, clearActiveServer: () => {} })

    expect(recordActiveServer).toHaveBeenCalledExactlyOnceWith(projectRoot, 8300)
  })

  it('refreshes the installed agent skill on boot so it tracks the package version', async () => {
    const projectRoot = mkProject()
    mockServer()
    const refreshAgents = vi.fn()

    await runUi(['--no-open'], { projectRoot, log: () => {}, exit: vi.fn(), refreshAgents, ...noopActiveServer })

    expect(refreshAgents).toHaveBeenCalledOnce()
  })

  // Claude Desktop rewrites its own MCP config from a copy loaded at launch, so
  // it can restore a pre-upgrade cli.js path after `upgrade` healed it. Boot is
  // the touchpoint later than that revert — and a repair is inert until the user
  // restarts Desktop, so the hint is the part that makes it useful.
  it('tells the user to restart Claude Desktop when boot repaired its MCP entry', async () => {
    const projectRoot = mkProject()
    mockServer()
    const messages: string[] = []

    await runUi(['--no-open'], {
      projectRoot,
      log: (m) => messages.push(m),
      exit: vi.fn(),
      refreshAgents: vi.fn(),
      refreshDesktopMcp: () => 'configured',
      ...noopActiveServer,
    })

    expect(messages.join('\n')).toContain('Restart Claude Desktop')
  })

  it.each(['unchanged', 'skipped'] as const)('stays silent about Claude Desktop when boot returned %s', async (result) => {
    const projectRoot = mkProject()
    mockServer()
    const messages: string[] = []

    await runUi(['--no-open'], {
      projectRoot,
      log: (m) => messages.push(m),
      exit: vi.fn(),
      refreshAgents: vi.fn(),
      refreshDesktopMcp: () => result,
      ...noopActiveServer,
    })

    expect(messages.join('\n')).not.toContain('Claude Desktop')
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
      ...noopActiveServer,
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
      runStore: { abortAllActiveOrStale: vi.fn() },
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], { projectRoot, log: (m) => messages.push(m), exit: vi.fn(), ...noopActiveServer })

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
