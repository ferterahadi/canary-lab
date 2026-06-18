import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { buildClaudeAgenticArgs, runAgentProcess } from './agent-process'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: vi.fn() }
  signals: NodeJS.Signals[] = []
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM')
    return true
  }

  out(text: string): void { this.stdout.emit('data', Buffer.from(text, 'utf-8')) }
  err(text: string): void { this.stderr.emit('data', Buffer.from(text, 'utf-8')) }
  close(code: number | null, signal: NodeJS.Signals | null = null): void { this.emit('close', code, signal) }
}

function fakeSpawn(child: FakeChild) {
  const calls: Array<{ command: string; args: string[]; opts: unknown }> = []
  const impl = ((command: string, args: string[], opts: unknown) => {
    calls.push({ command, args, opts })
    return child as unknown as ChildProcess
  }) as never
  return { impl, calls }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('buildClaudeAgenticArgs', () => {
  it('builds tools-on stream-json args', () => {
    expect(buildClaudeAgenticArgs('hi')).toEqual([
      '-p', 'hi', '--dangerously-skip-permissions',
      '--output-format=stream-json', '--include-partial-messages', '--verbose',
    ])
  })

  it('pins a session id', () => {
    expect(buildClaudeAgenticArgs('hi', { sessionId: 's1' }).slice(-2)).toEqual(['--session-id', 's1'])
  })

  it('resumes a session id', () => {
    expect(buildClaudeAgenticArgs('hi', { sessionId: 's1', resume: true }).slice(-2)).toEqual(['--resume', 's1'])
  })

  it('includes --model flag when model is provided', () => {
    const args = buildClaudeAgenticArgs('hi', { model: 'claude-haiku-4-5' })
    expect(args).toContain('--model')
    expect(args).toContain('claude-haiku-4-5')
  })

  it('omits --model flag when model is null', () => {
    const args = buildClaudeAgenticArgs('hi', { model: null })
    expect(args).not.toContain('--model')
  })

  it('includes no session args when sessionId is absent', () => {
    const args = buildClaudeAgenticArgs('hi')
    expect(args).not.toContain('--session-id')
    expect(args).not.toContain('--resume')
  })
})

describe('runAgentProcess', () => {
  it('accumulates stdout/stderr and resolves with the exit code on close', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const chunks: string[] = []
    const h = runAgentProcess({
      command: 'claude', args: ['-p', 'x'], idleMs: 1000,
      onChunk: (t) => chunks.push(t), spawnImpl: spawn.impl,
    })
    child.out('hello ')
    child.err('warn')
    child.out('world')
    child.close(0)
    const res = await h.done
    expect(res).toMatchObject({ code: 0, stdout: 'hello world', stderr: 'warn' })
    expect(chunks).toEqual(['hello ', 'warn', 'world'])
    expect(spawn.calls[0].command).toBe('claude')
  })

  it('rejects on a spawn error', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const h = runAgentProcess({ command: 'nope', args: [], idleMs: 1000, spawnImpl: spawn.impl })
    child.emit('error', new Error('ENOENT'))
    await expect(h.done).rejects.toThrow('ENOENT')
  })

  it('writes stdin when provided', () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    runAgentProcess({ command: 'codex', args: ['exec', '-'], stdin: 'the prompt', idleMs: 1000, spawnImpl: spawn.impl })
    expect(child.stdin.end).toHaveBeenCalledWith('the prompt')
    expect((spawn.calls[0].opts as { stdio: unknown[] }).stdio[0]).toBe('pipe')
  })

  it('skips stdout accumulation when captureStdout is false (still bumps + tees)', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const chunks: string[] = []
    const h = runAgentProcess({
      command: 'claude', args: [], idleMs: 1000, captureStdout: false,
      onChunk: (t) => chunks.push(t), spawnImpl: spawn.impl,
    })
    child.out('lots of envelopes')
    child.close(0)
    const res = await h.done
    expect(res.stdout).toBe('')
    expect(chunks).toEqual(['lots of envelopes'])
  })

  it('SIGTERMs the child after the idle window with no activity', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const onIdle = vi.fn()
    runAgentProcess({ command: 'claude', args: [], idleMs: 30, pollMs: 10, onIdle, spawnImpl: spawn.impl })
    await vi.advanceTimersByTimeAsync(40)
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(child.signals).toContain('SIGTERM')
  })

  it('output resets the idle clock so a streaming agent is not killed', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const onIdle = vi.fn()
    runAgentProcess({ command: 'claude', args: [], idleMs: 30, pollMs: 10, onIdle, spawnImpl: spawn.impl })
    for (let i = 0; i < 6; i++) {
      child.out('tok')
      await vi.advanceTimersByTimeAsync(20)
    }
    expect(onIdle).not.toHaveBeenCalled()
    expect(child.signals).not.toContain('SIGTERM')
  })

  it('stop() kills the child with SIGTERM by default', () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const h = runAgentProcess({ command: 'claude', args: [], idleMs: 1000, spawnImpl: spawn.impl })
    h.stop()
    expect(child.signals).toContain('SIGTERM')
  })

  it('stop("SIGKILL") passes SIGKILL to child.kill', () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const h = runAgentProcess({ command: 'claude', args: [], idleMs: 1000, spawnImpl: spawn.impl })
    h.stop('SIGKILL')
    expect(child.signals).toContain('SIGKILL')
  })

  it('activityPath: passes activity fn to startIdleTimer and covers statSync throw path', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    // Non-existent path → statSync throws → catch returns 0 (no throw escapes)
    const h = runAgentProcess({
      command: 'claude', args: [], idleMs: 30, pollMs: 10,
      activityPath: '/tmp/nonexistent-canary-agent-process-test-file',
      spawnImpl: spawn.impl,
    })
    // Advance past idle window so the idle callback fires and SIGTERM is sent
    await vi.advanceTimersByTimeAsync(40)
    expect(child.signals).toContain('SIGTERM')
    // Clean up: close the child so done resolves
    child.close(null, 'SIGTERM')
    await h.done
  })

  it('double-close guard: second close event is ignored', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const h = runAgentProcess({ command: 'claude', args: [], idleMs: 1000, spawnImpl: spawn.impl })
    child.close(0)
    child.close(1)  // second close — should be ignored by settled guard
    const res = await h.done
    expect(res.code).toBe(0)  // resolves with first close value
  })
})
