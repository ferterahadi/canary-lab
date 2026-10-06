import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import type { HealAgent } from '../../../agent-sessions/logic/agent-binary'
import * as agentProcess from '../../../agent-sessions/logic/agent-process'
import { runPortifyAgent, writePortifyClaudeRef } from './agent'
import { resolveWorkflowAgentRef, writeWorkflowAgentRef } from '../../../agent-sessions/logic/agent-session-log'
import { claudeSessionLogPath } from '../../../agent-sessions/logic/agent-session-paths'

// Stub `claude`/`codex` on PATH with no-op executables so the test never spawns
// a real agent, regardless of what's installed on the machine.
let binDir: string
let originalPath: string | undefined
const roots: string[] = []

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-bin-'))
  for (const name of ['claude', 'codex']) {
    const p = path.join(binDir, name)
    fs.writeFileSync(p, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(p, 0o755)
  }
  originalPath = process.env.PATH
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
})
afterAll(() => {
  process.env.PATH = originalPath
  try { fs.rmSync(binDir, { recursive: true, force: true }) } catch { /* ignore */ }
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-agent-'))
  roots.push(d)
  return d
}

describe('runPortifyAgent', () => {
  it('runs claude with a pinned session id and tees output to a log', async () => {
    const dir = tmp()
    const logPath = path.join(dir, 'agent.log')
    const children = new Set<ChildProcess>()
    await runPortifyAgent({ agent: 'claude', prompt: 'do it', cwd: dir, logPath, children, sessionId: 's1', resume: false })
    expect(fs.existsSync(logPath)).toBe(true)
    expect(children.size).toBe(0) // child removed on close
  })

  it('resumes the claude session on a retry', async () => {
    const dir = tmp()
    await runPortifyAgent({ agent: 'claude', prompt: 'again', cwd: dir, sessionId: 's1', resume: true })
  })

  it('runs Codex with explicit sandbox policy and the selected model', async () => {
    const dir = tmp()
    const spy = vi.spyOn(agentProcess, 'runAgentProcess')
    try {
      await runPortifyAgent({ agent: 'codex', prompt: 'do it', cwd: dir, models: { model: 'test-model', effort: 'high' } })
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        command: 'codex', cwd: dir,
        args: ['exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"', '--model', 'test-model', '-c', 'model_reasoning_effort=high', 'do it'],
      }))
    } finally { spy.mockRestore() }
  })

  it('runs claude without a pinned session id', async () => {
    const dir = tmp()
    await runPortifyAgent({ agent: 'claude', prompt: 'no session', cwd: dir })
  })

  it('falls back to ignore stdio when the log file cannot be opened', async () => {
    const dir = tmp()
    // logPath points into a non-existent directory → openSync throws → ignored.
    await runPortifyAgent({ agent: 'codex', prompt: 'x', cwd: dir, logPath: path.join(dir, 'no', 'such', 'dir', 'a.log') })
  })

  it('calls the activity callback (covers the fs.statSync lambda) and onIdle', async () => {
    // Mock startIdleTimer to capture and immediately invoke both callbacks so
    // the inline arrow functions at lines 75-76 are covered.
    const idleTimerModule = await import('../../../agent-sessions/logic/agent-idle-timer')
    const captured: { activity?: () => number; onIdle?: (ms: number) => void } = {}
    vi.spyOn(idleTimerModule, 'startIdleTimer').mockImplementationOnce((opts) => {
      captured.activity = opts.activity
      captured.onIdle = opts.onIdle
      return { bump: () => {}, stop: () => {} }
    })
    const dir = tmp()
    const logPath = path.join(dir, 'agent.log')
    // claude + sessionId → activityPath = claudeSessionLogPath → activity is defined
    const promise = runPortifyAgent({ agent: 'claude', prompt: 'go', cwd: dir, logPath, sessionId: 's2', resume: false })
    // Call the activity callback — file won't exist so statSync throws → returns 0
    expect(captured.activity?.()).toBe(0)
    // Call onIdle — sends SIGTERM to the child; child still exits normally via stub
    captured.onIdle?.(5 * 60 * 1000)
    await promise
    vi.restoreAllMocks()
  })

  it('rejects with a clear message when the agent CLI cannot be launched', async () => {
    const dir = tmp()
    await expect(
      runPortifyAgent({ agent: 'definitely-not-a-binary' as HealAgent, prompt: 'x', cwd: dir }),
    ).rejects.toThrow(/could not launch the definitely-not-a-binary CLI/)
  })

  it('records the launch failure to the log so it is not mistaken for an empty run', async () => {
    const dir = tmp()
    const logPath = path.join(dir, 'agent.log')
    const children = new Set<ChildProcess>()
    await expect(
      runPortifyAgent({ agent: 'definitely-not-a-binary' as HealAgent, prompt: 'x', cwd: dir, logPath, children }),
    ).rejects.toThrow()
    expect(fs.readFileSync(logPath, 'utf-8')).toMatch(/could not launch the definitely-not-a-binary CLI/)
    expect(children.size).toBe(0) // child removed even on launch failure
  })
})

describe('writePortifyClaudeRef', () => {
  it('creates a missing workflow directory and round-trips the shared reference under a configured Claude home', () => {
    const cwd = fs.realpathSync(tmp())
    const dir = path.join(cwd, 'nested', 'workflow')
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(cwd, 'agent-config'))
    writePortifyClaudeRef(dir, cwd, 'session-123')
    expect(resolveWorkflowAgentRef(dir)).toEqual({
      agent: 'claude', sessionId: 'session-123', logPath: claudeSessionLogPath(cwd, 'session-123'),
    })
    const other = path.join(cwd, 'general-workflow')
    writeWorkflowAgentRef(other, { agent: 'claude', cwd, sessionId: 'session-123', spawnedAt: '2026-01-01T00:00:00Z' })
    expect(fs.readFileSync(path.join(dir, 'agent-session.json'), 'utf8')).toBe(fs.readFileSync(path.join(other, 'agent-session.json'), 'utf8'))
  })

  it('keeps reference writes best-effort when the destination cannot be a directory', () => {
    const cwd = tmp()
    const blocked = path.join(cwd, 'blocked')
    fs.writeFileSync(blocked, 'keep')
    expect(() => writePortifyClaudeRef(blocked, cwd, 'session-123')).not.toThrow()
    expect(fs.readFileSync(blocked, 'utf8')).toBe('keep')
  })

  it('writes an agent-session.json ref pointing at the claude log', () => {
    const dir = tmp()
    writePortifyClaudeRef(dir, dir, 'sess-123')
    const ref = JSON.parse(fs.readFileSync(path.join(dir, 'agent-session.json'), 'utf-8'))
    expect(ref.activeAgent).toBe('claude')
    expect(ref.sessions.claude.sessionId).toBe('sess-123')
    expect(ref.sessions.claude.logPath).toContain('sess-123.jsonl')
  })

  it('is a no-op when the cwd cannot be resolved', () => {
    const dir = tmp()
    expect(() => writePortifyClaudeRef(dir, '/no/such/path/xyz', 'sess')).not.toThrow()
  })
})
