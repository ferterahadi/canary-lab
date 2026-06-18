import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { killChild, WizardAgentRegistry } from './wizard-agent-registry'

function fakeChild(): ChildProcess & { signals: Array<NodeJS.Signals> } {
  const ee = new EventEmitter() as ChildProcess & { signals: Array<NodeJS.Signals> }
  ee.signals = []
  ee.kill = ((signal?: NodeJS.Signals) => {
    ee.signals.push(signal ?? 'SIGTERM')
    return true
  }) as ChildProcess['kill']
  return ee
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WizardAgentRegistry', () => {
  it('returns false when cancelling an unknown draft', () => {
    expect(new WizardAgentRegistry().cancel('missing')).toBe(false)
  })

  it('cancels all active agents and writes the cancellation notice once', () => {
    vi.useFakeTimers()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-registry-'))
    const registry = new WizardAgentRegistry()
    const childA = fakeChild()
    const childB = fakeChild()
    const logA = path.join(tmp, 'a', 'agent.log')
    const logB = path.join(tmp, 'b', 'agent.log')

    registry.register({ draftId: 'draft-a', child: childA, logPath: logA })
    const handleB = registry.register({ draftId: 'draft-b', child: childB, logPath: logB })

    registry.cancelAll()
    registry.cancelAll()

    expect(handleB.isCancelled()).toBe(true)
    expect(fs.readFileSync(logA, 'utf8')).toBe('\n[wizard] Generation cancelled by user.\n')
    expect(fs.readFileSync(logB, 'utf8')).toBe('\n[wizard] Generation cancelled by user.\n')
    expect(childA.signals).toContain('SIGTERM')

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('only clears the currently registered agent for a draft', () => {
    const registry = new WizardAgentRegistry()
    const first = registry.register({ draftId: 'draft', child: fakeChild(), logPath: '/tmp/first.log' })
    registry.register({ draftId: 'draft', child: fakeChild(), logPath: '/tmp/second.log' })

    first.clear()

    expect(registry.has('draft')).toBe(true)
  })
})

describe('killChild', () => {
  it('sends SIGTERM then schedules a SIGKILL fallback', async () => {
    vi.useFakeTimers()
    const child = fakeChild()

    killChild(child)
    expect(child.signals).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(2000)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('swallows kill errors', () => {
    const child = fakeChild()
    child.kill = (() => { throw new Error('already dead') }) as ChildProcess['kill']
    expect(() => killChild(child)).not.toThrow()
  })
})
