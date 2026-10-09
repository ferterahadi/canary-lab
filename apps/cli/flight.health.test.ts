import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { main } from './flight'
import { relaunchUiDetached } from './ui-command'
import { requestCliJson } from './request-json'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'

vi.mock('./ui-command', () => ({ relaunchUiDetached: vi.fn() }))
vi.mock('./request-json', () => ({ requestCliJson: vi.fn() }))
vi.mock('../../shared/cli-ui/ui', () => ({ banner: vi.fn(), section: vi.fn(), ok: vi.fn(), fail: vi.fn(), info: vi.fn(), dim: (s: string) => s, line: vi.fn() }))

const tempDir = trackTempDirs('flight-health-')
let root: string
const reachedFlightRequests = new Error('health complete')
beforeEach(() => {
  root = tempDir()
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'canary-lab': '*' } }))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.spyOn(process, 'exit').mockImplementation(() => { throw reachedFlightRequests })
  vi.useFakeTimers()
  vi.mocked(requestCliJson).mockRejectedValue(reachedFlightRequests)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('accepts healthy HTTP without decoding JSON or starting a server', async () => {
  const response = new Response('not JSON')
  const json = vi.spyOn(response, 'json')
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchImpl)
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  await expect(main([root, 'checkout'])).rejects.toBe(reachedFlightRequests)
  expect(fetchImpl).toHaveBeenCalledOnce()
  expect(timeout).toHaveBeenCalledWith(2000)
  expect(requestCliJson).toHaveBeenCalledOnce()
  expect(json).not.toHaveBeenCalled()
  expect(relaunchUiDetached).not.toHaveBeenCalled()
})

it('retries every two seconds after startup and proceeds when health succeeds', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(new Response('ready'))
  vi.stubGlobal('fetch', fetchImpl)
  const outcome = main([root, 'checkout']).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(1999)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(relaunchUiDetached).toHaveBeenCalledWith(root)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await outcome).toBe(reachedFlightRequests)
  expect(fetchImpl).toHaveBeenCalledTimes(3)
  expect(requestCliJson).toHaveBeenCalledOnce()
})

it('exits after thirty failed startup polls without issuing flight requests', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
  vi.stubGlobal('fetch', fetchImpl)
  const exit = new Error('exit')
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw exit })
  const outcome = main([root, 'checkout']).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await outcome).toBe(exit)
  expect(fetchImpl).toHaveBeenCalledTimes(31)
  expect(relaunchUiDetached).toHaveBeenCalledOnce()
  expect(exitSpy).toHaveBeenCalledWith(1)
  expect(requestCliJson).not.toHaveBeenCalled()
})
