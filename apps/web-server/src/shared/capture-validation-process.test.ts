import { EventEmitter } from 'events'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { captureValidationProcess, type ValidationProcessOptions } from './capture-validation-process'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
  const options: ValidationProcessOptions = { command: 'fixture', args: ['--check'], cwd: '/tmp/validation-fixture', timeoutMs: 50, spawn }
  return { child, spawn, options }
}

it.each([0, 1, null])('captures separate streams and their arrival order on exit %s', async (code) => {
  const { child, spawn, options } = fixture()
  const env = { VALIDATION_FIXTURE: 'yes' }
  const pending = captureValidationProcess({ ...options, env })
  expect(spawn).toHaveBeenCalledExactlyOnceWith('fixture', ['--check'], { cwd: options.cwd, env })
  child.stdout.emit('data', Buffer.from('first'))
  child.stderr.emit('data', Buffer.from('second'))
  child.stdout.emit('data', Buffer.from('third'))
  child.emit('close', code)
  child.emit('error', new Error('late'))
  child.emit('close', 99)
  await expect(pending).resolves.toEqual({ kind: 'exit', code, stdout: 'firstthird', stderr: 'second', combined: 'firstsecondthird' })
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(100)
  expect(child.kill).not.toHaveBeenCalled()
})

it('preserves emitted spawn errors and ignores the following close', async () => {
  const { child, spawn, options } = fixture()
  const pending = captureValidationProcess(options)
  expect(spawn).toHaveBeenCalledExactlyOnceWith('fixture', ['--check'], { cwd: options.cwd })
  const error = new Error('cannot spawn')
  child.emit('error', error)
  child.emit('close', -2)
  await expect(pending).resolves.toEqual({ kind: 'spawn-error', error, stdout: '', stderr: '', combined: '' })
  expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])('settles immediately on timeout even if kill throws: %s', async (throws) => {
  const { child, options } = fixture()
  if (throws) child.kill.mockImplementation(() => { throw new Error('kill failed') })
  const pending = captureValidationProcess(options)
  child.stderr.emit('data', Buffer.from('before timeout'))
  vi.advanceTimersByTime(50)
  await expect(pending).resolves.toEqual({ kind: 'timeout', stdout: '', stderr: 'before timeout', combined: 'before timeout' })
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  child.emit('close', null)
  child.emit('error', new Error('late error'))
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects synchronous spawn exceptions without starting a timer', async () => {
  const { options } = fixture()
  const error = new Error('invalid invocation')
  await expect(captureValidationProcess({ ...options, spawn: () => { throw error } })).rejects.toBe(error)
  expect(vi.getTimerCount()).toBe(0)
})
