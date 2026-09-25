import fs from 'fs'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { registerMcpRoutes } from './server'
import { register as registerNotifications } from '../features/notifications'
import { DirtySpecStore } from '../features/runs/logic/dirty-specs/store'
import type { ServerContext } from '../server-context'
import { coverageRoutes } from '../features/coverage/routes/coverage'
import { RunStore, createRegistry } from '../features/runs/logic/run-store'
import { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import { WorkspaceEventBus } from '../shared/workspace-events'
import { CoverageFreshnessMonitor } from '../features/coverage/logic/coverage/freshness-monitor'
import { freshnessWorkspace } from '../features/coverage/logic/coverage/__fixtures__/freshness-workspace'

let fixture: Awaited<ReturnType<typeof freshnessWorkspace>>
beforeEach(async () => { fixture = await freshnessWorkspace() })
afterEach(() => fixture.cleanup())

function texts(result: unknown): Array<Record<string, any>> {
  return (result as { content: Array<{ type: string; text?: string }> }).content
    .filter((item) => item.type === 'text').map((item) => JSON.parse(item.text!))
}

describe('coverage changes delivered into agent tool context', () => {
  it.each(['compact', 'coverage'])('delivers recovery, wait changes and reconnect catch-up through the %s profile', async (profile) => {
    const app = Fastify()
    const bus = new WorkspaceEventBus()
    const monitor = new CoverageFreshnessMonitor(fixture.args, bus, () => {})
    const store = new RunStore(fixture.args.logsDir, createRegistry())
    const broker = new ExternalHealBroker({ now: Date.now, emit: () => {}, patchManifest: (id, patch) => store.patchManifest(id, patch), audit: () => {} })
    const connected: Client[] = []
    try {
      await app.register(coverageRoutes, { ...fixture.args, projectRoot: fixture.root, coverageMonitor: monitor })
      let flightStatus = 'paused'
      await registerNotifications(app, {
        ...fixture.args, workspaceEvents: bus, runStore: store,
        dirtySpecStore: new DirtySpecStore(fixture.args.logsDir),
        flightStore: { list: () => [{ flightId: 'flight-shop', feature: 'shop', status: flightStatus, pauseReason: 'stage-failed', currentStage: 'run' }], onEvent: () => {}, offEvent: () => {} },
      } as unknown as ServerContext)
      await app.register(registerMcpRoutes, {
        ...fixture.args, projectRoot: fixture.root, store, broker,
        startRun: async () => { throw new Error('A read must never launch a run') },
        coverageRequest: async (request) => {
          const reply = await app.inject(request)
          return { statusCode: reply.statusCode, body: reply.json() }
        },
      })
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const connect = async () => {
        const client = new Client({ name: 'codex-freshness-test', version: '1' }, { capabilities: {} })
        await client.connect(new StreamableHTTPClientTransport(new URL(`/mcp?profile=${profile}`, address)))
        connected.push(client)
        return client
      }
      let client = await connect()
      const call = (command: string, args: Record<string, unknown>) => client.callTool(profile === 'compact'
        ? { name: 'exec', arguments: { command, arguments: args } }
        : { name: command, arguments: args })
      const first = texts(await call('get_feature_coverage', { feature: 'shop' }))
      const update = first.find((item) => item.coverageUpdate)?.coverageUpdate
      expect(update.change).toMatchObject({ feature: 'shop', freshness: { state: 'current' }, delivery: 'tool-response-and-wait' })
      const cursor = update.change.freshness.revision
      const initialNotifications = first.find((item) => item.notificationUpdate)?.notificationUpdate
      expect(initialNotifications.items[0]).toMatchObject({ state: 'attention', action: { kind: 'flight', flightId: 'flight-shop' } })
      const notificationWait = call('wait_for_feature_change', { feature: 'shop', afterRevision: cursor, timeout_ms: 100 })
      // No coverage change and no Flight event: the bounded wait response must
      // still carry current notification truth into the connected agent.
      flightStatus = 'running'
      const settled = texts(await notificationWait)[0]
      expect(settled.changed).toBe(false)
      expect(settled.change.freshness.revision).toBe(cursor)
      expect(settled.notificationUpdate.revision).not.toBe(initialNotifications.revision)
      expect(settled.notificationUpdate.items[0].state).toBe('resolved')
      await client.close()
      client = await connect()
      const caughtUp = texts(await call('wait_for_feature_change', { feature: 'shop', timeout_ms: 0 }))[0]
      expect(caughtUp.notificationUpdate.revision).toBe(settled.notificationUpdate.revision)
      const waiting = call('wait_for_feature_change', { feature: 'shop', afterRevision: cursor, timeout_ms: 1000 })
      fs.appendFileSync(fixture.doc, '\nNew requirement wording.')
      await monitor.reconcile()
      expect(texts(await waiting)[0]).toMatchObject({ changed: true, change: { freshness: { state: 'stale', nextAction: { stage: 'prd-summary', command: 'start_external_summary' } } } })
      await client.close()
      client = await connect()
      expect(texts(await call('wait_for_feature_change', { feature: 'shop', afterRevision: cursor, timeout_ms: 0 }))[0].changed).toBe(true)
      const states = (await app.inject('/api/coverage/states')).json()
      expect(states[0]).toMatchObject({ feature: 'shop', headline: 'Stale', coveragePct: null })
      expect((await app.inject('/api/features/shop/coverage/changes?timeoutMs=99999')).statusCode).toBe(400)
      expect((await app.inject('/api/features/missing/coverage/changes')).statusCode).toBe(404)
    } finally {
      monitor.close()
      for (const client of connected) await client.close()
      await app.close()
    }
  })
})
