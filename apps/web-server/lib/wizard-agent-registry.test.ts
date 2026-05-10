import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneBroker } from './pane-broker'
import type { PtyHandle } from './runtime/pty-spawner'
import { killTree, scheduleSigkillFallback, WizardAgentRegistry } from './wizard-agent-registry'

class FakePty implements PtyHandle {
  constructor(public readonly pid: number) {}

  killed: string | undefined

  onData(): { dispose(): void } {
    return { dispose: () => {} }
  }

  onExit(): { dispose(): void } {
    return { dispose: () => {} }
  }

  write(): void {}
  resize(): void {}

  kill(signal?: string): void {
    this.killed = signal
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WizardAgentRegistry', () => {
  it('returns false when cancelling an unknown draft', () => {
    const registry = new WizardAgentRegistry()

    expect(registry.cancel('missing')).toBe(false)
  })

  it('cancels all active agents and writes the cancellation notice once', () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-registry-'))
    const broker = new PaneBroker()
    const registry = new WizardAgentRegistry()
    const ptyA = new FakePty(111)
    const ptyB = new FakePty(222)
    const logA = path.join(tmp, 'a', 'agent.log')
    const logB = path.join(tmp, 'b', 'agent.log')

    registry.register({
      draftId: 'draft-a',
      pty: ptyA,
      logPath: logA,
      broker,
      paneId: 'draft:draft-a',
    })
    const handleB = registry.register({
      draftId: 'draft-b',
      pty: ptyB,
      logPath: logB,
      paneId: 'draft:draft-b',
    })

    registry.cancelAll()
    registry.cancelAll()

    expect(handleB.isCancelled()).toBe(true)
    expect(fs.readFileSync(logA, 'utf8')).toBe('\n[wizard] Generation cancelled by user.\n')
    expect(fs.readFileSync(logB, 'utf8')).toBe('\n[wizard] Generation cancelled by user.\n')
    expect(broker.snapshot('draft:draft-a')).toBe('\n[wizard] Generation cancelled by user.\n')

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('only clears the currently registered agent for a draft', () => {
    const registry = new WizardAgentRegistry()
    const first = registry.register({
      draftId: 'draft',
      pty: new FakePty(111),
      logPath: '/tmp/first.log',
      paneId: 'draft:draft',
    })
    registry.register({
      draftId: 'draft',
      pty: new FakePty(222),
      logPath: '/tmp/second.log',
      paneId: 'draft:draft',
    })

    first.clear()

    expect(registry.has('draft')).toBe(true)
  })
})

describe('killTree', () => {
  it('falls back to killing the pty when process-group signalling fails', () => {
    const pty = new FakePty(333)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no process group')
    })

    killTree(pty, 'SIGTERM')

    expect(pty.killed).toBe('SIGTERM')
  })

  it('omits numeric signals when falling back to pty.kill', () => {
    const pty = new FakePty(444)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no process group')
    })

    killTree(pty, 0)

    expect(pty.killed).toBeUndefined()
  })

  it('swallows fallback kill errors', () => {
    const pty = new FakePty(555)
    vi.spyOn(pty, 'kill').mockImplementation(() => {
      throw new Error('already dead')
    })
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no process group')
    })

    expect(() => killTree(pty, 'SIGTERM')).not.toThrow()
  })
})

describe('scheduleSigkillFallback', () => {
  it('schedules a process-group SIGKILL fallback', async () => {
    vi.useFakeTimers()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    scheduleSigkillFallback(new FakePty(666), 50)
    await vi.advanceTimersByTimeAsync(50)

    expect(killSpy).toHaveBeenCalledWith(-666, 'SIGKILL')
  })

  it('swallows SIGKILL fallback errors', async () => {
    vi.useFakeTimers()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('already dead')
    })

    scheduleSigkillFallback(new FakePty(777), 50)
    await vi.advanceTimersByTimeAsync(50)

    expect(killSpy).toHaveBeenCalledWith(-777, 'SIGKILL')
  })
})
