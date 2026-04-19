import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'os'
import http from 'http'
import https from 'https'
import { EventEmitter } from 'events'
import { resolvePath, normalizeStartCommand, isHealthy } from './startup'

function mockHttpGet(
  mod: typeof http | typeof https,
  behavior: 'ok' | 'server-error' | 'timeout' | 'error',
  statusCode = 200,
) {
  return vi.spyOn(mod, 'get').mockImplementation(((...args: any[]) => {
    const cb = args[args.length - 1] as (res: any) => void
    const req: any = new EventEmitter()
    req.destroy = vi.fn()
    if (behavior === 'timeout') {
      setImmediate(() => req.emit('timeout'))
    } else if (behavior === 'error') {
      setImmediate(() => req.emit('error', new Error('boom')))
    } else {
      const res: any = new EventEmitter()
      res.resume = vi.fn()
      res.statusCode = behavior === 'server-error' ? 500 : statusCode
      setImmediate(() => cb(res))
    }
    return req
  }) as any)
}

describe('resolvePath', () => {
  it('expands leading ~/ to the home directory', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/test')
    expect(resolvePath('~/projects/foo')).toBe('/Users/test/projects/foo')
  })

  it('leaves absolute paths untouched', () => {
    expect(resolvePath('/abs/path')).toBe('/abs/path')
  })

  it('leaves a bare "~" or "~foo" (no slash) untouched', () => {
    expect(resolvePath('~')).toBe('~')
    expect(resolvePath('~foo')).toBe('~foo')
  })

  it('leaves relative paths untouched', () => {
    expect(resolvePath('relative/path')).toBe('relative/path')
  })
})

describe('normalizeStartCommand', () => {
  it('wraps a string into {command, name: fallback}', () => {
    expect(normalizeStartCommand('npm run dev', 'svc')).toEqual({
      command: 'npm run dev',
      name: 'svc',
    })
  })

  it('passes through object with explicit name', () => {
    expect(
      normalizeStartCommand({ command: 'x', name: 'real' }, 'fallback'),
    ).toEqual({ command: 'x', name: 'real' })
  })

  it('fills in name when object has none', () => {
    expect(normalizeStartCommand({ command: 'x' } as any, 'fallback')).toEqual({
      command: 'x',
      name: 'fallback',
    })
  })

  it('preserves extra fields on the object form', () => {
    const result = normalizeStartCommand(
      { command: 'x', healthCheck: { url: 'http://a', timeoutMs: 10 } } as any,
      'svc',
    )
    expect(result).toEqual({
      command: 'x',
      name: 'svc',
      healthCheck: { url: 'http://a', timeoutMs: 10 },
    })
  })
})

describe('isHealthy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses http.get for http:// URLs and resolves true for 2xx', async () => {
    const spy = mockHttpGet(http, 'ok', 200)
    await expect(isHealthy('http://x/ping')).resolves.toBe(true)
    expect(spy).toHaveBeenCalledWith(
      'http://x/ping',
      expect.objectContaining({ timeout: 1500 }),
      expect.any(Function),
    )
  })

  it('uses https.get for https:// URLs', async () => {
    const spy = mockHttpGet(https, 'ok', 204)
    await expect(isHealthy('https://x/ping')).resolves.toBe(true)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('respects timeoutMs override', async () => {
    const spy = mockHttpGet(http, 'ok', 200)
    await isHealthy('http://x/', 250)
    expect(spy.mock.calls[0][1]).toMatchObject({ timeout: 250 })
  })

  it('resolves true for any status < 500 (404 counts as "reachable")', async () => {
    mockHttpGet(http, 'ok', 404)
    await expect(isHealthy('http://x/')).resolves.toBe(true)
  })

  it('resolves false for 5xx', async () => {
    mockHttpGet(http, 'server-error')
    await expect(isHealthy('http://x/')).resolves.toBe(false)
  })

  it('resolves false when the request times out (and destroys the request)', async () => {
    let destroyed = false
    vi.spyOn(http, 'get').mockImplementation(((...args: any[]) => {
      const req: any = new EventEmitter()
      req.destroy = () => {
        destroyed = true
      }
      setImmediate(() => req.emit('timeout'))
      return req
    }) as any)
    await expect(isHealthy('http://x/')).resolves.toBe(false)
    expect(destroyed).toBe(true)
  })

  it('resolves false on request error', async () => {
    mockHttpGet(http, 'error')
    await expect(isHealthy('http://x/')).resolves.toBe(false)
  })
})
