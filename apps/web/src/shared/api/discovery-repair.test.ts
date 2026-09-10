import { afterEach, describe, it, expect, vi } from 'vitest'
import { listDiscoveryRepairs, startDiscoveryRepair, getDiscoveryRepairAgentSession } from './discovery-repair'
import { ok, fail } from './__fixtures__/response'

// Unlike its neighbours this module takes no `ClientOptions` — every call goes
// through the page's own `fetch`. Stubbing the global is therefore the only
// seam, and it exercises the real `defaultOpts()` default at the same time.
const stubFetch = (...responses: Response[]): ReturnType<typeof vi.fn> => {
  const fetchImpl = vi.fn()
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response)
  vi.stubGlobal('fetch', fetchImpl)
  return fetchImpl
}

afterEach(() => vi.unstubAllGlobals())

describe('discovery-repair api', () => {
  it('lists, starts and follows a repair on the suite-scoped routes', async () => {
    const repair = { id: 'dr_1', feature: 'shop', status: 'repairing', promptReady: true }
    const session = { agent: 'claude', sessionId: 'sid-1', events: [] }
    const fetchImpl = stubFetch(ok([repair]), ok(repair), ok(session))

    await expect(listDiscoveryRepairs('shop/eu')).resolves.toEqual([repair])
    await expect(startDiscoveryRepair('shop/eu')).resolves.toEqual(repair)
    await expect(getDiscoveryRepairAgentSession('dr 1')).resolves.toEqual(session)

    expect(fetchImpl.mock.calls).toEqual([
      ['/api/features/shop%2Feu/discovery-repairs', { method: 'GET' }],
      // `kind: 'internal'` is what makes the server spawn Canary's own agent
      // instead of parking the repair for an external editor.
      ['/api/features/shop%2Feu/discovery-repairs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"internal"}' }],
      ['/api/discovery-repairs/dr%201/agent-session', { method: 'GET' }],
    ])
  })

  it('surfaces the server refusal to start a second repair instead of resolving', async () => {
    stubFetch(fail(409, { error: 'A repair is already running for this suite' }))
    await expect(startDiscoveryRepair('shop')).rejects.toMatchObject({ status: 409, message: 'A repair is already running for this suite' })
  })

  it('surfaces a missing agent session as an error, not an empty transcript', async () => {
    stubFetch(fail(404, { error: 'repair not found' }))
    await expect(getDiscoveryRepairAgentSession('dr_gone')).rejects.toMatchObject({ status: 404 })
  })
})
