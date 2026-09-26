import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import { FlightRunStore } from './features/flights/logic/store'
import { FLIGHT_STAGE_KEYS } from './features/flights/logic/types'
import type { WorkspaceNotification } from '../../../shared/notifications/types'

let dir: string
let logsDir: string
let app: Awaited<ReturnType<typeof createServer>>['app']
let client: Client
let address: string
const ptyFactory = vi.fn(() => { throw new Error('Notification observation must not spawn a process') })

async function connect(): Promise<Client> {
  const connected = new Client({ name: 'notification-integration', version: '1.0.0' }, { capabilities: {} })
  await connected.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
  return connected
}

async function agentSnapshot() {
  const result = await client.callTool({ name: 'wait_for_feature_change', arguments: { feature: 'shop', timeout_ms: 0 } })
  expect(result.isError).not.toBe(true)
  if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected MCP text response')
  return JSON.parse(result.content[0].text).notificationUpdate as {
    revision: string; attentionCount: number; items: Array<{ id: string; state: string }>
  }
}

const persisted = (): WorkspaceNotification[] => JSON.parse(fs.readFileSync(path.join(logsDir, 'notifications', 'state.json'), 'utf8')).items

beforeEach(async () => {
  ptyFactory.mockClear()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-notifications-server-'))
  const projectRoot = path.join(dir, 'workspace')
  const featuresDir = path.join(projectRoot, 'features')
  logsDir = path.join(dir, 'logs')
  const suite = path.join(featuresDir, 'shop')
  fs.mkdirSync(suite, { recursive: true })
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), "exports.config = { name: 'shop', description: 'fixture', featureDir: __dirname, repos: [] }")
  new FlightRunStore(logsDir).save({
    flightId: 'approval-flight', feature: 'shop', repoPaths: [], description: 'fixture',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'waiting-for-approval', currentStage: 'scout',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' })),
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  })
  ;({ app } = await createServer({ projectRoot, featuresDir, logsDir, ptyFactory }))
  address = await app.listen({ host: '127.0.0.1', port: 0 })
  client = await connect()
})

afterEach(async () => {
  await client?.close()
  await app?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

it('persists store-event transitions, broadcasts them to an open socket, and catches a connected agent up', async () => {
  const initial = await agentSnapshot()
  expect(initial).toMatchObject({ attentionCount: 1, items: [{ state: 'attention' }] })
  const frames: Array<{ type: string }> = []
  const socket = await app.injectWS('/ws/workspace', {}, {
    onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/flights/approval-flight/pause' })
    expect(response.statusCode).toBe(200)
    // Inspect disk before any inbox read: a GET must not be what repairs wiring.
    expect(persisted()).toEqual([expect.objectContaining({ id: initial.items[0].id, resolvedAt: expect.any(String) })])
    await expect.poll(() => frames.some((frame) => frame.type === 'notifications-changed')).toBe(true)
    const settled = await agentSnapshot()
    expect(settled).toMatchObject({ attentionCount: 0, items: [{ id: initial.items[0].id, state: 'resolved' }] })
    expect(settled.revision).not.toBe(initial.revision)
    await client.close()
    client = await connect()
    expect(await agentSnapshot()).toEqual(settled)
    expect(ptyFactory).not.toHaveBeenCalled()
  } finally { socket.close() }
})
