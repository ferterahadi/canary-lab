import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { featureConfigRoutes } from './feature-config'
import type { WorkspaceEvent } from '../../../shared/workspace-events'

// Deletion and rename are the two places a suite's IDENTITY moves, so both have
// to carry its flight history with them. These are the arms where that handoff
// reports something back — a blocking flight, a non-zero move count, or a host
// that wired no flight store at all.

let tmpDir: string
let featuresDir: string

function buildFeature(name: string): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  return dir
}

async function makeApp(opts: {
  events?: WorkspaceEvent[]
  removeFlightRecordsFor?: (feature: string) => { error?: string; removed: number }
  featureRename?: { blockedBy: (feature: string) => string | null; apply: (from: string, to: string) => number }
} = {}): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(async (a) => {
    await featureConfigRoutes(a, {
      featuresDir,
      ...(opts.removeFlightRecordsFor ? { removeFlightRecordsFor: opts.removeFlightRecordsFor } : {}),
      ...(opts.featureRename ? { featureRename: opts.featureRename } : {}),
      // Conditional SPREAD, like the two deps above it. `workspaceEvents: undefined`
      // is not the same as an absent key when the dep is declared optional, and
      // passing the explicit undefined is what made this argument unassignable.
      ...(opts.events ? { workspaceEvents: { publish: (event: WorkspaceEvent) => { opts.events!.push(event) } } } : {}),
    })
  })
  await app.ready()
  return app
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fcfg-fl-')))
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('PUT config-doc rename without a flight store wired', () => {
  it('still renames and announces it, treating "no records moved" as zero', async () => {
    // `featureRename` is optional — a host that wires no flight store (the MCP
    // server, a test harness) must still get the rename and the
    // feature-renamed event, just no flights-changed nudge.
    buildFeature('old_name')
    const events: WorkspaceEvent[] = []
    const app = await makeApp({ events })
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/old_name/config-doc',
        payload: { value: { name: 'new_name', description: 'd', envs: ['local'], featureDir: { $expr: '__dirname' } } },
      })
      expect(r.statusCode).toBe(200)
      expect(events).toContainEqual({ type: 'feature-renamed', from: 'old_name', to: 'new_name' })
      expect(events).toContainEqual({ type: 'features-changed' })
      expect(events).not.toContainEqual({ type: 'flights-changed' })
    } finally {
      await app.close()
    }
  })
})

describe('DELETE /api/features/:name with flight history', () => {
  it('refuses with 409 when a flight still holds the suite, leaving the directory intact', async () => {
    // Guarded BEFORE the rmSync on purpose: a half-deleted feature whose flight
    // is still running would leave the conductor driving a suite that no longer
    // exists on disk.
    const dir = buildFeature('busy')
    const events: WorkspaceEvent[] = []
    const app = await makeApp({
      events,
      removeFlightRecordsFor: () => ({ error: 'a flight is still running', removed: 0 }),
    })
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/busy',
        payload: { confirmName: 'busy' },
      })
      expect(r.statusCode).toBe(409)
      expect(r.json()).toEqual({ error: 'a flight is still running' })
      expect(fs.existsSync(dir)).toBe(true)
      expect(events).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('deletes the flight records but leaves their announcement to the store', async () => {
    // The route asks for the removal; the flight store broadcasts it, because
    // the store is what knows whether anything was actually written (see
    // shared/store-event-bridge.ts + the emitter tests in flight-queue.test.ts).
    // Announcing here as well would fan out twice for one deletion — and worse,
    // would fan out even when the removal found nothing.
    const removals: string[] = []
    const events: WorkspaceEvent[] = []
    const app = await makeApp({
      events,
      removeFlightRecordsFor: (feature) => { removals.push(feature); return { removed: 2 } },
    })
    try {
      buildFeature('had-flights')
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/had-flights',
        payload: { confirmName: 'had-flights' },
      })
      expect(r.statusCode).toBe(204)
      expect(removals).toEqual(['had-flights'])
      expect(events).toContainEqual({ type: 'feature-deleted', feature: 'had-flights' })
      expect(events).not.toContainEqual({ type: 'flights-changed' })
    } finally {
      await app.close()
    }
  })
})
