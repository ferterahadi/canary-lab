import { ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgentCompletion } from './agent-completion'
import type { AgentProcessResult } from './agent-process'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const answer: AgentProcessResult = { code: 0, signal: null, stdout: 'stdout answer', stderr: '' }

function launch(options: {
  agent?: 'claude' | 'codex'
  signal?: AbortSignal
  cancellationMode?: 'immediate' | 'after-close'
  setup?: (outputPath: string | undefined) => void
} = {}) {
  let resolve!: (result: AgentProcessResult) => void
  let reject!: (error: Error) => void
  const done = new Promise<AgentProcessResult>((res, rej) => { resolve = res; reject = rej })
  const stop = vi.fn()
  let outputPath: string | undefined
  let onIdle!: () => void
  const start = vi.fn((context: { outputPath: string | undefined; onIdle: () => void }) => {
    outputPath = context.outputPath
    onIdle = context.onIdle
    if (outputPath) directories.push(path.dirname(outputPath))
    options.setup?.(outputPath)
    return { child: new ChildProcess(), done, stop }
  })
  const promise = runAgentCompletion({
    agent: options.agent ?? 'codex',
    signal: options.signal,
    cancellationMode: options.cancellationMode,
    idleMs: 500,
    outputDirectoryPrefix: 'cl-completion-test-',
    errorLabel: 'test agent',
    cancellationMessage: 'test cancelled',
    start,
  })
  return { promise, resolve, reject, stop, start, outputPath, idle: () => onIdle() }
}

function expectCleaned(run: ReturnType<typeof launch>): void {
  expect(fs.existsSync(path.dirname(run.outputPath!))).toBe(false)
}

