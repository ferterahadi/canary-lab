import { describe, it, expect, vi } from 'vitest'
import {
  getFlightEntryOptions,
  startFlight,
  listFlights,
  getFlight,
  respondFlightCheckpoint,
  requestFlightTakeover,
  forceFlightTakeover,
  getFlightRemedy,
  applyFlightRemedy,
  resumeFlight,
  setFlightAutopilot,
  abortFlight,
  pauseFlight,
  redoFlight,
  deleteFlight,
  linkFeatureDocPath,
  getFlightAgentSession,
  planFeatures,
  getPlanFeaturesTask,
  listPlanFeatures,
  launchPlannedFeatures,
  getFlightPlanAgentSession,
} from './flights'
import { ok, fail } from './__fixtures__/response'

describe('flights api', () => {
  it('getFlightEntryOptions GETs the stage-entry menu for a feature (env optional)', async () => {
    const options = { feature: 'checkout', stages: [] }
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(ok(options)))
    const result = await getFlightEntryOptions('checkout', undefined, { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(options)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/flights/entry?feature=checkout', { method: 'GET' })

    await getFlightEntryOptions('checkout', 'staging', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://x/api/flights/entry?feature=checkout&env=staging',
      { method: 'GET' },
    )
  })

  it('startFlight POSTs the start body and returns the created manifest', async () => {
    const manifest = { flightId: 'fl_1', status: 'running' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    const body = { feature: 'checkout', repoPaths: ['/repo'], description: 'checkout flow', mode: 'jump' as const, fromStage: 'run' as const }
    const result = await startFlight(body, { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(manifest)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/flights')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(body)
  })

  it('listFlights GETs the flights index and unwraps the flights array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ flights: [{ id: 'fl_1' }] }))
    const result = await listFlights({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual([{ id: 'fl_1' }])
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/flights', { method: 'GET' })
  })

  it('getFlight GETs the flight manifest by id', async () => {
    const manifest = { id: 'fl_1', status: 'running' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    const result = await getFlight('fl_1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/flights/fl_1', { method: 'GET' })
  })

  it('respondFlightCheckpoint POSTs the checkpoint response and returns the updated manifest', async () => {
    const manifest = { id: 'fl_1', status: 'running' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    const result = await respondFlightCheckpoint('fl_1', { choice: 'approved' }, { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(manifest)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/flights/fl_1/respond')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ response: { choice: 'approved' } })
  })

  it('requestFlightTakeover records a cooperative hand-off request', async () => {
    const manifest = { id: 'fl_1', status: 'waiting-for-approval' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    await expect(requestFlightTakeover('fl_1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/takeover/request',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
  })

  it('forceFlightTakeover sends the explicit force confirmation', async () => {
    const manifest = { id: 'fl_1', status: 'running' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    await expect(forceFlightTakeover('fl_1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/takeover/force',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' },
    )
  })

  it('resumeFlight POSTs to the resume endpoint and returns the updated manifest', async () => {
    const manifest = { id: 'fl_1', status: 'running' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    const result = await resumeFlight('fl_1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/resume',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
  })

  it('abortFlight POSTs to the abort endpoint and returns the updated manifest', async () => {
    const manifest = { id: 'fl_1', status: 'aborted' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    const result = await abortFlight('fl_1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/abort',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
  })

  it('getFlightAgentSession returns the session on 200', async () => {
    const session = { sessionId: 's1', entries: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(session))
    const result = await getFlightAgentSession('fl_1', 'scout', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(session)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/agent-session?stage=scout',
      { method: 'GET' },
    )
  })

  it('getFlightAgentSession maps 404 to an absence (no agent ran)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'not found', reason: 'no-session' }))
    await expect(getFlightAgentSession('fl_1', 'scout', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual({ absent: true, reason: 'no-session' })
  })

  it('getFlightAgentSession rethrows non-404 errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(getFlightAgentSession('fl_1', 'scout', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    })
  })

  it('pauseFlight POSTs to the pause endpoint and returns the updated manifest', async () => {
    const manifest = { id: 'fl_1', status: 'paused' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    const result = await pauseFlight('fl_1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/pause',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
  })

  it('redoFlight POSTs to the redo endpoint and returns the updated manifest', async () => {
    const manifest = { id: 'fl_1', status: 'running' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    const result = await redoFlight('fl_1', undefined, { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/redo',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
  })

  it('deleteFlight DELETEs the flight and returns the deleted flag', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ deleted: true }))
    const result = await deleteFlight('fl_1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ deleted: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1',
      { method: 'DELETE' },
    )
  })

  it('linkFeatureDocPath POSTs the target path and returns the link result', async () => {
    const linkResult = { written: true, relativePath: 'docs/notes.md', linked: true }
    const fetchImpl = vi.fn().mockResolvedValue(ok(linkResult))
    const result = await linkFeatureDocPath('feat/a', '/abs/notes.md', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(linkResult)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/features/feat%2Fa/docs/link')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ path: '/abs/notes.md' })
  })

  it('planFeatures POSTs the repo paths and description and returns the task', async () => {
    const task = {
      taskId: 't1',
      repoPaths: ['/repo/a'],
      description: 'add feature x',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const fetchImpl = vi.fn().mockResolvedValue(ok(task))
    const result = await planFeatures(
      { repoPaths: ['/repo/a'], description: 'add feature x' },
      { baseUrl: 'http://x', fetchImpl },
    )
    expect(result).toEqual(task)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/flights/plan-features')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ repoPaths: ['/repo/a'], description: 'add feature x' })
  })

  it('getPlanFeaturesTask GETs the task by id', async () => {
    const task = {
      taskId: 't1',
      repoPaths: ['/repo/a'],
      description: 'add feature x',
      status: 'done',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const fetchImpl = vi.fn().mockResolvedValue(ok(task))
    const result = await getPlanFeaturesTask('t1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(task)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/plan-features/t1',
      { method: 'GET' },
    )
  })

  it('listPlanFeatures GETs the pending pre-flight tasks', async () => {
    const tasks = [{
      taskId: 't1',
      repoPaths: ['/repo/a'],
      description: 'add feature x',
      status: 'done',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]
    const fetchImpl = vi.fn().mockResolvedValue(ok({ tasks }))
    const result = await listPlanFeatures({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ tasks })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/plan-features',
      { method: 'GET' },
    )
  })

  it('launchPlannedFeatures POSTs the confirmed proposal and returns the created flight ids', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ flightIds: ['fl_1', 'fl_2'] }))
    const body = {
      features: [{ name: 'feat-a', description: 'first' }, { name: 'feat-b', description: 'second' }],
      env: 'staging',
      coverageTarget: 80,
      yolo: true,
    }
    const result = await launchPlannedFeatures('t1', body, { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ flightIds: ['fl_1', 'fl_2'] })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/flights/plan-features/t1/launch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(body)
  })

  it('getFlightPlanAgentSession returns the session on 200', async () => {
    const session = { sessionId: 's1', entries: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(session))
    const result = await getFlightPlanAgentSession('t1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(session)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/plan-features/t1/agent-session',
      { method: 'GET' },
    )
  })

  it('getFlightPlanAgentSession maps 404 to an absence (not spawned yet)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'not found', reason: 'no-session' }))
    await expect(getFlightPlanAgentSession('t1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual({ absent: true, reason: 'no-session' })
  })

  it('getFlightPlanAgentSession rethrows non-404 errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(getFlightPlanAgentSession('t1', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    })
  })

  it('getFlightRemedy GETs the read-time remedy', async () => {
    const body = { remedy: { kind: 'dirty-repos', stage: 'scout', repos: [], actions: ['stash', 'commit'] } }
    const fetchImpl = vi.fn().mockResolvedValue(ok(body))
    await expect(getFlightRemedy('fl 1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/flights/fl%201/remedy', { method: 'GET' })
  })

  it('applyFlightRemedy POSTs the chosen action and returns the resumed manifest', async () => {
    const manifest = { id: 'fl_1', status: 'running' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    await expect(applyFlightRemedy('fl_1', 'commit', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/remedy',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'commit' }) },
    )
  })

  it('setFlightAutopilot POSTs the new preference', async () => {
    const manifest = { id: 'fl_1', opts: { autopilot: false } }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    await expect(setFlightAutopilot('fl_1', false, { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/flights/fl_1/autopilot',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autopilot: false }) },
    )
  })
})
