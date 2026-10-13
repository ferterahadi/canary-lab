import { expect, it, vi } from 'vitest'
import { requestCliJson } from './request-json'

it.each([200, 201, 202, 409])('returns HTTP %s and its body for command-specific interpretation', async (status) => {
  const json = { runId: 'run-1', type: 'repo_collision_requires_choice' }
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(json), { status }))
  expect(await requestCliJson('POST', 'http://local/api/runs', { feature: 'shop' }, fetchImpl)).toEqual({ status, json })
  expect(fetchImpl).toHaveBeenCalledWith('http://local/api/runs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"feature":"shop"}',
  })
})

it.each(['GET', 'POST'] as const)('omits headers and body for a bodyless %s', async (method) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  await requestCliJson(method, 'http://local/api/flights', undefined, fetchImpl)
  expect(fetchImpl).toHaveBeenCalledWith('http://local/api/flights', { method })
})

it.each(['', 'not json'])('returns an empty object when the response cannot be decoded: %j', async (body) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 500 }))
  expect(await requestCliJson('GET', 'http://local/api/flights', undefined, fetchImpl)).toEqual({ status: 500, json: {} })
})

it('propagates a transport rejection without logging or exiting', async () => {
  const failure = new Error('connection refused')
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure)
  await expect(requestCliJson('GET', 'http://local/api/flights', undefined, fetchImpl)).rejects.toBe(failure)
})
