import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { PtyHandle } from '../../apps/web-server/src/features/runs/logic/runtime/pty-spawner'
import { hasProbeResult, hasPinnedProbeResult, pinnedProbeOutcome, probeOutcome, waitForPinnedProbe } from './interactive-preflight'
import { trackTempDirs } from '../test-helpers/temp-dir'

const tempDir = trackTempDirs('probe-')

it('requires a successful native tool result rather than a completion claim or echoed prompt', () => {
  const row = (type: string, block: unknown): string => JSON.stringify({ type, message: { content: [block] } })
  expect(hasProbeResult(row('assistant', { type: 'text', text: 'PROBE_OK' }), 'PROBE_OK')).toBe(false)
  expect(hasProbeResult(row('user', { type: 'text', text: 'PROBE_OK' }), 'PROBE_OK')).toBe(false)
  expect(hasProbeResult(JSON.stringify({ type: 'user', message: { content: 'PROBE_OK' } }), 'PROBE_OK')).toBe(false)
  expect(hasProbeResult(row('user', { type: 'tool_result', content: 'PROBE_OK', is_error: true }), 'PROBE_OK')).toBe(false)
  expect(hasProbeResult('partial json\n' + row('user', { type: 'tool_result', content: 'PROBE_OK' }), 'PROBE_OK')).toBe(true)
})

it('stops on any failed result for the exact probe call', () => {
  const command = 'cd /synthetic/attempt && /bin/bash ./denial-probe.sh'
  const call = (id: string, input: string): string => JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id, name: 'Bash', input: { command: input } },
  ] } })
  const result = (id: string, content: unknown, isError = false): string => JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: id, content, is_error: isError },
  ] } })
  const denial = 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass].'
  expect(probeOutcome(result('probe', denial, true), 'PROBE_OK', command)).toEqual({ status: 'pending' })
  expect(probeOutcome([call('other', 'pwd'), result('other', denial, true)].join('\n'), 'PROBE_OK', command)).toEqual({ status: 'pending' })
  expect(probeOutcome([call('probe', command), result('other', denial, true)].join('\n'), 'PROBE_OK', command)).toEqual({ status: 'pending' })
  expect(probeOutcome([call('probe', command), result('probe', 'Operation not permitted', true)].join('\n'), 'PROBE_OK', command))
    .toEqual({ status: 'failed', reason: 'Operation not permitted', toolId: 'probe' })
  expect(probeOutcome([call('probe', command), result('probe', 'Permission to use Bash has been denied.', true)].join('\n'), 'PROBE_OK', command))
    .toEqual({ status: 'denied', reason: 'Permission to use Bash has been denied.', toolId: 'probe' })
  expect(probeOutcome([call('probe', command), result('probe', [{ type: 'text', text: denial }], true)].join('\n'), 'PROBE_OK', command))
    .toEqual({ status: 'denied', reason: 'Auto-Mode Bypass', toolId: 'probe' })
  expect(probeOutcome([call('probe', command), result('probe', 'PROBE_OK')].join('\n'), 'PROBE_OK', command)).toEqual({ status: 'passed' })
  expect(probeOutcome([call('probe', command), '{"type":"user","message":'].join('\n'), 'PROBE_OK', command)).toEqual({ status: 'pending' })
  expect(probeOutcome([call('probe', command), result('probe', denial, true), result('probe', 'PROBE_OK')].join('\n'), 'PROBE_OK', command))
    .toEqual({ status: 'denied', reason: 'Auto-Mode Bypass', toolId: 'probe' })
})

it.each(['poll', 'exit'] as const)('records a native denial before the %s path can report timeout or exit', async (finish) => {
  vi.useFakeTimers()
  const root = tempDir('probe-denial-')
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'config'))
  try {
    const cwd = path.join(root, 'run')
    const sessionId = 'pinned'
    const command = 'run exact probe'
    const logPath = path.join(root, 'config/projects/shortened-hash/pinned.jsonl')
    let emitExit: ((event: { exitCode: number; signal?: number }) => void) | undefined
    const dispose = vi.fn()
    const pty: Pick<PtyHandle, 'onExit'> = { onExit: (cb) => { emitExit = cb; return { dispose } } }
    const result = waitForPinnedProbe({ pty, cwd, sessionId, marker: 'PROBE_OK', command, work: root, timeoutMs: 120_000 })
      .then(() => 'passed', (error: Error) => error)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'probe', name: 'Bash', input: { command } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'probe', is_error: true,
        content: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass].' }] } }),
    ].join('\n'))
    if (finish === 'poll') await vi.advanceTimersByTimeAsync(500)
    else emitExit?.({ exitCode: 1 })
    expect((await result as Error).message).toContain('Interactive preflight denied: Auto-Mode Bypass')
    expect(JSON.parse(fs.readFileSync(path.join(root, 'permission-denial.json'), 'utf8'))).toMatchObject({
      status: 'denied', reason: 'Auto-Mode Bypass', toolId: 'probe', sessionId,
    })
    expect(dispose).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  }
})


it('finds a probe written later under an opaque native project slug and captures its usage', async () => {
  const { pinnedClaudeSessionRef, captureAttemptSessions } = await import('./agents')
  const root = tempDir('probe-session-')
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'config'))
  try {
    const cwd = path.join(root, 'long-nested-run')
    expect(hasPinnedProbeResult(cwd, 'pinned', 'PROBE_OK')).toBe(false)
    expect(pinnedProbeOutcome(cwd, 'pinned', 'PROBE_OK', 'run probe')).toEqual({ status: 'pending' })
    const logPath = path.join(root, 'config/projects/shortened-hash/pinned.jsonl')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    const call = { type: 'assistant', sessionId: 'pinned', isSidechain: false, message: { content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'run probe' } }] } }
    const row = { type: 'user', sessionId: 'pinned', isSidechain: false, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'PROBE_OK' }] } }
    const usage = { type: 'assistant', sessionId: 'pinned', isSidechain: false, message: { id: 'm', content: [], usage: { input_tokens: 10, output_tokens: 2 } } }
    fs.writeFileSync(logPath, JSON.stringify(call) + '\n' + JSON.stringify(row) + '\n' + JSON.stringify(usage))
    expect(hasPinnedProbeResult(cwd, 'pinned', 'PROBE_OK')).toBe(true)
    expect(pinnedProbeOutcome(cwd, 'pinned', 'PROBE_OK', 'run probe')).toEqual({ status: 'passed' })
    expect(hasPinnedProbeResult(cwd, 'another-session', 'PROBE_OK')).toBe(false)
    expect(hasPinnedProbeResult(cwd, 'pinned', 'WRONG_MARKER')).toBe(false)
    const ref = pinnedClaudeSessionRef(cwd, 'pinned')
    expect(ref.logPath).toBe(logPath)
    expect(captureAttemptSessions('claude', cwd, '2026-01-01T00:00:00Z', path.join(root, 'evidence'), { model: 'fixture', effort: 'high' }, ref)).toMatchObject({ input: 10, output: 2 })
  } finally { vi.unstubAllEnvs() }
})
