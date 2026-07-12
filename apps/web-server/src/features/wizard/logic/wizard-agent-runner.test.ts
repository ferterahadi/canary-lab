import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { spawnPlanAgent, spawnSpecAgent } from './wizard-agent-runner'
import { WizardAgentCancelledError, WizardAgentRegistry } from '../../wizard/logic/wizard-agent-registry'

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
      resolveBinary: () => null,
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
      resolveBinary: () => null,
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
      resolveBinary: () => null,
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
      resolveBinary: () => null,
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
      resolveBinary: () => null,
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

  it('wraps a synchronous spawn throw as a rejection before any process exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const run = spawnPlanAgent({
      spawnImpl: (() => {
        throw new Error('spawn EMFILE')
      }) as never,
      resolveBinary: () => null,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd-throw',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    await expect(run).rejects.toThrow(/wizard agent spawn failed: spawn EMFILE/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('wraps a child "error" event as a rejection and clears the lease', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const registry = new WizardAgentRegistry()
    const run = spawnPlanAgent({
      spawnImpl: spawn.impl as never,
      resolveBinary: () => null,
      registry,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd-err',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    expect(registry.has('d-err')).toBe(true)
    child.emit('error', new Error('ENOENT'))
    await expect(run).rejects.toThrow(/wizard agent spawn failed: ENOENT/)
    expect(registry.has('d-err')).toBe(false)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('loads the real plan template off disk when no template override is given', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnPlanAgent({
      spawnImpl: spawn.impl as never,
      resolveBinary: () => null,
    })({
      draftId: 'd-real-plan-template',
      agent: 'claude',
      prdText: 'Login flow PRD text',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    child.emitData('<plan-output>[]</plan-output>')
    child.close(0)
    await expect(run).resolves.toContain('<plan-output>[]</plan-output>')
    // the real stage1-plan.md template on disk got loaded + rendered, not a test fixture
    expect(spawn.args().some((a) => a.includes('Login flow PRD text'))).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('loads the real spec template off disk when no template override is given', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnSpecAgent({
      spawnImpl: spawn.impl as never,
      resolveBinary: () => null,
    })({
      draftId: 'd-real-spec-template',
      agent: 'claude',
      featureName: 'checkout-flow',
      plan: [],
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
      pinSessionId: 'spec-sess-1',
    })

    child.emitData('<file path="x.ts">x</file>')
    child.close(0)
    await expect(run).resolves.toContain('<file path="x.ts">')
    // the real stage2-spec.md template on disk got loaded + rendered, not a test fixture
    expect(spawn.args().some((a) => a.includes('checkout-flow'))).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('spawns the codex binary for a plan agent with no claude session id', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnPlanAgent({
      spawnImpl: spawn.impl as never,
      resolveBinary: () => null,
      codexBin: '/usr/local/bin/codex',
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd-codex-plan',
      agent: 'codex',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
      pinSessionId: 'should-be-ignored-for-codex',
    })

    child.emitData('codex plain answer text')
    child.close(0)
    await expect(run).resolves.toContain('codex plain answer text')
    expect(spawn.bin()).toBe('/usr/local/bin/codex')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('spawns the codex binary for a spec agent with no claude session id', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnSpecAgent({
      spawnImpl: spawn.impl as never,
      resolveBinary: () => null,
      codexBin: '/usr/local/bin/codex',
      specTemplate: writeSpecTemplate(tmp),
    })({
      draftId: 'd-codex-spec',
      agent: 'codex',
      featureName: 'login',
      plan: [],
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
      resumeSessionId: 'ignored-resume',
      pinSessionId: 'ignored-pin',
    })

    child.emitData('codex spec answer')
    child.close(0)
    await expect(run).resolves.toContain('codex spec answer')
    expect(spawn.bin()).toBe('/usr/local/bin/codex')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('falls back to the pinned session id when spec generation has no resume id yet', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnSpecAgent({
      spawnImpl: spawn.impl as never,
      resolveBinary: () => null,
      specTemplate: writeSpecTemplate(tmp),
    })({
      draftId: 'd-pin-fallback',
      agent: 'claude',
      featureName: 'login',
      plan: [],
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
      pinSessionId: 'pinned-only-session',
    })

    child.emitData('<file path="x.ts">x</file>')
    child.close(0)
    await expect(run).resolves.toContain('<file path="x.ts">')
    expect(spawn.args()).toContain('--session-id')
    expect(spawn.args()).toContain('pinned-only-session')
    expect(spawn.args()).not.toContain('--resume')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('falls back to the real node spawn and surfaces ENOENT when spawnImpl is not overridden (plan)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const nonExistentBin = path.join(tmp, 'definitely-does-not-exist-canary-lab-test-bin')
    const run = spawnPlanAgent({
      resolveBinary: () => nonExistentBin,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd-real-spawn-plan',
      agent: 'claude',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    await expect(run).rejects.toThrow(/wizard agent spawn failed:/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('defaults to the bare "codex" binary when no codexBin override is given', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const run = spawnPlanAgent({
      spawnImpl: spawn.impl as never,
      resolveBinary: () => null,
      planTemplate: writePlanTemplate(tmp),
    })({
      draftId: 'd-codex-default-bin',
      agent: 'codex',
      prdText: 'Login',
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    child.emitData('codex default bin answer')
    child.close(0)
    await expect(run).resolves.toContain('codex default bin answer')
    expect(spawn.bin()).toBe('codex')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('falls back to the real node spawn and surfaces ENOENT when spawnImpl is not overridden (spec)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-runner-'))
    const nonExistentBin = path.join(tmp, 'definitely-does-not-exist-canary-lab-test-bin')
    const run = spawnSpecAgent({
      resolveBinary: () => nonExistentBin,
      specTemplate: writeSpecTemplate(tmp),
    })({
      draftId: 'd-real-spawn-spec',
      agent: 'claude',
      featureName: 'login',
      plan: [],
      repos: [{ name: 'app', localPath: '/app' }],
      draftDir: tmp,
      agentLogPath: path.join(tmp, 'agent.log'),
    })

    await expect(run).rejects.toThrow(/wizard agent spawn failed:/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
