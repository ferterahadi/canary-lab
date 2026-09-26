import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
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
