import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import { FlightRunStore } from './features/flights/logic/store'
import type { FlightManifest } from './features/flights/logic/types'

let root: string
let suite: string
let outside: string
let store: FlightRunStore
let app: Awaited<ReturnType<typeof createServer>>['app']
let client: Client
let address: string
const ptyFactory = vi.fn(() => { throw new Error('Suite deletion must not start a process') })

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected MCP text response')
  return result.content[0].text
}
async function connect() {
  const connected = new Client({ name: 'suite-deletion-test', version: '1.0.0' }, { capabilities: {} })
  await connected.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
  return connected
}
async function remove(transport: 'REST' | 'MCP', feature: string, confirmName = feature) {
  if (transport === 'MCP') {
    const result = await client.callTool({ name: 'delete_feature', arguments: { feature, confirmName } })
    return { failed: result.isError === true, body: text(result) }
  }
  const response = await app.inject({ method: 'DELETE', url: `/api/features/${feature}`, payload: { confirmName } })
  return { failed: response.statusCode >= 400, status: response.statusCode, body: response.payload }
}

beforeEach(async () => {
  ptyFactory.mockClear()
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-delete-server-')))
  const projectRoot = path.join(root, 'workspace')
  const featuresDir = path.join(projectRoot, 'features')
  const logsDir = path.join(root, 'logs')
  suite = path.join(featuresDir, 'checkout')
  outside = path.join(root, 'linked-source')
  fs.mkdirSync(outside)
  for (const name of ['checkout', 'linked', 'busy']) {
    const discovery = path.join(featuresDir, name)
    fs.mkdirSync(discovery, { recursive: true })
    fs.writeFileSync(path.join(discovery, 'feature.config.cjs'),
      `exports.config = { name: '${name}', repos: [], featureDir: ${JSON.stringify(name === 'linked' ? outside : discovery)} }`)
  }
  store = new FlightRunStore(logsDir)
  for (const [flightId, feature, status] of [
    ['checkout-1', 'checkout', 'done'], ['checkout-2', 'checkout', 'paused'],
    ['linked-1', 'linked', 'done'], ['busy-1', 'busy', 'waiting-for-approval'],
  ] as const) {
    store.save({ flightId, feature, status, repoPaths: [], description: 'fixture',
      opts: { env: 'local', coverageTarget: 100, yolo: false }, stages: [], currentStage: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } satisfies FlightManifest)
  }
  ;({ app } = await createServer({ projectRoot, featuresDir, logsDir, ptyFactory }))
  address = await app.listen({ host: '127.0.0.1', port: 0 })
  client = await connect()
})
afterEach(async () => {
  await client?.close()
  await app?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

it.each(['REST', 'MCP'] as const)('%s refuses invalid targets and active Flights without changing saved history', async (transport) => {
  const before = store.list()
  // The agent list presents one Flight per suite; disk retains every record.
  const agentBefore = JSON.parse(text(await client.callTool({ name: 'get_flight', arguments: {} }))).flights
  const events: Array<{ type: string }> = []
  const socket = await app.injectWS('/ws/workspace', {}, {
    onInit: (ws) => ws.on('message', (raw) => events.push(JSON.parse(raw.toString()))),
  })
  try {
    for (const [feature, confirmName, message] of [
      ['missing', 'missing', 'feature not found'],
      ['linked', 'linked', 'feature directory is outside the features root'],
      ['checkout', 'wrong', 'confirmName must match the feature name'],
      ['busy', 'busy', 'pause it before deleting the suite'],
    ]) {
      const response = await remove(transport, feature, confirmName)
      expect(response.failed).toBe(true)
      expect(response.body).toContain(message)
      expect(store.list()).toEqual(before)
    }
    expect(fs.existsSync(suite)).toBe(true)
    expect(fs.existsSync(outside)).toBe(true)
    expect(events.filter((event) => ['feature-deleted', 'flights-changed'].includes(event.type))).toEqual([])
    const agentFlights = JSON.parse(text(await client.callTool({ name: 'get_flight', arguments: {} }))).flights
    expect(agentFlights).toEqual(agentBefore)
  } finally { socket.close() }
})

it.each(['REST', 'MCP'] as const)('%s deletes through production stores and updates open sockets and agent reads', async (transport) => {
  const events: Array<{ type: string; feature?: string }> = []
  const frames: Array<{ type: string; flightId?: string }> = []
  const workspace = await app.injectWS('/ws/workspace', {}, {
    onInit: (ws) => ws.on('message', (raw) => events.push(JSON.parse(raw.toString()))),
  })
  const flights = await app.injectWS('/ws/flights', {}, {
    onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
  })
  try {
    expect(text(await client.callTool({ name: 'list_features', arguments: {} }))).toContain('checkout')
    const response = await remove(transport, 'checkout')
    expect(response.failed).toBe(false)
    if (transport === 'REST') expect(response).toMatchObject({ status: 204, body: '' })
    else expect(JSON.parse(response.body)).toEqual({ deleted: true, feature: 'checkout', featureDir: suite, flightRecordsRemoved: 2 })
    expect(fs.existsSync(suite)).toBe(false)
    expect(store.list().map((entry) => entry.feature).sort()).toEqual(['busy', 'linked'])
    await expect.poll(() => frames.filter((frame) => frame.type === 'removed').map((frame) => frame.flightId).sort())
      .toEqual(['checkout-1', 'checkout-2'])
    await expect.poll(() => events.filter((event) => event.type === 'feature-deleted'))
      .toEqual([{ type: 'feature-deleted', feature: 'checkout' }])
    await expect.poll(() => events.some((event) => event.type === 'flights-changed')).toBe(true)
    expect(text(await client.callTool({ name: 'list_features', arguments: {} }))).not.toContain('checkout')
    const agentFlights = JSON.parse(text(await client.callTool({ name: 'get_flight', arguments: {} }))).flights
    expect(agentFlights.map((entry: { feature: string }) => entry.feature).sort()).toEqual(['busy', 'linked'])
    await client.close()
    client = await connect()
    expect(JSON.parse(text(await client.callTool({ name: 'get_flight', arguments: {} }))).flights).toEqual(agentFlights)
    expect(ptyFactory).not.toHaveBeenCalled()
  } finally { workspace.close(); flights.close() }
})
