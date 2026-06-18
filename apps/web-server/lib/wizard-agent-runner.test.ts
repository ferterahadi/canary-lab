import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { spawnPlanAgent, spawnSpecAgent } from './wizard-agent-runner'
import { WizardAgentCancelledError, WizardAgentRegistry } from './wizard-agent-registry'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  signals: NodeJS.Signals[] = []
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM')
    return true
  }

  emitData(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk, 'utf-8'))
  }

  close(code: number): void {
    this.emit('close', code)
  }
}

// A spawn() stand-in that records the call and returns our fake child.
function fakeSpawn(child: FakeChild): {
  impl: (cmd: string, args: string[]) => ChildProcess
  bin: () => string
  args: () => string[]
} {
  let capturedBin = ''
  let capturedArgs: string[] = []
  return {
    impl: ((cmd: string, args: string[]) => {
      capturedBin = cmd
      capturedArgs = args
      return child as unknown as ChildProcess
    }) as never,
    bin: () => capturedBin,
    args: () => capturedArgs,
  }
}

function writePlanTemplate(dir: string): string {
  const file = path.join(dir, 'plan-template.md')
  fs.writeFileSync(file, 'Plan {{prdText}} {{repos}}', 'utf8')
  return file
}

function writeSpecTemplate(dir: string): string {
  const file = path.join(dir, 'spec-template.md')
  fs.writeFileSync(file, 'Feature {{featureName}} {{plan}} {{repos}}', 'utf8')
  return file
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('wizard agent runner (headless)', () => {
  it('registers the agent, clears on normal exit, and streams output to the log', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const registry = new WizardAgentRegistry()
    const run = spawnPlanAgent({
      spawnImpl: spawn.impl as never,
      registry,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd1',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    expect(registry.has('d1')).toBe(true)
    expect(spawn.bin()).toBe('claude')
    child.emitData('<plan-output>[]</plan-output>')
    child.close(0)
    await expect(run).resolves.toContain('<plan-output>[]</plan-output>')
    expect(registry.has('d1')).toBe(false)
    const log = fs.readFileSync(path.join(tmp, 'agent.log'), 'utf8')
    expect(log).toContain('<plan-output>')
    expect(log).toContain('claude plan agent started')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('kills the child and rejects as cancelled', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const registry = new WizardAgentRegistry()
    const run = spawnPlanAgent({
      spawnImpl: spawn.impl as never,
      registry,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd2',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    expect(registry.cancel('d2')).toBe(true)
    expect(child.signals).toContain('SIGTERM')
    child.close(143)
    await expect(run).rejects.toBeInstanceOf(WizardAgentCancelledError)
    expect(registry.has('d2')).toBe(false)
    expect(fs.readFileSync(path.join(tmp, 'agent.log'), 'utf8')).toContain('Generation cancelled by user')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects non-zero exits as failures when not cancelled', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnPlanAgent({
      spawnImpl: spawn.impl as never,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd3',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    child.emitData('bad output')
    child.close(2)
    await expect(run).rejects.toThrow(/wizard agent exited with code 2/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('pins a fresh claude session id for planning (no resume)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnPlanAgent({
      spawnImpl: spawn.impl as never,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd4',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
      pinSessionId: 'new-plan-session',
    })

    child.emitData('<plan-output>[]</plan-output>')
    child.close(0)
    await expect(run).resolves.toContain('<plan-output>')
    expect(spawn.args()).toContain('--session-id')
    expect(spawn.args()).toContain('new-plan-session')
    expect(spawn.args()).not.toContain('--resume')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('resumes the matching planning session during spec generation', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnSpecAgent({
      spawnImpl: spawn.impl as never,
      specTemplate: writeSpecTemplate(tmp),
    })({
      draftId: 'd5-resume',
      agent: 'claude',
      featureName: 'login',
      plan: [],
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
      resumeSessionId: 'sess-123',
      pinSessionId: 'must-not-be-used',
    })

    child.emitData('<file path="x.ts">x</file>')
    child.close(0)
    await expect(run).resolves.toContain('<file path="x.ts">')
    expect(spawn.args()).toContain('--resume')
    expect(spawn.args()).toContain('sess-123')
    expect(spawn.args()).not.toContain('must-not-be-used')
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
