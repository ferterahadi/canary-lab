import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeCliHealth } from './health-probe'
import { checkHealth } from './mcp-reachability'
import { doctor } from './mcp'
import { Writable } from 'stream'

afterEach(() => { vi.unstubAllGlobals() })

describe('probeCliHealth', () => {
  it.each(['optional', 'required'] as const)('decodes successful JSON in %s mode', async (decode) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"projectRoot":"/workspace"}'))
    expect(await probeCliHealth('http://localhost/mcp/health?profile=compact', { fetchImpl, decode })).toEqual({ ok: true, status: 200, body: { projectRoot: '/workspace' } })
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost/mcp/health?profile=compact')
  })

  it.each([200, 201, 202, 204, 409, 503])('preserves status %i without reading the body in none mode', async (status) => {
    const response = new Response(null, { status })
    const json = vi.spyOn(response, 'json')
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    expect(await probeCliHealth('http://localhost/health', { fetchImpl, decode: 'none' })).toEqual({ ok: response.ok, status, body: undefined })
    expect(json).not.toHaveBeenCalled()
  })

  it.each(['optional', 'required'] as const)('does not decode failed HTTP responses in %s mode', async (decode) => {
    const response = new Response('not JSON', { status: 409 })
    const json = vi.spyOn(response, 'json')
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    expect(await probeCliHealth('http://localhost/health', { fetchImpl, decode })).toEqual({ ok: false, status: 409, body: undefined })
    expect(json).not.toHaveBeenCalled()
  })

  it('tolerates optional decoding failures and propagates the original required decoding error', async () => {
    const failure = new SyntaxError('invalid JSON')
    const response = new Response('invalid JSON')
    vi.spyOn(response, 'json').mockRejectedValue(failure)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(probeCliHealth('http://localhost/health', { fetchImpl, decode: 'optional' })).resolves.toMatchObject({ body: null })
    await expect(probeCliHealth('http://localhost/health', { fetchImpl, decode: 'required' })).rejects.toBe(failure)
  })

  it('forwards the exact URL and signal to global fetch and propagates transport and abort failures', async () => {
    const url = new URL('http://localhost/mcp/health?profile=compact')
    const signal = AbortSignal.abort()
    const failure = new DOMException('aborted', 'AbortError')
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure)
    vi.stubGlobal('fetch', fetchImpl)
    await expect(probeCliHealth(url, { signal, decode: 'none' })).rejects.toBe(failure)
    expect(fetchImpl).toHaveBeenCalledWith(url, { signal })
    const offline = new TypeError('offline')
    fetchImpl.mockRejectedValue(offline)
    await expect(probeCliHealth(url, { decode: 'required' })).rejects.toBe(offline)
  })
})

describe('reachability decoding policy', () => {
  it.each(['invalid', 'null', '{}', '{"projectRoot":12}'])('accepts successful health with body %s without inventing a workspace', async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    expect(await checkHealth('http://localhost/mcp?profile=compact#fragment', fetchImpl)).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost/mcp/health?profile=compact')
  })

  it('retains status and transport recovery messages', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('bad', { status: 503 }))
    expect(await checkHealth('http://localhost/mcp', fetchImpl)).toEqual({ ok: false, error: '/mcp/health returned 503' })
    fetchImpl.mockRejectedValue(new Error('offline'))
    expect(await checkHealth('http://localhost/mcp', fetchImpl)).toEqual({ ok: false, error: 'offline' })
  })
})

it('doctor rejects malformed JSON after tolerant reachability succeeds', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('invalid JSON'))
  let output = ''
  const stderr = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback() } })
  expect(await doctor('http://localhost/mcp', { fetch: fetchImpl, stderr, autoStartUi: false, autoStartEligible: false })).toBe(false)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(output).toContain('MCP doctor failed')
  expect(output).toContain('JSON')
})