describe('runAgentCompletion', () => {
  it.each([0, 2])('waits for closure after cancellation, even with exit code %i', async (code) => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const run = launch({ signal: controller.signal, cancellationMode: 'after-close' })
    const settled = vi.fn()
    const observed = run.promise.then(settled, settled)
    controller.abort()
    run.idle()
    await Promise.resolve()
    expect(run.stop).toHaveBeenCalledTimes(1)
    expect(settled).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(fs.existsSync(path.dirname(run.outputPath!))).toBe(true)
    // Neither idle nor a successful exit may bypass cancellation and read this.
    fs.mkdirSync(run.outputPath!)
    run.resolve({ ...answer, code })
    await expect(run.promise).rejects.toThrow('test cancelled')
    await observed
    expect(settled).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expectCleaned(run)
  })

  it('starts and stops an already-aborted after-close operation, then waits', async () => {
    const run = launch({ signal: AbortSignal.abort(), cancellationMode: 'after-close' })
    const settled = vi.fn()
    const observed = run.promise.then(settled, settled)
    await Promise.resolve()
    expect(run.start).toHaveBeenCalledTimes(1)
    expect(run.stop).toHaveBeenCalledTimes(1)
    expect(settled).not.toHaveBeenCalled()
    expect(fs.existsSync(path.dirname(run.outputPath!))).toBe(true)
    run.resolve(answer)
    await expect(run.promise).rejects.toThrow('test cancelled')
    await observed
    expectCleaned(run)
  })

  it('retains the launch error when an after-close operation rejects after abort', async () => {
    const controller = new AbortController()
    const run = launch({ signal: controller.signal, cancellationMode: 'after-close' })
    controller.abort()
    run.reject(new Error('spawn ENOENT'))
    await expect(run.promise).rejects.toThrow('test agent failed: spawn ENOENT')
    expectCleaned(run)
  })

  it.each([false, true])('completes normally in after-close mode (signal present: %s)', async (withSignal) => {
    const controller = new AbortController()
    const run = launch({ signal: withSignal ? controller.signal : undefined, cancellationMode: 'after-close' })
    run.resolve(answer)
    await expect(run.promise).resolves.toBe('stdout answer')
    controller.abort()
    expect(run.stop).not.toHaveBeenCalled()
    expectCleaned(run)
  })

  it('recovers Claude stream-json without allocating an answer directory', async () => {
    const run = launch({ agent: 'claude' })
    run.resolve({ ...answer, stdout: JSON.stringify({ type: 'result', result: 'recovered answer' }) + '\n' })
    await expect(run.promise).resolves.toBe('recovered answer')
    expect(run.outputPath).toBeUndefined()
  })

  it('prefers a nonblank Codex file and preserves its whitespace', async () => {
    const run = launch({ setup: (file) => fs.writeFileSync(file!, '  file answer\n') })
    run.resolve(answer)
    await expect(run.promise).resolves.toBe('  file answer\n')
    expectCleaned(run)
  })

  it.each([undefined, '', ' \n'])('uses stdout when the answer file is missing or blank (%j)', async (file) => {
    const run = launch({ setup: (target) => { if (file !== undefined) fs.writeFileSync(target!, file) } })
    run.resolve(answer)
    await expect(run.promise).resolves.toBe('stdout answer')
    expectCleaned(run)
  })

  it('reports idle before an exit failure and removes the abort listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const run = launch({ signal: controller.signal })
    run.idle()
    run.resolve({ ...answer, code: 2, stderr: 'exit failure' })
    await expect(run.promise).rejects.toThrow('test agent idle for 500ms')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(run.stop).not.toHaveBeenCalled()
    expectCleaned(run)
  })

  it.each([
    { code: 2, signal: null, stderr: 'bad model', message: 'exit code 2\nbad model' },
    { code: null, signal: 'SIGKILL' as const, stderr: '', message: 'SIGKILL' },
  ])('reports unsuccessful exits: $message', async ({ message, ...result }) => {
    const run = launch()
    run.resolve({ ...answer, ...result })
    await expect(run.promise).rejects.toThrow(`test agent failed with ${message}`)
    expectCleaned(run)
  })

  it('wraps asynchronous launch errors and cleans up', async () => {
    const run = launch()
    run.reject(new Error('spawn ENOENT'))
    await expect(run.promise).rejects.toThrow('test agent failed: spawn ENOENT')
    expectCleaned(run)
  })

  it('preserves synchronous launch failures and cleans up', async () => {
    const run = launch({ setup: () => { throw 'spawn exploded' } })
    await expect(run.promise).rejects.toBe('spawn exploded')
    expectCleaned(run)
  })

  it('rejects an unreadable answer instead of leaving completion pending', async () => {
    // A directory at the answer path reliably fails readFileSync on supported hosts.
    const run = launch({ setup: (file) => fs.mkdirSync(file!) })
    run.resolve(answer)
    await expect(run.promise).rejects.toThrow()
    expectCleaned(run)
  })

  it.each(['success', 'failure'] as const)('cancels immediately and ignores late %s', async (late) => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const run = launch({ signal: controller.signal })
    controller.abort()
    await expect(run.promise).rejects.toThrow('test cancelled')
    expect(run.stop).toHaveBeenCalledTimes(1)
    expectCleaned(run)
    // Recreate an unreadable answer to prove the late success does not read it.
    if (late === 'success') {
      fs.mkdirSync(run.outputPath!, { recursive: true })
      run.resolve(answer)
    } else run.reject(new Error('late spawn error'))
    await Promise.resolve()
    await expect(run.promise).rejects.toThrow('test cancelled')
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'failure'] as const)('observes late %s even when already aborted', async (late) => {
    const run = launch({ signal: AbortSignal.abort() })
    await expect(run.promise).rejects.toThrow('test cancelled')
    expect(run.start).toHaveBeenCalledTimes(1)
    expect(run.stop).toHaveBeenCalledTimes(1)
    if (late === 'success') run.resolve(answer)
    else run.reject(new Error('late ENOENT'))
    await Promise.resolve()
    expectCleaned(run)
  })

  it('removes the listener after success and ignores later cancellation', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const run = launch({ signal: controller.signal })
    run.resolve(answer)
    await expect(run.promise).resolves.toBe('stdout answer')
    controller.abort()
    expect(run.stop).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledTimes(1)
    expectCleaned(run)
  })

  it('rejects a cleanup failure after successful completion', async () => {
    const run = launch()
    const error = new Error('cleanup denied')
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw error })
    run.resolve(answer)
    await expect(run.promise).rejects.toBe(error)
  })

  it('retains the primary failure when cleanup also fails', async () => {
    const run = launch()
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('cleanup denied') })
    run.reject(new Error('spawn denied'))
    await expect(run.promise).rejects.toThrow('test agent failed: spawn denied')
  })
})
