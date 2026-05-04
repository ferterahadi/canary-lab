import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  openBrowser: vi.fn(),
}))

vi.mock('../apps/web-server/server', () => ({ createServer: mocks.createServer }))
vi.mock('../apps/web-server/lib/open-browser', () => ({ openBrowser: mocks.openBrowser }))

const { runUi } = await import('./ui-command')

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
  it('stops active runs before reverting envsets and exiting on SIGINT', async () => {
    const events: string[] = []
    const orchA = {
      runId: 'run-a',
      stop: vi.fn(async () => { events.push('stop-a') }),
    }
    const orchB = {
      runId: 'run-b',
      stop: vi.fn(async () => { events.push('stop-b') }),
    }
    const registry = {
      list: vi.fn(() => [orchA, orchB]),
      delete: vi.fn((runId: string) => {
        events.push(`delete-${runId}`)
        return true
      }),
    }
    const app = {
      listen: vi.fn(async () => {}),
      close: vi.fn(async () => { events.push('close') }),
    }
    const revertAllEnvsets = vi.fn(() => { events.push('revert') })
    const exit = vi.fn((code: number) => { events.push(`exit-${code}`) })

    mocks.createServer.mockResolvedValue({
      app,
      registry,
      revertAllEnvsets,
      runStore: {},
      brokers: new Map(),
      draftBrokers: new Map(),
    })

    await runUi(['--no-open'], {
      projectRoot: '/tmp/canary-lab-workspace',
      log: () => {},
      exit,
    })

    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(orchA.stop).toHaveBeenCalledExactlyOnceWith('aborted')
    expect(orchB.stop).toHaveBeenCalledExactlyOnceWith('aborted')
    expect(registry.delete).toHaveBeenCalledWith('run-a')
    expect(registry.delete).toHaveBeenCalledWith('run-b')
    expect(revertAllEnvsets).toHaveBeenCalledOnce()
    expect(app.close).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledExactlyOnceWith(130)
    expect(events).toEqual([
      'stop-a',
      'delete-run-a',
      'stop-b',
      'delete-run-b',
      'revert',
      'close',
      'exit-130',
    ])
  })
})
