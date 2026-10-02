import { EventEmitter } from 'events'
import { expect, it, vi } from 'vitest'
import { commandResult } from './command-result'

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: mocks.execFile }))

it.each(['callback', 'event'] as const)('retains the first settled result when %s arrives first', async (first) => {
  let callback!: (error: unknown, stdout: unknown, stderr: unknown) => void
  const child = new EventEmitter()
  mocks.execFile.mockImplementation((_command, _args, _options, cb) => { callback = cb; return child })
  const pending = commandResult('tool', ['read'], { cwd: '/work' }, 127)
  const complete = () => callback(null, Buffer.from('output'), Buffer.from('warning'))
  const fail = () => child.emit('error', new Error('missing'))
  if (first === 'callback') { complete(); fail() } else { fail(); complete() }
  expect(await pending).toEqual(first === 'callback'
    ? { code: 0, stdout: 'output', stderr: 'warning' }
    : { code: 127, stdout: '', stderr: 'missing' })
})
it.each([7, 'ENOENT', undefined])('normalizes callback error codes (%s)', async (code) => {
  mocks.execFile.mockImplementation((_command, _args, _options, cb) => {
    cb(Object.assign(new Error('failed'), { code }), '', 'failure')
    return new EventEmitter()
  })
  expect(await commandResult('tool', [], {}, 127)).toEqual({ code: typeof code === 'number' ? code : 1, stdout: '', stderr: 'failure' })
})
it('retains rejection for a synchronous execFile argument error', async () => {
  mocks.execFile.mockImplementation(() => { throw new Error('invalid argument') })
  await expect(commandResult('tool', [], {}, 1)).rejects.toThrow('invalid argument')
})
