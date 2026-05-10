import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  it('does not start the server when the requested port is invalid', async () => {
    const exit = vi.fn()

    await runUi(['--port', '12abc'], {
      projectRoot: '/tmp/canary-lab-workspace',
      log: () => {},
      exit,
    })

    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
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

describe('parsePort', () => {
  it('parses --port and --port=<n>', () => {
    expect(parsePort(['--port', '8123'])).toBe(8123)
    expect(parsePort(['--port=8124'])).toBe(8124)
  })

  it('rejects missing, non-numeric, partial, and out-of-range ports', () => {
    const messages: string[] = []
    const exit = vi.fn()
    const opts = {
      log: (msg: string) => { messages.push(msg) },
      exit,
    }

    expect(parsePort(['--port'], opts)).toBeUndefined()
    expect(parsePort(['--port', '12abc'], opts)).toBeUndefined()
    expect(parsePort(['--port=0'], opts)).toBeUndefined()
    expect(parsePort(['--port=65536'], opts)).toBeUndefined()

    expect(exit).toHaveBeenCalledTimes(4)
    expect(messages).toEqual([
      'Usage: canary-lab ui [--port <n>] [--no-open]',
      'Invalid port "12abc". Use a number between 1 and 65535.',
      'Invalid port "0". Use a number between 1 and 65535.',
      'Invalid port "65536". Use a number between 1 and 65535.',
    ])
  })
})
