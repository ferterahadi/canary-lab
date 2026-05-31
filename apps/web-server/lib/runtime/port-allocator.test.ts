import net from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allocatePorts, findFreePort, releasePort, releasePorts } from './port-allocator'

function canBind(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, host, () => {
      srv.close(() => resolve(true))
    })
  })
}

describe('port-allocator', () => {
  const allocated: number[] = []
  afterEach(() => {
    releasePorts(allocated)
    allocated.length = 0
  })

  it('returns a usable port in the valid range', async () => {
    const port = await findFreePort()
    allocated.push(port)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
    expect(await canBind(port)).toBe(true)
  })

  it('never hands the same reserved port to two callers', async () => {
    const ports = await Promise.all(Array.from({ length: 20 }, () => findFreePort()))
    allocated.push(...ports)
    expect(new Set(ports).size).toBe(ports.length)
  })

  it('reuses a released port pool without erroring', async () => {
    const port = await findFreePort()
    releasePort(port)
    // After release the port is no longer reserved; a fresh allocation must
    // still succeed (it may or may not return the same number).
    const next = await findFreePort()
    allocated.push(next)
    expect(next).toBeGreaterThan(0)
  })

  it('allocates one distinct port per slot and collapses duplicates', async () => {
    const map = await allocatePorts([{ name: 'api' }, { name: 'admin' }, { name: 'api' }])
    allocated.push(...map.values())
    expect(map.size).toBe(2)
    expect(map.has('api')).toBe(true)
    expect(map.has('admin')).toBe(true)
    expect(map.get('api')).not.toBe(map.get('admin'))
  })
})

describe('port-allocator error paths', () => {
  afterEach(() => vi.restoreAllMocks())

  it('throws after exhausting attempts when every probe errors', async () => {
    vi.spyOn(net, 'createServer').mockImplementation(() => {
      let errCb: (() => void) | undefined
      return {
        unref() {},
        once(ev: string, cb: () => void) { if (ev === 'error') errCb = cb },
        listen() { errCb?.() },
        close(cb?: () => void) { cb?.() },
        address() { return null },
      } as unknown as net.Server
    })
    await expect(findFreePort()).rejects.toThrow(/could not find a free TCP port/)
  })

  it('skips a probed port that is already reserved', async () => {
    const taken = await findFreePort() // real allocation, stays reserved
    vi.spyOn(net, 'createServer').mockImplementation(() => ({
      unref() {},
      once() {},
      listen(_port: number, _host: string, cb: () => void) { cb() },
      close(cb?: () => void) { cb?.() },
      address() { return { port: taken, family: 'IPv4', address: '127.0.0.1' } },
    }) as unknown as net.Server)
    // Every probe returns the already-reserved port → the reserved guard skips
    // it on every attempt → exhausts and throws.
    await expect(findFreePort()).rejects.toThrow(/could not find a free TCP port/)
    vi.restoreAllMocks()
    releasePort(taken)
  })

  it('treats a non-object listen address as no port and ultimately throws', async () => {
    vi.spyOn(net, 'createServer').mockImplementation(() => ({
      unref() {},
      once() {},
      listen(_port: number, _host: string, cb: () => void) { cb() },
      close(cb?: () => void) { cb?.() },
      address() { return null },
    }) as unknown as net.Server)
    await expect(findFreePort()).rejects.toThrow(/could not find a free TCP port/)
  })
})
