import { describe, it, expect, vi } from 'vitest'
import {
  getFeatureTests,
  getFeatureConfig,
  getFeatureConfigDoc,
  putFeatureConfigDoc,
  removePortifyOverlay,
  deleteFeature,
  getPlaywrightConfig,
  putPlaywrightConfig,
  getMcpHealth,
  getEnvsetsIndex,
  getEnvsetSlot,
  createEnvset,
  deleteEnvset,
  addEnvsetSlot,
  deleteEnvsetSlot,
  browseDir,
  readDotenvFile,
  putEnvsetSlot,
  getOnboardingSamples,
  getAgentProbe,
  getProjectConfig,
  putProjectConfig,
  changeProjectPort,
} from './config'
import { ok, fail } from './__fixtures__/response'

describe('config api', () => {
  it('changeProjectPort returns the restart payload on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ restarting: true, port: 8300, newOrigin: 'http://localhost:8300' }))
    const result = await changeProjectPort(8300, false, { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ restarting: true, port: 8300, newOrigin: 'http://localhost:8300' })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/project-config/port', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 8300, confirm: false }),
    })
  })

  it('changeProjectPort surfaces a 409 confirmation payload instead of throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(409, { needsConfirm: true, activeRuns: 2 }))
    const result = await changeProjectPort(8300, false, { fetchImpl })
    expect(result).toEqual({ needsConfirm: true, activeRuns: 2 })
  })

  it('changeProjectPort rethrows non-409 errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(400, { error: 'port must be an integer between 1 and 65535' }))
    await expect(changeProjectPort(99999, false, { fetchImpl })).rejects.toMatchObject({ status: 400 })
  })

  it('getFeatureTests URL-encodes the feature name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await getFeatureTests('a/b c', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/features/a%2Fb%20c/tests',
      { method: 'GET' },
    )
  })

  it('getFeatureTests throws ApiError on 404 with non-JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('not found', { status: 404 }),
    )
    await expect(getFeatureTests('x', { fetchImpl })).rejects.toMatchObject({
      status: 404,
      body: 'not found',
    })
  })

  it('getMcpHealth checks the compact MCP health endpoint', async () => {
    const health = {
      ok: true,
      server: { name: 'canary-lab' },
      profile: 'compact',
      clientKind: 'other',
      toolCount: 1,
      tools: ['exec'],
      activeSessions: 0,
      projectRoot: '/workspace',
    }
    const fetchImpl = vi.fn().mockResolvedValue(ok(health))

    await expect(getMcpHealth({ baseUrl: 'http://x', fetchImpl })).resolves.toEqual(health)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/mcp/health?profile=compact', { method: 'GET' })
  })

  it('getFeatureConfig returns the raw config doc', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ path: '/p', content: 'x', format: 'cjs' }))
    const r = await getFeatureConfig('a', { fetchImpl })
    expect(r.format).toBe('cjs')
    expect(fetchImpl).toHaveBeenCalledWith('/api/features/a/config', { method: 'GET' })
  })

  it('getFeatureConfigDoc + putFeatureConfigDoc round-trip', async () => {
    const doc = { path: '/p', content: 'c', format: 'cjs', parsed: { value: { name: 'a' }, complexFields: [] } }
    const fetchImpl = vi.fn().mockImplementation(async () => ok(doc))
    expect(await getFeatureConfigDoc('a', { fetchImpl })).toEqual(doc)
    await putFeatureConfigDoc('a', { name: 'b' }, { fetchImpl })
    const init = fetchImpl.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ value: { name: 'b' } })
  })

  it('deleteFeature DELETEs with the typed confirmation name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteFeature('a/b', 'a/b', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/features/a%2Fb', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName: 'a/b' }),
    })
  })

  it('getPlaywrightConfig + putPlaywrightConfig', async () => {
    const doc = { path: '/p', content: 'c', format: 'ts', parsed: { value: { testDir: './e2e' }, complexFields: [] } }
    const fetchImpl = vi.fn().mockImplementation(async () => ok(doc))
    expect(await getPlaywrightConfig('a', { fetchImpl })).toEqual(doc)
    await putPlaywrightConfig('a', { testDir: './t' }, { fetchImpl })
    const init = fetchImpl.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('PUT')
  })

  it('getEnvsetsIndex / getEnvsetSlot / putEnvsetSlot', async () => {
    const idx = { envs: [], slotDescriptions: {}, slotTargets: {} }
    const slot = { path: '/p', content: '', entries: [], unparsedLines: [] }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok(idx))
      .mockResolvedValueOnce(ok(slot))
      .mockResolvedValueOnce(ok(slot))
    expect(await getEnvsetsIndex('a', { fetchImpl })).toEqual(idx)
    expect(await getEnvsetSlot('a', 'local', 'app.env', { fetchImpl })).toEqual(slot)
    await putEnvsetSlot('a', 'local', 'app.env', [{ key: 'X', value: '1' }], { fetchImpl })
    const init = fetchImpl.mock.calls[2][1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ entries: [{ key: 'X', value: '1' }] })
  })

  it('createEnvset POSTs the env name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ env: 'staging' }))
    const r = await createEnvset('alpha', 'staging', { fetchImpl })
    expect(r).toEqual({ env: 'staging' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/features/alpha/envsets')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ env: 'staging' })
  })

  it('deleteEnvset DELETEs the env folder', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteEnvset('alpha', 'staging', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/features/alpha/envsets/staging', { method: 'DELETE' })
  })

  it('getProjectConfig GETs /api/project-config', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ healAgent: 'auto', editor: 'auto', personalWikiPath: null }))
    const r = await getProjectConfig({ fetchImpl })
    expect(r).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })
    expect(fetchImpl).toHaveBeenCalledWith('/api/project-config', { method: 'GET' })
  })

  it('getAgentProbe GETs /api/agent-probe, with ?fresh=1 only when forced', async () => {
    const snap = {
      probedAt: 'now',
      claude: { agent: 'claude', state: 'ok', binaryPath: '/bin/claude', version: '1', models: [], remedy: null },
      codex: { agent: 'codex', state: 'missing', binaryPath: null, version: null, models: [], remedy: 'install' },
    }
    const fetchImpl = vi.fn().mockResolvedValue(ok(snap))
    await expect(getAgentProbe(false, { fetchImpl })).resolves.toEqual(snap)
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/agent-probe', { method: 'GET' })
    fetchImpl.mockResolvedValue(ok(snap))
    await getAgentProbe(true, { fetchImpl })
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/agent-probe?fresh=1', { method: 'GET' })
  })

  it('getOnboardingSamples GETs /api/onboarding', async () => {
    const samples = { sampleSuite: 'storefront-journey', sampleFlightRepo: '/w/flight-app', sampleFlightDescription: 'd', workflows: [], session: { active: null, completed: {} } }
    const fetchImpl = vi.fn().mockResolvedValue(ok(samples))
    await expect(getOnboardingSamples({ fetchImpl })).resolves.toEqual(samples)
    expect(fetchImpl).toHaveBeenCalledWith('/api/onboarding', { method: 'GET' })
  })

  it('putProjectConfig sends the partial config as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ healAgent: 'manual', editor: 'cursor', personalWikiPath: '/tmp/wiki' }))
    await putProjectConfig({ healAgent: 'manual', editor: 'cursor', personalWikiPath: '/tmp/wiki' }, { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/project-config')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ healAgent: 'manual', editor: 'cursor', personalWikiPath: '/tmp/wiki' })
  })

  it('addEnvsetSlot POSTs the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ slot: 'app.env' }, 201))
    const r = await addEnvsetSlot(
      'alpha',
      { sourcePath: '/x/app.env', slotName: 'app.env', target: '/abs', description: 'd' },
      { fetchImpl },
    )
    expect(r).toEqual({ slot: 'app.env' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/features/alpha/envsets/slots')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({ sourcePath: '/x/app.env' })
  })

  it('deleteEnvsetSlot DELETEs and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteEnvsetSlot('alpha', 'app.env', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/features/alpha/envsets/slots/app.env',
      { method: 'DELETE' },
    )
  })

  it('browseDir GETs with the dir query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ dir: '/x', parent: '/', entries: [] }))
    await browseDir('/x y', { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/fs/browse?dir=%2Fx%20y')
  })

  it('browseDir omits ?dir= when path is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ dir: '/', parent: null, entries: [] }))
    await browseDir('', { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/fs/browse')
  })

  it('readDotenvFile GETs the encoded dotenv path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ path: '/repo/.env.local', entries: [], unparsedLines: [] }))
    await readDotenvFile('/repo/.env local', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/fs/read-dotenv?path=%2Frepo%2F.env%20local',
      { method: 'GET' },
    )
  })

  it('removePortifyOverlay DELETEs the portify-overlay endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ name: 'myfeat', portified: false, reverted: true }))
    const result = await removePortifyOverlay('myfeat', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ name: 'myfeat', portified: false, reverted: true })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/myfeat/portify-overlay', { method: 'DELETE' })
  })
})
