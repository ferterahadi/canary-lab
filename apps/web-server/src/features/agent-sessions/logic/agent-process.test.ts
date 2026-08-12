import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { buildClaudeAgenticArgs, runAgentProcess, stopAgentProcesses, stopAllAgentProcesses } from './agent-process'

// hoisted so the factory can reference mockNodeSpawn before imports resolve
const { mockNodeSpawn } = vi.hoisted(() => ({ mockNodeSpawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mockNodeSpawn }))

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
      '--strict-mcp-config',
      '--disallowedTools', 'WebFetch,WebSearch',
      '--output-format=stream-json', '--include-partial-messages', '--verbose',
    ])
  })

  it('inherits no MCP server the spawn did not ask for', () => {
    // Without this, a read-only spawn still arrived holding the user's
    // connected MCP servers — `--tools` bounds built-ins only.
    expect(buildClaudeAgenticArgs('hi')).toContain('--strict-mcp-config')
    expect(buildClaudeAgenticArgs('hi', { readOnly: true })).toContain('--strict-mcp-config')
  })

  it('denies the outbound tools on every headless spawn, bypass or not', () => {
    // `--disallowedTools` is evaluated before the bypass, so this deny holds
    // even though the same argv carries `--dangerously-skip-permissions`.
    for (const args of [buildClaudeAgenticArgs('hi'), buildClaudeAgenticArgs('hi', { readOnly: true })]) {
      const at = args.indexOf('--disallowedTools')
      expect(args.slice(at, at + 2)).toEqual(['--disallowedTools', 'WebFetch,WebSearch'])
    }
  })

  it('holds no tool allowlist by default — a repairing agent needs to write', () => {
    expect(buildClaudeAgenticArgs('hi')).not.toContain('--tools')
  })

  it('takes the write tools away entirely for a read-only agent', () => {
    // `--tools` is a capability allowlist, not an instruction: Edit/Write/Bash
    // are absent from the session, so `--dangerously-skip-permissions` cannot
    // hand them back. Verified live against claude 2.1.220.
    const args = buildClaudeAgenticArgs('hi', { readOnly: true })
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
      '--tools', 'Read,Glob,Grep',
    ])
    expect(args).toContain('--dangerously-skip-permissions')
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
      onChunk: (t) => chunks.push(t), spawnImpl: spawn.impl, resolveBinary: () => null,
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

  it('tags a full-path claude command as claude-pty by extracting the basename', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    runAgentProcess({ command: '/usr/local/bin/claude', args: [], idleMs: 1000, spawnImpl: spawn.impl })
    child.close(0)
    expect((spawn.calls[0].opts as { env: NodeJS.ProcessEnv }).env).toMatchObject({
      CANARY_LAB_MCP_CLIENT_KIND: 'claude-pty',
    })
  })

  it('tags a full-path codex command as codex-pty', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    runAgentProcess({ command: '/home/user/.nvm/bin/codex', args: [], idleMs: 1000, spawnImpl: spawn.impl })
    child.close(0)
    expect((spawn.calls[0].opts as { env: NodeJS.ProcessEnv }).env).toMatchObject({
      CANARY_LAB_MCP_CLIENT_KIND: 'codex-pty',
    })
  })

  it('does not tag an unrelated command even if claude appears in the path prefix', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    runAgentProcess({ command: '/home/claude/bin/other-tool', args: [], idleMs: 1000, spawnImpl: spawn.impl })
    child.close(0)
    expect((spawn.calls[0].opts as { env: NodeJS.ProcessEnv }).env).toBe(process.env)
  })

  it('uses nodeSpawn when spawnImpl is omitted (covers the ?? nodeSpawn branch)', async () => {
    // All other tests supply spawnImpl to avoid the real spawn. This one omits it
    // so opts.spawnImpl ?? nodeSpawn takes the right side (nodeSpawn = mocked spawn).
    const child = new FakeChild()
    mockNodeSpawn.mockReturnValueOnce(child as unknown as ChildProcess)
    const h = runAgentProcess({ command: 'claude', args: ['-p', 'hi'], idleMs: 1000, resolveBinary: () => null })
    child.close(0)
    const res = await h.done
    expect(res.code).toBe(0)
    expect(mockNodeSpawn).toHaveBeenCalledWith('claude', ['-p', 'hi'], expect.anything())
  })

  it('resolves a bare agent kind to the absolute path before spawning', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    runAgentProcess({
      command: 'claude', args: [], idleMs: 1000,
      spawnImpl: spawn.impl, resolveBinary: (a) => `/opt/bin/${a}`,
    })
    child.close(0)
    expect(spawn.calls[0].command).toBe('/opt/bin/claude')
    // basename still resolves the PTY tag
    expect((spawn.calls[0].opts as { env: NodeJS.ProcessEnv }).env).toMatchObject({
      CANARY_LAB_MCP_CLIENT_KIND: 'claude-pty',
    })
  })

  it('falls back to the bare agent name when resolution returns null', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    runAgentProcess({ command: 'codex', args: [], idleMs: 1000, spawnImpl: spawn.impl, resolveBinary: () => null })
    child.close(0)
    expect(spawn.calls[0].command).toBe('codex')
  })

  it('does not resolve a non-agent-kind command (explicit path passes through)', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const resolveBinary = vi.fn(() => '/should/not/be/used')
    runAgentProcess({ command: '/usr/local/bin/claude', args: [], idleMs: 1000, spawnImpl: spawn.impl, resolveBinary })
    child.close(0)
    expect(resolveBinary).not.toHaveBeenCalled()
    expect(spawn.calls[0].command).toBe('/usr/local/bin/claude')
  })
})

