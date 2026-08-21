import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GettingStartedBusyError, type GettingStartedSessionStore } from '../../config/logic/getting-started-session'
import { FLIGHT_STAGE_KEYS } from '../logic/types'
import type { StageAdapters } from '../logic/conductor'
import { flightsRoutes } from './flights'

let tmpDir: string
let repoDir: string

function allDone(): StageAdapters {
  return Object.fromEntries(FLIGHT_STAGE_KEYS.map((key) => [key, {
    run: async () => ({ kind: 'done' as const }),
    teardown: () => null,
  }])) as StageAdapters
}

async function appWith(gettingStarted: GettingStartedSessionStore) {
  const app = Fastify({ logger: false })
  await app.register(flightsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    logsDir: path.join(tmpDir, 'logs'),
    projectRoot: tmpDir,
    adapters: allDone(),
    gettingStarted,
  })
  return app
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-demo-')))
  repoDir = path.join(tmpDir, 'flight-app')
  fs.mkdirSync(repoDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('Getting Started flight admission', () => {
  it('claims and links the flight before returning its owner page id', async () => {
    const claim = vi.fn(() => ({ sessionId: 'gs-flight' }))
    const attach = vi.fn()
    const app = await appWith({ claim, attach, abandon: vi.fn() } as unknown as GettingStartedSessionStore)
    const response = await app.inject({
      method: 'POST', url: '/api/flights',
      payload: {
        feature: 'flight-app', repoPaths: [repoDir], description: 'lending',
        gettingStartedSource: 'internal',
      },
    })
    expect(response.statusCode).toBe(201)
    const flightId = response.json<{ flightId: string }>().flightId
    expect(claim).toHaveBeenCalledWith('flight', 'internal')
    expect(attach).toHaveBeenCalledWith('gs-flight', { kind: 'flight', id: flightId })
  })

  it('returns the same typed conflict used by run admission', async () => {
    const active = {
      sessionId: 'gs-run', workflow: 'run' as const, owner: 'external' as const,
      target: { kind: 'run' as const, id: 'run-live' }, startedAt: 'a', updatedAt: 'a',
    }
    const app = await appWith({
      claim: () => { throw new GettingStartedBusyError(active) },
    } as unknown as GettingStartedSessionStore)
    const response = await app.inject({
      method: 'POST', url: '/api/flights',
      payload: {
        feature: 'flight-app', repoPaths: [repoDir], description: 'lending',
        gettingStartedSource: 'external',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ type: 'getting_started_busy', active: { sessionId: 'gs-run' } })
  })

  it('propagates a claim failure that is not the busy conflict', async () => {
    const app = await appWith({
      claim: () => { throw new Error('session.json is not writable') },
    } as unknown as GettingStartedSessionStore)
    const response = await app.inject({
      method: 'POST', url: '/api/flights',
      payload: {
        feature: 'flight-app', repoPaths: [repoDir], description: 'lending',
        gettingStartedSource: 'internal',
      },
    })
    // Swallowing this would leave the demo permanently unclaimable while
    // reporting success, so it must surface rather than degrade.
    expect(response.statusCode).toBe(500)
  })

  it('releases the claim when the flight itself refuses to start', async () => {
    const abandon = vi.fn()
    const app = await appWith({
      claim: vi.fn(() => ({ sessionId: 'gs-flight' })),
      attach: vi.fn(),
      abandon,
    } as unknown as GettingStartedSessionStore)
    const payload = {
      feature: 'flight-app', repoPaths: [repoDir], description: 'lending',
      gettingStartedSource: 'internal' as const,
    }

    expect((await app.inject({ method: 'POST', url: '/api/flights', payload })).statusCode).toBe(201)
    // The feature now has a record, so the second start needs an explicit mode.
    // Without the release, that dead claim would own the workspace forever.
    const second = await app.inject({ method: 'POST', url: '/api/flights', payload })

    expect(second.statusCode).toBe(409)
    expect(abandon).toHaveBeenCalledWith('gs-flight')
  })
})
