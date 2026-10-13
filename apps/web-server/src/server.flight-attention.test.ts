import fs from 'fs'
import path from 'path'
import { expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import { FlightRunStore } from './features/flights/logic/store'
import { freshnessWorkspace } from './features/coverage/logic/coverage/__fixtures__/freshness-workspace'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '../../../shared/flights/types'

it('shares attention through REST, the open socket, inbox and agent change reads, preserving the saved failure', async () => {
  const fixture = await freshnessWorkspace()
  const env = path.join(fixture.featureDir, 'envsets/local')
  fs.mkdirSync(env, { recursive: true }); fs.writeFileSync(path.join(env, 'app.env'), 'MODE=test')
  const store = new FlightRunStore(fixture.args.logsDir)
  const manifest: FlightManifest = {
    flightId: 'fl_shop', feature: 'shop', repoPaths: [], description: 'Shop',
    opts: { env: 'local', coverageTarget: 100, yolo: false }, status: 'paused', pauseReason: 'stage-failed', currentStage: 'specs-coverage',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'specs-coverage' ? 'failed' : 'done',
      ...(key === 'specs-coverage' ? { error: "agent exited with code 2: unexpected argument '--full-auto'" } : {}),
    })), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
  }
  store.save(manifest)
  // Produce an unresolved episode first; then restore the same valid evidence
  // without resuming the flight or forging a stage completion.
  const originalDoc = fs.readFileSync(fixture.doc, 'utf8')
  fs.appendFileSync(fixture.doc, '\nChanged requirement.')
  const originalFlight = fs.readFileSync(path.join(store.flightDir('fl_shop'), 'flight.json'), 'utf8')
  const { app } = await createServer({ projectRoot: fixture.root, ...fixture.args })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ name: 'flight-attention-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
  const agentRead = async () => {
    const result = await client.callTool({ name: 'wait_for_feature_change', arguments: { feature: 'shop', timeout_ms: 0 } })
    if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected MCP text response')
    return JSON.parse(result.content[0].text)
  }
  const frames: Array<{ type: string; manifest?: FlightManifest; flights?: FlightManifest[] }> = []
  const socket = await app.injectWS('/ws/flights', {}, { onInit: (ws) => ws.on('message', (data) => frames.push(JSON.parse(data.toString()))) })
  try {
    const first = (await app.inject('/api/flights/fl_shop')).json()
    expect(first.attention).toMatchObject({ state: 'actionable', remainingStage: 'prd-summary' })
    const initial = (await app.inject('/api/notifications')).json()
    const item = initial.find((row: { target?: { flightId?: string } }) => row.target?.flightId === 'fl_shop')
    expect(item.target).toMatchObject({ kind: 'flight', stage: 'specs-coverage' })
    expect((await agentRead()).change.flightAttention.state).toBe('actionable')
    fs.writeFileSync(fixture.doc, originalDoc)
    await vi.waitFor(() => expect(frames.some((frame) => frame.manifest?.attention?.state === 'resolved')).toBe(true), { timeout: 7500 })
    const detail = (await app.inject('/api/flights/fl_shop')).json()
    const list = (await app.inject('/api/flights')).json()
    const change = (await app.inject('/api/features/shop/coverage/changes?timeoutMs=0')).json()
    expect(detail.attention.state).toBe('resolved')
    expect(list.flights[0].attention.revision).toBe(detail.attention.revision)
    expect(change.change.flightAttention.revision).toBe(detail.attention.revision)
    expect((await agentRead()).change.flightAttention.revision).toBe(detail.attention.revision)
    expect((await app.inject('/api/notifications')).json().find((row: { id: string }) => row.id === item.id).resolvedAt).toBeTruthy()
    expect(fs.readFileSync(path.join(store.flightDir('fl_shop'), 'flight.json'), 'utf8')).toBe(originalFlight)
  } finally { socket.terminate(); await client.close(); await app.close(); fixture.cleanup() }
}, 12_000)