// A child that dies when signalled, so a stop can be awaited to completion. Set
// `ignoreSigterm` to model the wedged CLI the SIGKILL escalation exists for.
class SignalableChild extends FakeChild {
  ignoreSigterm = false
  override kill(signal?: NodeJS.Signals): boolean {
    super.kill(signal)
    const sig = signal ?? 'SIGTERM'
    if (sig === 'SIGKILL' || !this.ignoreSigterm) this.close(null, sig)
    return true
  }
}

function spawnScoped(child: FakeChild, scope?: string) {
  return runAgentProcess({
    command: 'claude', args: [], idleMs: 60_000,
    spawnImpl: fakeSpawn(child).impl, resolveBinary: () => null,
    ...(scope === undefined ? {} : { spawnScope: scope }),
  })
}

describe('stopAgentProcesses / stopAllAgentProcesses', () => {
  it('stops only the children spawned under the given scope', async () => {
    const mine = new SignalableChild()
    const theirs = new SignalableChild()
    const mineHandle = spawnScoped(mine, '/flights/fl_1/scout')
    spawnScoped(theirs, '/flights/fl_2/scout')

    await stopAgentProcesses('/flights/fl_1/scout')

    expect(mine.signals).toContain('SIGTERM')
    expect(theirs.signals).toEqual([])
    // Resolving means the child is GONE, not merely signalled — that guarantee is
    // the whole reason a pause awaits this.
    await expect(mineHandle.done).resolves.toMatchObject({ signal: 'SIGTERM' })
    theirs.close(0)
  })

  it('resolves without killing anything when the scope has no live child', async () => {
    const other = new SignalableChild()
    spawnScoped(other, '/flights/fl_1/scout')
    // The normal no-op: a stage whose spawn already finished, or one parked on an
    // external hand-off that never spawned at all.
    await expect(stopAgentProcesses('/flights/fl_1/docs')).resolves.toBeUndefined()
    expect(other.signals).toEqual([])
    other.close(0)
  })

  it('is a no-op once the child has exited on its own', async () => {
    const child = new SignalableChild()
    const h = spawnScoped(child, '/flights/fl_1/scout')
    child.close(0)
    await h.done
    await stopAgentProcesses('/flights/fl_1/scout')
    // Closing removed it from the registry, so the stop never re-signals a
    // finished process.
    expect(child.signals).toEqual([])
  })

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    vi.useFakeTimers()
    const wedged = new SignalableChild()
    wedged.ignoreSigterm = true
    const h = spawnScoped(wedged, '/flights/fl_1/specs-coverage')

    const stopped = stopAgentProcesses('/flights/fl_1/specs-coverage', { graceMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(wedged.signals).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(100)
    await stopped
    expect(wedged.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(h.done).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('sweeps every live child on shutdown, scoped or not', async () => {
    const scoped = new SignalableChild()
    const unscoped = new SignalableChild()
    spawnScoped(scoped, '/flights/fl_1/scout')
    spawnScoped(unscoped)

    // Deliberately not awaited: the registry is module state, so this sweep also
    // picks up children left live by every other test in this file — fakes that
    // never emit 'close', so awaiting it would hang on them rather than on
    // anything this test is about. `terminate` signals synchronously before it
    // waits, so one microtask is enough to observe the claim under test. The real
    // shutdown path does await, and is bounded by ui-command's watchdog.
    void stopAllAgentProcesses()
    await Promise.resolve()

    // The unscoped ones are portify/benchmark/commit-message spawns: they opt out
    // of scoped stop but must never outlive the server.
    expect(scoped.signals).toContain('SIGTERM')
    expect(unscoped.signals).toContain('SIGTERM')
  })

  it('does not hang when the child fails to launch while being stopped', async () => {
    const child = new FakeChild()
    const h = spawnScoped(child, '/flights/fl_1/docs')
    h.done.catch(() => { /* asserted below */ })
    const stopped = stopAgentProcesses('/flights/fl_1/docs')
    child.emit('error', new Error('ENOENT'))
    // `done` rejects rather than resolving; the stop still settles, because there
    // is no process left to wait for.
    await expect(stopped).resolves.toBeUndefined()
    await expect(h.done).rejects.toThrow('ENOENT')
  })

  it('forwards the scope to the registry only when the caller asked for one', async () => {
    const scoped = new SignalableChild()
    const unscoped = new SignalableChild()
    spawnScoped(scoped, '/flights/fl_1/prd-summary')
    spawnScoped(unscoped)

    await stopAgentProcesses('/flights/fl_1/prd-summary')

    expect(scoped.signals).toContain('SIGTERM')
    expect(unscoped.signals).toEqual([])
    unscoped.close(0)
  })
})
