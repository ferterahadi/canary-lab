import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import { writeOverlay, overlayExists } from './features/portify/logic/runtime/overlay'
import { FlightRunStore } from './features/flights/logic/store'
import { FLIGHT_STAGE_KEYS } from './features/flights/logic/types'
import type { PtyFactory } from './features/runs/logic/runtime/pty-spawner'

const inertPty: PtyFactory = () => ({ pid: 0, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} })
function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected MCP text response')
  return content[0].text
}
let projectRoot: string
let app: Awaited<ReturnType<typeof createServer>>['app']
let client: Client
let suiteDir: string
// A pong follows earlier frames on the same connection, so exact-count checks
// include queued deliveries instead of passing as soon as the first arrives.
async function drainSocket(socket: Awaited<ReturnType<typeof app.injectWS>>): Promise<void> {
  await new Promise<void>((resolve) => { socket.once('pong', () => resolve()); socket.ping() })
}
beforeEach(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-adapters-'))
  suiteDir = path.join(projectRoot, 'features', 'checkout')
  fs.mkdirSync(path.join(suiteDir, 'envsets', 'local'), { recursive: true })
  fs.writeFileSync(path.join(suiteDir, 'feature.config.cjs'),
    "module.exports = { config: { name: 'checkout', description: 'fixture', envs: ['local'], repos: [], featureDir: __dirname } }")
  fs.writeFileSync(path.join(suiteDir, 'envsets', 'local', 'app.env'), 'PORT=3000\n')
  const timestamp = '2026-01-01T00:00:00Z'
  new FlightRunStore(path.join(projectRoot, 'logs')).save({
    flightId: 'external-flight', feature: 'checkout', repoPaths: [], description: 'fixture', opts: { stageProducer: 'external', env: 'local', coverageTarget: 100, yolo: false },
    status: 'waiting-for-approval', currentStage: 'scout',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' })), createdAt: timestamp, updatedAt: timestamp,
  })
  ;({ app } = await createServer({ projectRoot, ptyFactory: inertPty }))
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  client = new Client({ name: 'adapter-integration', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
})
afterEach(async () => {
  await client?.close()
  await app?.close()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('production MCP REST adapter wiring', () => {
  it('writes an envset through REST, announces it to an open socket, and exposes it through the agent reader', async () => {
    const frames: Array<{ type: string; feature?: string }> = []
    const socket = await app.injectWS('/ws/workspace', {}, {
      onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
    })
    try {
      const result = await client.callTool({ name: 'write_envset', arguments: {
        feature: 'checkout', env: 'local', slot: 'app.env', entries: [{ key: 'APP_PORT', value: '4100' }], confirm: true,
      } })
      expect(result.isError).not.toBe(true)
      expect(JSON.parse(toolText(result))).toMatchObject({ feature: 'checkout', entries: [{ key: 'APP_PORT', value: '4100' }] })
      expect(fs.readFileSync(path.join(suiteDir, 'envsets', 'local', 'app.env'), 'utf8')).toContain('APP_PORT=4100')
      await expect.poll(() => frames.some((frame) => frame.type === 'envsets-changed' && frame.feature === 'checkout')).toBe(true)
      const read = await app.inject({ method: 'GET', url: '/api/features/checkout/envsets/local/app.env' })
      expect(read.json().entries).toEqual([{ key: 'APP_PORT', value: '4100' }])
      const agentRead = await client.callTool({ name: 'get_feature_envset_summary', arguments: { feature: 'checkout' } })
      expect(JSON.parse(toolText(agentRead))).toMatchObject({ envs: [{ name: 'local', slots: [{ slot: 'app.env', preview: [{ key: 'APP_PORT', value: '********' }] }] }] })
      expect(toolText(agentRead)).not.toContain('4100')
      await drainSocket(socket)
      const change = { type: 'envsets-changed', feature: 'checkout' }
      expect(frames.filter((frame) => frame.type === 'envsets-changed')).toEqual([change])
      const repeated = await client.callTool({ name: 'write_envset', arguments: {
        feature: 'checkout', env: 'local', slot: 'app.env', entries: [{ key: 'APP_PORT', value: '4100' }], confirm: true,
      } })
      expect(repeated.isError).not.toBe(true)
      const restWrite = await app.inject({ method: 'PUT', url: '/api/features/checkout/envsets/local/app.env', payload: { entries: [{ key: 'APP_PORT', value: '4200' }] } })
      expect(restWrite.statusCode).toBe(200)
      const refused = await client.callTool({ name: 'write_envset', arguments: {
        feature: 'checkout', env: 'local', slot: 'missing.env', entries: [], confirm: true,
      } })
      expect(refused.isError).toBe(true)
      await drainSocket(socket)
      expect(frames.filter((frame) => frame.type === 'envsets-changed')).toEqual([change, change, change])
      expect(fs.readFileSync(path.join(suiteDir, 'envsets', 'local', 'app.env'), 'utf8')).toContain('APP_PORT=4200')
      const catchup = await client.callTool({ name: 'get_feature_envset_summary', arguments: { feature: 'checkout' } })
      expect(toolText(catchup)).toContain('APP_PORT')
      expect(toolText(catchup)).not.toContain('4200')
    } finally { socket.close() }
  })
  it('rejects corrupt envset metadata before mutation and exposes recovered capture and slot changes to a connected agent', async () => {
    const metadata = path.join(suiteDir, 'envsets', 'envsets.config.json')
    const source = path.join(projectRoot, 'capture.env')
    fs.writeFileSync(source, 'TOKEN=secret-value\n')
    fs.writeFileSync(metadata, 'null')
    const frames: Array<{ type: string; feature?: string }> = []
    const socket = await app.injectWS('/ws/workspace', {}, {
      onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
    })
    try {
      const capture = { feature: 'checkout', sources: [{ sourcePath: source, env: 'staging', slot: 'import.env' }] }
      const refused = await client.callTool({ name: 'capture_feature_env_files', arguments: capture })
      expect(refused.isError).toBe(true)
      expect(toolText(refused)).toBe('envsets.config.json must contain a valid JSON object')
      const readFailure = await client.callTool({ name: 'get_feature_envset_summary', arguments: { feature: 'checkout' } })
      expect(readFailure.isError).toBe(true)
      const removed = await app.inject({ method: 'DELETE', url: '/api/features/checkout/envsets/slots/app.env' })
      expect(removed.statusCode).toBe(409)
      expect(fs.existsSync(path.join(suiteDir, 'envsets', 'local', 'app.env'))).toBe(true)
      expect(fs.existsSync(path.join(suiteDir, 'envsets', 'staging'))).toBe(false)
      expect(fs.readFileSync(metadata, 'utf8')).toBe('null')
      expect(frames.filter((frame) => frame.type === 'envsets-changed')).toEqual([])

      fs.writeFileSync(metadata, '{}')
      const captured = await client.callTool({ name: 'capture_feature_env_files', arguments: capture })
      expect(captured.isError).not.toBe(true)
      expect(toolText(captured)).not.toContain('secret-value')
      await expect.poll(() => frames.some((frame) => frame.type === 'envsets-changed')).toBe(true)
      await drainSocket(socket)
      const captureEvents = [{ type: 'envsets-changed', feature: 'checkout' }, { type: 'features-changed' }]
      const mutationFrames = () => frames.filter((frame) => frame.type === 'envsets-changed' || frame.type === 'features-changed')
      expect(mutationFrames()).toEqual(captureEvents)
      const repeated = await client.callTool({ name: 'capture_feature_env_files', arguments: {
        ...capture, sources: [{ ...capture.sources[0], confirmOverwrite: true }],
      } })
      expect(repeated.isError).not.toBe(true)
      await drainSocket(socket)
      expect(mutationFrames()).toEqual([...captureEvents, ...captureEvents])
      const features = await app.inject({ method: 'GET', url: '/api/features' })
      expect(features.json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'checkout', envs: ['local', 'staging'] })]))
      const added = await app.inject({ method: 'POST', url: '/api/features/checkout/envsets/slots', payload: { sourcePath: source, slotName: 'shared.env' } })
      expect(added.statusCode).toBe(201)
      const agentRead = await client.callTool({ name: 'get_feature_envset_summary', arguments: { feature: 'checkout' } })
      expect(JSON.parse(toolText(agentRead)).envs).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'staging', slots: expect.arrayContaining([
          expect.objectContaining({ slot: 'shared.env', preview: [{ key: 'TOKEN', value: '********' }] }),
        ]) }),
      ]))
      expect(toolText(agentRead)).not.toContain('secret-value')
      expect((await app.inject({ method: 'DELETE', url: '/api/features/checkout/envsets/slots/shared.env' })).statusCode).toBe(204)
      const catchup = await client.callTool({ name: 'get_feature_envset_summary', arguments: { feature: 'checkout' } })
      expect(toolText(catchup)).not.toContain('shared.env')
      expect(toolText(catchup)).toContain('import.env')
      await drainSocket(socket)
      expect(mutationFrames()).toEqual([...captureEvents, ...captureEvents,
        { type: 'envsets-changed', feature: 'checkout' }, { type: 'envsets-changed', feature: 'checkout' }])
    } finally { socket.close() }
  })
  it.each([false, true])('keeps environment removal consistent through Flight reset with a saved Portify snapshot: %s', async (withSnapshot) => {
    if (withSnapshot) writeOverlay(suiteDir, { featureName: 'checkout', agent: 'claude', capturedAt: '2026-01-01T00:00:00Z', repos: [{ name: 'app', baseSha: 'fixture', patch: '', touchedFiles: [] }], originalConfig: fs.readFileSync(path.join(suiteDir, 'feature.config.cjs'), 'utf8') })
    const created = await app.inject({ method: 'POST', url: '/api/features/checkout/envsets', payload: { env: 'staging' } })
    expect(created.statusCode).toBe(201)
    const frames: Array<{ type: string; feature?: string }> = []
    const socket = await app.injectWS('/ws/workspace', {}, {
      onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
    })
    const changes = () => frames.filter((frame) => frame.type === 'envsets-changed' || frame.type === 'features-changed')
    const pair = [{ type: 'envsets-changed', feature: 'checkout' }, { type: 'features-changed' }]
    try {
      const removed = await app.inject({ method: 'DELETE', url: '/api/features/checkout/envsets/staging' })
      expect(removed.statusCode).toBe(204)
      expect(removed.payload).toBe('')
      await drainSocket(socket)
      expect(changes()).toEqual(pair)
      expect((await app.inject({ method: 'GET', url: '/api/features' })).json()).toEqual([
        expect.objectContaining({ name: 'checkout', envs: ['local'] }),
      ])
      const missing = await app.inject({ method: 'DELETE', url: '/api/features/checkout/envsets/staging' })
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toEqual({ error: 'env not found' })
      await drainSocket(socket)
      expect(changes()).toEqual(pair)

      // The seeded external Flight parks for its agent after reset; no agent
      // subprocess or boot is needed to exercise the production reset wiring.
      const paused = await client.callTool({ name: 'pause_flight', arguments: { flightId: 'external-flight' } })
      expect(paused.isError, toolText(paused)).not.toBe(true)
      const redone = await client.callTool({ name: 'start_flight', arguments: { feature: 'checkout', redo: true } })
      expect(redone.isError, toolText(redone)).not.toBe(true)
      await expect.poll(() => fs.existsSync(path.join(suiteDir, 'envsets', 'local'))).toBe(false)
      await expect.poll(async () => (await app.inject({ method: 'GET', url: '/api/flights/external-flight' })).json().status).toBe('waiting-for-approval')
      await drainSocket(socket)
      expect(changes()).toEqual([...pair, ...pair, ...(withSnapshot ? [{ type: 'features-changed' }] : [])])
      expect(overlayExists(suiteDir)).toBe(false)
      expect((await app.inject({ method: 'GET', url: '/api/features' })).json()).toEqual([
        expect.objectContaining({ name: 'checkout', envs: [] }),
      ])
      const read = await client.callTool({ name: 'get_feature_envset_summary', arguments: { feature: 'checkout' } })
      expect(read.isError).not.toBe(true)
      expect(JSON.parse(toolText(read))).toMatchObject({ envs: [] })
      expect(toolText(read)).not.toContain('3000')
    } finally { socket.close() }
  })
  it.each(['REST', 'MCP'] as const)('restores a Portify snapshot through %s using current environments and retains the backup on failure', async (surface) => {
    const config = path.join(suiteDir, 'feature.config.cjs')
    writeOverlay(suiteDir, { featureName: 'checkout', agent: 'claude', capturedAt: '2026-01-01T00:00:00Z', repos: [{ name: 'app', baseSha: 'fixture', patch: '', touchedFiles: [] }], originalConfig: fs.readFileSync(config, 'utf8') })
    fs.rmSync(path.join(suiteDir, 'envsets'), { recursive: true })
    fs.writeFileSync(path.join(suiteDir, 'envsets'), 'not a directory')
    const frames: Array<{ type: string }> = []
    const socket = await app.injectWS('/ws/workspace', {}, { onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))) })
    const remove = async () => {
      if (surface === 'REST') {
        const response = await app.inject({ method: 'DELETE', url: '/api/features/checkout/portify-overlay' })
        return { failed: response.statusCode !== 200, body: response.json() }
      }
      const response = await client.callTool({ name: 'remove_portification', arguments: { feature: 'checkout', confirm: true } })
      return { failed: response.isError === true, body: response.isError ? toolText(response) : JSON.parse(toolText(response)) }
    }
    try {
      expect((await remove()).failed).toBe(true)
      await drainSocket(socket)
      expect(frames.filter((frame) => frame.type === 'features-changed')).toEqual([])
      expect(overlayExists(suiteDir)).toBe(true)
      fs.rmSync(path.join(suiteDir, 'envsets'))
      fs.mkdirSync(path.join(suiteDir, 'envsets', 'staging'), { recursive: true })
      const recovered = await remove()
      expect(recovered).toMatchObject({ failed: false, body: { name: 'checkout', portified: false, reverted: true } })
      await drainSocket(socket)
      expect(frames.some((frame) => frame.type === 'features-changed')).toBe(true)
      expect(overlayExists(suiteDir)).toBe(false)
      expect((await app.inject({ method: 'GET', url: '/api/features' })).json()).toEqual([expect.objectContaining({ name: 'checkout', envs: ['staging'] })])
      const read = await client.callTool({ name: 'get_feature_envset_summary', arguments: { feature: 'checkout' } })
      expect(read.isError).not.toBe(true)
      expect(JSON.parse(toolText(read)).envs.map((env: { name: string }) => env.name)).toEqual(['staging'])
    } finally { socket.close() }
  })
  it('preserves the origin distinction between browser and MCP Flight decisions', async () => {
    const browser = await app.inject({ method: 'POST', url: '/api/flights/external-flight/pause' })
    expect(browser.statusCode).toBe(409)
    expect(browser.json().type).toBe('flight_externally_driven')
    const result = await client.callTool({ name: 'pause_flight', arguments: { flightId: 'external-flight' } })
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(toolText(result))).toMatchObject({ flightId: 'external-flight', status: 'paused' })
    const read = await app.inject({ method: 'GET', url: '/api/flights/external-flight' })
    expect(read.json()).toMatchObject({ status: 'paused', pauseReason: 'user' })
  })
  it('translates a real run-route rejection through the startRun adapter', async () => {
    // boot_services reaches the same adapter without coverage elicitation or
    // starting a subprocess: the real run route rejects the missing suite.
    const result = await client.callTool({ name: 'boot_services', arguments: { feature: 'missing-suite' } })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain('start_run failed (404):')
    expect(toolText(result)).toContain('feature not found')
  })
})
