import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { createEvaluationHtml } from './test-review-export'
import { detail, lineOf } from './__fixtures__/test-review-fixtures'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('evaluation rewrite agent + highlight fallback (isolated module mocks)', () => {
  let spawnCalls: Array<{ command: string; args: string[]; child: FakeChild }>
  let availableAgents: string[]
  let idleHandlers: { onIdle?: (ms: number) => void; onTick?: (ms: number) => void }

  beforeEach(() => {
    vi.resetModules()
    spawnCalls = []
    availableAgents = []
    idleHandlers = {}
  })

  afterEach(() => {
    vi.doUnmock('shiki')
    vi.doUnmock('child_process')
    vi.doUnmock('../../runs/logic/runtime/auto-heal')
    vi.doUnmock('../../agent-sessions/logic/agent-binary')
    vi.doUnmock('../../agent-sessions/logic/agent-idle-timer')
    vi.resetModules()
    vi.restoreAllMocks()
  })

  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdinText = ''
    stdin = { end: (text = '') => { this.stdinText += text } }
    killed: string[] = []

    kill(signal: string): void { this.killed.push(signal) }

    close(code: number | null, signal: string | null = null): void { this.emit('close', code, signal) }
  }

  function mockAgentModules(onSpawn?: (ctx: { command: string; args: string[]; child: FakeChild }) => void): void {
    vi.doMock('../../runs/logic/runtime/auto-heal', () => ({
      pickAvailableHealAgent: (preferred?: string) => {
        if (preferred === 'claude' || preferred === 'codex') return availableAgents.includes(preferred) ? preferred : null
        return availableAgents[0] ?? null
      },
    }))
    // Prevent path resolution so spawn receives bare agent names.
    vi.doMock('../../agent-sessions/logic/agent-binary', () => ({
      resolveAgentBinary: (agent: string) => agent,
      isAgentKind: (cmd: string) => cmd === 'claude' || cmd === 'codex',
    }))
    // Capture the idle callbacks the spawn primitive wires up so the test can
    // drive idle-timeout and progress-tick behavior deterministically.
    vi.doMock('../../agent-sessions/logic/agent-idle-timer', () => ({
      startIdleTimer: (opts: { onIdle?: (ms: number) => void; onTick?: (ms: number) => void }) => {
        idleHandlers = { onIdle: opts.onIdle, onTick: opts.onTick }
        return { bump() {}, stop() {} }
      },
    }))
    vi.doMock('child_process', () => ({
      spawn: (command: string, args: string[]) => {
        const child = new FakeChild()
        spawnCalls.push({ command, args, child })
        setTimeout(() => onSpawn?.({ command, args, child }), 0)
        return child
      },
    }))
  }

  const rewriteJson = JSON.stringify({
    summary: 's',
    cases: [{ title: 't', whatWasChecked: 'w', whyItMatters: 'm', confidence: 'c' }],
  })

  it('surfaces the pinned claude session ref to onSession', async () => {
    availableAgents = ['claude']
    const sessions: Array<{ agent: string; sessionId: string }> = []
    mockAgentModules(({ child }) => {
      child.stdout.emit('data', `${JSON.stringify({ type: 'result', result: rewriteJson })}\n`)
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir, { onSession: (s) => sessions.push(s) })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].agent).toBe('claude')
    expect(sessions[0].sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('surfaces an empty codex session ref to onSession', async () => {
    availableAgents = ['codex']
    const sessions: Array<{ agent: string; sessionId: string }> = []
    mockAgentModules(({ args, child }) => {
      const outputPath = args[args.indexOf('--output-last-message') + 1]
      fs.writeFileSync(outputPath, JSON.stringify({ slots: [{ id: 'summary', text: 'localized' }] }))
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'codex', tmpDir, { onSession: (s) => sessions.push(s) })

    expect(sessions[0]).toEqual({ agent: 'codex', sessionId: '' })
  })

  it('rejects and kills the child when the evaluation agent goes idle', async () => {
    availableAgents = ['claude']
    mockAgentModules(({ child }) => {
      idleHandlers.onIdle?.(300000)
      child.close(null, 'SIGTERM')
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir))
      .rejects.toThrow(/idle for \d+ms/)
    expect(spawnCalls[0].child.killed).toContain('SIGTERM')
  })

  it('emits a progress note once the idle window passes the threshold', async () => {
    availableAgents = ['codex']
    const onOutput = vi.fn()
    mockAgentModules(({ args, child }) => {
      idleHandlers.onTick?.(4000)   // below threshold → no note
      idleHandlers.onTick?.(15000)  // above threshold → progress note
      const outputPath = args[args.indexOf('--output-last-message') + 1]
      fs.writeFileSync(outputPath, JSON.stringify({ slots: [{ id: 'summary', text: 'localized' }] }))
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'codex', tmpDir, { onOutput })

    const notes = onOutput.mock.calls
      .map((call) => call[0])
      .filter((text): text is string => typeof text === 'string' && text.includes('still running'))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('15s idle')
  })

  it('ignores a successful close that arrives after an abort', async () => {
    availableAgents = ['claude']
    const controller = new AbortController()
    mockAgentModules(({ child }) => {
      controller.abort()
      child.stdout.emit('data', `${JSON.stringify({ type: 'result', result: rewriteJson })}\n`)
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir, { signal: controller.signal }))
      .rejects.toThrow('evaluation rewrite cancelled')
  })

  it('ignores a failing close that arrives after an abort', async () => {
    availableAgents = ['claude']
    const controller = new AbortController()
    mockAgentModules(({ child }) => {
      controller.abort()
      child.stderr.emit('data', 'boom')
      child.close(2)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir, { signal: controller.signal }))
      .rejects.toThrow('evaluation rewrite cancelled')
  })

  it('wraps a process-error rejection from the agent runner', async () => {
    availableAgents = ['claude']
    mockAgentModules(({ child }) => {
      child.emit('error', new Error('spawn failed to launch'))
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail({ featureDir: tmpDir }), 'claude', tmpDir))
      .rejects.toThrow('evaluation rewrite agent failed: spawn failed to launch')
  })

  it('falls back to a plain code block when syntax highlighting throws', async () => {
    vi.doMock('shiki', () => ({ codeToHtml: () => { throw new Error('highlighter unavailable') } }))
    const featureDir = path.join(tmpDir, 'shiki-fallback')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'fallback.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('fallback highlight', async ({ page }) => {
  await expect(page.getByText('Ready')).toBeVisible()
})
`
    fs.writeFileSync(spec, specSource)
    const { createEvaluationHtml: createHtml } = await import('./test-review-export')
    const html = await createHtml(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('fallback highlight'")}`,
      title: 'fallback highlight',
    }))

    expect(html).toContain('fallback-code')
    expect(html).not.toContain('class="shiki"')
  })
})
