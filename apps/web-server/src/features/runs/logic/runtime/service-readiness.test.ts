import { afterEach, describe, expect, it, vi } from 'vitest'
import { isHealthy, isTcpListening } from '../../../../shared/launcher-startup'
import { waitForServiceReadiness, type ReadinessInterruption } from './service-readiness'

vi.mock('../../../../shared/launcher-startup', async (original) => ({
  ...await original<typeof import('../../../../shared/launcher-startup')>(),
  isHealthy: vi.fn(async () => true),
  isTcpListening: vi.fn(async () => true),
}))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

function clock() {
  let time = 0
  const sleeps: number[] = []
  return { sleeps, now: () => time, delay: async (ms: number) => { sleeps.push(ms); time += ms },
    advance: (ms: number) => { time += ms } }
}
const http = { http: { url: 'http://example.test/health', timeoutMs: 25 } }

describe('service readiness', () => {
  it('dispatches HTTP and TCP probes with their configured targets and timeouts', async () => {
    await expect(waitForServiceReadiness({ probe: http, interruption: () => null })).resolves.toEqual({ status: 'ready' })
    expect(isHealthy).toHaveBeenCalledWith(http.http.url, 25)
    await expect(waitForServiceReadiness({ probe: { tcp: { port: '3000', host: 'db.local', timeoutMs: 10 } }, interruption: () => null })).resolves.toEqual({ status: 'ready' })
    expect(isTcpListening).toHaveBeenCalledWith(3000, 'db.local', 10)
    await waitForServiceReadiness({ probe: { tcp: { port: 3001 } }, interruption: () => null })
    expect(isTcpListening).toHaveBeenCalledWith(3001, '127.0.0.1', undefined)
  })

  it('uses the injected HTTP checker without opening another transport', async () => {
    const time = clock(); const healthCheck = vi.fn(async () => time.now() >= 300)
    await expect(waitForServiceReadiness({ ...time, probe: http, healthCheck, interruption: () => null })).resolves.toEqual({ status: 'ready' })
    expect(time.sleeps).toEqual([100, 200])
    expect(isHealthy).not.toHaveBeenCalled()
  })

  it.each(['http', 'tcp'] as const)('times out a failed %s transport at its explicit deadline', async (transport) => {
    const time = clock()
    const checker = transport === 'http' ? isHealthy : isTcpListening
    vi.mocked(checker).mockResolvedValueOnce(false)
    const probe = transport === 'http'
      ? { http: { ...http.http, deadlineMs: 25 } }
      : { tcp: { port: 3000, deadlineMs: 25 } }
    await expect(waitForServiceReadiness({ ...time, probe, interruption: () => null }))
      .resolves.toEqual({ status: 'timed-out' })
    expect(time.sleeps).toEqual([25])
    expect(checker).toHaveBeenCalledTimes(1)
  })

  it('backs off to the shared ceiling and bounds the last sleep by the probe deadline', async () => {
    const time = clock()
    const result = await waitForServiceReadiness({ ...time, probe: { http: { ...http.http, deadlineMs: 2650 } },
      attempt: async () => false, deadlineMs: 10_000, interruption: () => null })
    expect(result).toEqual({ status: 'timed-out' })
    expect(time.sleeps).toEqual([100, 200, 400, 800, 1000, 150])
    expect(time.now()).toBe(2650)
  })

  it.each([[40, 95, [40, 40, 15]], [0, 2, [1, 1]]])('honors a %s ms caller ceiling', async (pollIntervalMs, deadlineMs, sleeps) => {
    const time = clock()
    await expect(waitForServiceReadiness({ ...time, probe: http, pollIntervalMs: pollIntervalMs as number,
      deadlineMs: deadlineMs as number, attempt: async () => false, interruption: () => null })).resolves.toEqual({ status: 'timed-out' })
    expect(time.sleeps).toEqual(sleeps)
  })

  it('times out at the shared default deadline when none is configured', async () => {
    const time = clock()
    await expect(waitForServiceReadiness({ ...time, probe: http, attempt: async () => false, interruption: () => null })).resolves.toEqual({ status: 'timed-out' })
    expect(time.now()).toBe(60_000)
  })

  it('uses the real timer adapter with an injected probe', async () => {
    vi.useFakeTimers()
    const attempt = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const pending = waitForServiceReadiness({ probe: http, attempt, interruption: () => null })
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toEqual({ status: 'ready' })
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cancelled', 'service-failed'] as const)('does not start a probe after %s', async (status) => {
    const attempt = vi.fn(async () => true)
    await expect(waitForServiceReadiness({ probe: http, attempt, interruption: () => ({ status }) })).resolves.toEqual({ status })
    expect(attempt).not.toHaveBeenCalled()
  })

  it.each(['cancelled', 'service-failed'] as const)('rejects a green probe when %s was observed while it ran', async (status) => {
    let stopped: ReadinessInterruption | null = null
    await expect(waitForServiceReadiness({ probe: http,
      attempt: async () => { stopped = { status }; return true }, interruption: () => stopped,
    })).resolves.toEqual({ status })
  })

  it('does not sleep again when a failed probe has used the remaining deadline', async () => {
    const time = clock()
    await expect(waitForServiceReadiness({ ...time, probe: http, deadlineMs: 10,
      attempt: async () => { time.advance(10); return false }, interruption: () => null,
    })).resolves.toEqual({ status: 'timed-out' })
    expect(time.sleeps).toEqual([])
  })

  it('reports an interruption that arrives during the final sleep', async () => {
    const time = clock()
    await expect(waitForServiceReadiness({ ...time, probe: http, deadlineMs: 1,
      attempt: async () => false, interruption: () => time.now() > 0 ? { status: 'cancelled' } : null,
    })).resolves.toEqual({ status: 'cancelled' })
  })
})
