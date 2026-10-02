import { expect, it, vi } from 'vitest'
import { dispatchOutputFrame } from './output-frame'

it.each(['not-json', 'null', '[]', 'true', '1', '"text"', '{}', '{"type":"unknown"}', '{"type":"data"}', '{"type":"data","chunk":1}', '{"type":"exit"}', '{"type":"exit","code":"0"}'])('ignores malformed frames without ending the stream: %s', (frame) => {
  const handlers = { onData: vi.fn(), onExit: vi.fn(), onError: vi.fn(), onReset: vi.fn() }
  const done = vi.fn()
  dispatchOutputFrame(frame, handlers, done)
  for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()
  expect(done).not.toHaveBeenCalled()
  dispatchOutputFrame('{"type":"data","chunk":"next"}', handlers, done)
  expect(handlers.onData).toHaveBeenCalledWith('next')
})

it.each([undefined, null, 42, {}, [], false])('uses a string fallback for malformed error messages (%j)', (error) => {
  const onError = vi.fn()
  dispatchOutputFrame(JSON.stringify({ type: 'error', error }), { onData: vi.fn(), onError }, vi.fn())
  expect(onError).toHaveBeenCalledWith('unknown error')
})
it.each(['', 'missing task'])('preserves string errors (%j)', (error) => {
  const onError = vi.fn()
  dispatchOutputFrame(JSON.stringify({ type: 'error', error }), { onData: vi.fn(), onError }, vi.fn())
  expect(onError).toHaveBeenCalledWith(error)
})
it('marks a valid exit complete before notifying and keeps reset optional', () => {
  const calls: unknown[] = []
  const handlers = { onData: (s: string) => calls.push(s), onExit: (code: number) => calls.push(code), onReset: () => calls.push('reset') }
  dispatchOutputFrame('{"type":"data","chunk":""}', handlers, () => calls.push('done'))
  dispatchOutputFrame('{"type":"reset"}', handlers, () => calls.push('done'))
  dispatchOutputFrame('{"type":"exit","code":0}', handlers, () => calls.push('done'))
  expect(calls).toEqual(['', 'reset', 'done', 0])
  for (const frame of ['{"type":"reset"}', '{"type":"error"}', '{"type":"exit","code":2}']) {
    dispatchOutputFrame(frame, { onData: vi.fn() }, () => calls.push('optional done'))
  }
  expect(calls.at(-1)).toBe('optional done')
})
