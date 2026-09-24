import { describe, expect, it } from 'vitest'
import { registerDiscoveryRepairTools } from './discovery-repair'
import { captureTools } from './__fixtures__/tool-group-harness'

// The three discovery-repair tools are thin over the REST routes. What they add
// is (1) the request each builds, (2) the runner-spawned refusal, and (3) the
// `log` strip that keeps a long activity rail out of the agent's context.
// Admission and the repair lifecycle itself live in the route tests.

interface Request { method: string; url: string; payload?: unknown }

function harness(responses: Array<{ statusCode: number; body: unknown }> | null) {
  const requests: Request[] = []
  const queue = responses ? [...responses] : null
  const tools = captureTools(registerDiscoveryRepairTools, queue
    ? {
        discoveryRepairRequest: async (o: Request) => {
          requests.push(o)
          return queue.shift()!
        },
      }
    : {})
  return { ...tools, requests }
}

const repair = { id: 'dr-1', feature: 'checkout', status: 'repairing', promptReady: true, log: 'a'.repeat(4000) }

describe('start_discovery_repair', () => {
  it('claims the repair for the caller\'s session by default and returns the record without its activity log', async () => {
    const { call, requests } = harness([{ statusCode: 200, body: repair }])
    const result = await call('start_discovery_repair', {
      feature: 'check out',
      mode: 'external',
      session_id: 's-1',
      client_kind: 'claude',
      conversation_name: 'repairing discovery',
      external_session_url: 'https://claude.ai/chat/1',
    })
    expect(requests).toEqual([{
      method: 'POST',
      url: '/api/features/check%20out/discovery-repairs',
      payload: { kind: 'external', sessionId: 's-1', clientKind: 'claude', conversationName: 'repairing discovery', sessionUrl: 'https://claude.ai/chat/1' },
    }])
    expect(result.id).toBe('dr-1')
    expect(result.log).toBeUndefined()
  })

  it('hands the repair to Canary\'s own agent in internal mode, carrying no session identity', async () => {
    const { call, requests } = harness([{ statusCode: 200, body: repair }])
    await call('start_discovery_repair', { feature: 'checkout', mode: 'internal', session_id: 's-1', client_kind: 'codex' })
    expect(requests[0]?.payload).toEqual({ kind: 'internal' })
  })

  it.each(['claude-pty', 'codex-pty'])('refuses %s — a runner-spawned agent cannot claim a repair, and never reaches the route', async (clientKind) => {
    const { text, requests } = harness([])
    expect(await text('start_discovery_repair', { feature: 'checkout', mode: 'external', session_id: 's-1', client_kind: clientKind }))
      .toBe('Runner-spawned agents cannot claim or start discovery repairs')
    expect(requests).toEqual([])
  })

  it('relays the route\'s refusal with its own body rather than a generic failure', async () => {
    const { text } = harness([{ statusCode: 409, body: { error: 'another session owns this repair' } }])
    expect(await text('start_discovery_repair', { feature: 'checkout', mode: 'external', session_id: 's-1', client_kind: 'claude' }))
      .toBe('{"error":"another session owns this repair"}')
  })

  it('says so when the server was built without the repair routes', async () => {
    const { text } = harness(null)
    expect(await text('start_discovery_repair', { feature: 'checkout', mode: 'external', session_id: 's-1', client_kind: 'claude' }))
      .toBe('Discovery repair is unavailable on this server')
  })
})

describe('get_discovery_repair', () => {
  it('reads one repair by id', async () => {
    const { call, requests } = harness([{ statusCode: 200, body: repair }])
    const result = await call('get_discovery_repair', { repairId: 'dr 1' })
    expect(requests).toEqual([{ method: 'GET', url: '/api/discovery-repairs/dr%201', payload: undefined }])
    expect(result.log).toBeUndefined()
  })

  it('lists a suite\'s history, stripping the log from every row', async () => {
    const { text, requests } = harness([{ statusCode: 200, body: [repair, { ...repair, id: 'dr-2' }] }])
    const rows = JSON.parse(await text('get_discovery_repair', { feature: 'check out' })) as Array<Record<string, unknown>>
    expect(requests).toEqual([{ method: 'GET', url: '/api/features/check%20out/discovery-repairs', payload: undefined }])
    expect(rows.map((r) => r.id)).toEqual(['dr-1', 'dr-2'])
    expect(rows.every((r) => r.log === undefined)).toBe(true)
  })

  it('asks for one of the two selectors rather than guessing', async () => {
    const { text, requests } = harness([])
    expect(await text('get_discovery_repair', {})).toBe('Provide repairId or feature')
    expect(requests).toEqual([])
  })

  it('passes a non-object body straight through — a bare 200 has no log to strip', async () => {
    const { text } = harness([{ statusCode: 200, body: null }])
    expect(await text('get_discovery_repair', { repairId: 'dr-1' })).toBe('null')
  })

  it('passes scalar rows in a list through untouched', async () => {
    const { text } = harness([{ statusCode: 200, body: ['dr-1'] }])
    expect(await text('get_discovery_repair', { feature: 'checkout' })).toBe('["dr-1"]')
  })
})

describe('update_discovery_repair', () => {
  it('posts the owner\'s action and message to the repair', async () => {
    const { call, requests } = harness([{ statusCode: 200, body: { ...repair, status: 'verifying' } }])
    const result = await call('update_discovery_repair', { repairId: 'dr-1', session_id: 's-1', action: 'verify', message: 'loading fixed' })
    expect(requests).toEqual([{
      method: 'POST',
      url: '/api/discovery-repairs/dr-1',
      payload: { sessionId: 's-1', action: 'verify', message: 'loading fixed' },
    }])
    expect(result.status).toBe('verifying')
  })
})
