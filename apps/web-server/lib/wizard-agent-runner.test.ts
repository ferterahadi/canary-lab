import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneBroker } from './pane-broker'
import type { PtyFactory, PtyHandle } from './runtime/pty-spawner'
import { spawnPlanAgent, spawnSpecAgent } from './wizard-agent-runner'
import { WizardAgentCancelledError, WizardAgentRegistry } from './wizard-agent-registry'

class FakePty implements PtyHandle {
  pid = 4242
  killed: string | null = null
  private dataCbs: Array<(chunk: string) => void> = []
  private exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = []

  onData(cb: (chunk: string) => void): { dispose(): void } {
    this.dataCbs.push(cb)
    return { dispose: () => {} }
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitCbs.push(cb)
    return { dispose: () => {} }
  }

  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    this.killed = signal ?? 'SIGTERM'
  }

  emitData(chunk: string): void {
    for (const cb of this.dataCbs) cb(chunk)
  }

  emitExit(exitCode: number): void {
    for (const cb of this.exitCbs) cb({ exitCode })
  }
}

function writePlanTemplate(dir: string): string {
  const file = path.join(dir, 'plan-template.md')
  fs.writeFileSync(file, 'Plan {{prdText}} {{repos}}', 'utf8')
  return file
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('wizard agent runner cancellation', () => {
  it('registers active ptys, clears on normal exit, and streams output', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const pty = new FakePty()
    const factory: PtyFactory = () => pty
    const registry = new WizardAgentRegistry()
    const broker = new PaneBroker()
    broker.push('draft:d1:planning', 'stale output')
    const run = spawnPlanAgent({
      ptyFactory: factory,
      registry,
      broker,
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
    pty.emitData('<plan-output>[]</plan-output>')
    pty.emitExit(0)
    await expect(run).resolves.toContain('<plan-output>[]</plan-output>')
    expect(registry.has('d1')).toBe(false)
    expect(fs.readFileSync(path.join(tmp, 'agent.log'), 'utf8')).toContain('<plan-output>')
    expect(fs.readFileSync(path.join(tmp, 'agent.log'), 'utf8')).toContain('claude plan agent started')
    expect(broker.snapshot('draft:d1:planning')).toContain('<plan-output>')
    expect(broker.snapshot('draft:d1:planning')).not.toContain('stale output')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('SIGTERMs the process group and rejects as cancelled', async () => {
    vi.useFakeTimers()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const pty = new FakePty()
    const registry = new WizardAgentRegistry()
    const run = spawnPlanAgent({
      ptyFactory: () => pty,
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
    expect(killSpy).toHaveBeenCalledWith(-pty.pid, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(2000)
    expect(killSpy).toHaveBeenCalledWith(-pty.pid, 'SIGKILL')
    pty.emitExit(143)
    await expect(run).rejects.toBeInstanceOf(WizardAgentCancelledError)
    expect(registry.has('d2')).toBe(false)
    expect(fs.readFileSync(path.join(tmp, 'agent.log'), 'utf8')).toContain('Generation cancelled by user')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects non-zero exits as failures when not cancelled', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const pty = new FakePty()
    const run = spawnPlanAgent({
      ptyFactory: () => pty,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd3',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    pty.emitData('bad output')
    pty.emitExit(2)
    await expect(run).rejects.toThrow(/wizard agent exited with code 2/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('hides misleading restored-session notices from planning output', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const pty = new FakePty()
    const run = spawnPlanAgent({
      ptyFactory: () => pty,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd4',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    pty.emitData('Restored session: Wed 6 May 2026\n<plan-output>[]</plan-output>')
    pty.emitExit(0)
    await expect(run).resolves.not.toContain('Restored session')
    expect(fs.readFileSync(path.join(tmp, 'agent.log'), 'utf8')).not.toContain('Restored session')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('hides misleading restored-session notices from spec output', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const pty = new FakePty()
    const run = spawnSpecAgent({
      ptyFactory: () => pty,
      specTemplate: 'Feature {{featureName}} {{plan}} {{skills}} {{repos}}',
    })({
      draftId: 'd5',
      agent: 'claude',
      featureName: 'login',
      plan: [],
      skills: [],
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
      resumeSessionId: 'sess-123',
    })

    pty.emitData('Restored session: Wed 6 May 2026\n<file path="x.ts">x</file>')
    pty.emitExit(0)
    await expect(run).resolves.not.toContain('Restored session')
    expect(fs.readFileSync(path.join(tmp, 'agent.log'), 'utf8')).not.toContain('Restored session')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('prints a waiting heartbeat when an agent produces no output for a while', async () => {
    vi.useFakeTimers()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const pty = new FakePty()
    const run = spawnSpecAgent({
      ptyFactory: () => pty,
      specTemplate: 'Feature {{featureName}} {{plan}} {{skills}} {{repos}}',
    })({
      draftId: 'd6',
      agent: 'claude',
      featureName: 'login',
      plan: [],
      skills: [],
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    await vi.advanceTimersByTimeAsync(5000)
    expect(fs.readFileSync(path.join(tmp, 'agent.log'), 'utf8')).toContain('waiting for agent output')
    pty.emitData('<file path="x.ts">x</file>')
    pty.emitExit(0)
    await expect(run).resolves.toContain('<file path="x.ts">')
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
