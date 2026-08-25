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

async function appWith(gettingStarted: GettingStartedSessionStore, adapters: StageAdapters = allDone()) {
  const app = Fastify({ logger: false })
  await app.register(flightsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    logsDir: path.join(tmpDir, 'logs'),
    projectRoot: tmpDir,
    adapters,
    gettingStarted,
  })
  return app
}

/** Adapters whose first stage parks a checkpoint, so the flight stays active
 *  (waiting-for-approval) long enough to be paused and resumed. */
function parking(): StageAdapters {
  const adapters = allDone()
  adapters.scout = {
    run: async () => ({ kind: 'checkpoint' as const, checkpoint: { kind: 'config-approval', message: 'approve?' } }),
    onCheckpointResponse: async () => ({ kind: 'done' as const }),
    teardown: () => null,
  }
  return adapters
}

async function waitForStatus(app: Awaited<ReturnType<typeof appWith>>, flightId: string, statuses: string[]): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    const manifest = (await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })).json() as { status?: string }
    if (statuses.includes(String(manifest.status))) return
    if (Date.now() > deadline) throw new Error(`flight never reached ${statuses.join('/')}: ${String(manifest.status)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function mkRepo(name: string): string {
  const dir = path.join(tmpDir, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Start a flight and wait for its first checkpoint to park (requires the
 *  `parking()` adapters), returning the flightId ready to pause/resume. */
async function startParkedFlight(
  app: Awaited<ReturnType<typeof appWith>>,
  input: { feature: string; repoPath: string; gettingStartedSource?: 'internal' | 'external' },
): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/api/flights',
    payload: {
      feature: input.feature, repoPaths: [input.repoPath], description: 'lending',
      ...(input.gettingStartedSource ? { gettingStartedSource: input.gettingStartedSource } : {}),
    },
  })
  expect(response.statusCode).toBe(201)
  const flightId = response.json<{ flightId: string }>().flightId
  await waitForStatus(app, flightId, ['waiting-for-approval'])
  return flightId
}

const startParkedDemoFlight = (app: Awaited<ReturnType<typeof appWith>>) =>
  startParkedFlight(app, { feature: 'flight-app', repoPath: repoDir, gettingStartedSource: 'internal' })

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

  it('re-claims the demo session when the Getting Started flight is resumed', async () => {
    const claim = vi.fn()
      .mockReturnValueOnce({ sessionId: 'gs-start' })
      .mockReturnValueOnce({ sessionId: 'gs-resume' })
    const attach = vi.fn()
    const read = vi.fn(() => ({ active: null, completed: {} }))
    const app = await appWith({ claim, attach, abandon: vi.fn(), read } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)

    expect((await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })).statusCode).toBe(200)
    const resumed = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/resume` })

    expect(resumed.statusCode).toBe(200)
    // Pausing settled the claim; without the re-claim the resumed demo runs
    // untracked and a second demo can start against the same workspace.
    expect(claim).toHaveBeenNthCalledWith(2, 'flight', 'internal')
    expect(attach).toHaveBeenNthCalledWith(2, 'gs-resume', { kind: 'flight', id: flightId })
  })

  it('claims the resume as external when it arrives from the MCP client', async () => {
    const claim = vi.fn()
      .mockReturnValueOnce({ sessionId: 'gs-start' })
      .mockReturnValueOnce({ sessionId: 'gs-resume' })
    const app = await appWith({
      claim, attach: vi.fn(), abandon: vi.fn(), read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)

    await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })
    const resumed = await app.inject({
      method: 'POST', url: `/api/flights/${flightId}/resume`, headers: { 'x-canary-origin': 'mcp' },
    })

    expect(resumed.statusCode).toBe(200)
    expect(claim).toHaveBeenNthCalledWith(2, 'flight', 'external')
  })

  it('refuses the resume with the typed conflict while another demo owns the workspace', async () => {
    const otherDemo = {
      sessionId: 'gs-run', workflow: 'run' as const, owner: 'internal' as const,
      target: { kind: 'run' as const, id: 'run-live' }, startedAt: 'a', updatedAt: 'a',
    }
    const claim = vi.fn()
      .mockImplementationOnce(() => ({ sessionId: 'gs-start' }))
      .mockImplementationOnce(() => { throw new GettingStartedBusyError(otherDemo) })
    const app = await appWith({
      claim, attach: vi.fn(), abandon: vi.fn(), read: () => ({ active: otherDemo, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)

    await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })
    const resumed = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/resume` })

    expect(resumed.statusCode).toBe(409)
    expect(resumed.json()).toMatchObject({ type: 'getting_started_busy', active: { sessionId: 'gs-run' } })
  })

  it('releases the re-claim when the resume itself is refused', async () => {
    const claim = vi.fn()
      .mockReturnValueOnce({ sessionId: 'gs-start' })
      .mockReturnValueOnce({ sessionId: 'gs-resume' })
    const abandon = vi.fn()
    const app = await appWith({
      claim, attach: vi.fn(), abandon, read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)

    // Finish the flight: a done flight still matches the demo feature, so the
    // resume claims first and must release when resumeFlight refuses.
    await app.inject({
      method: 'POST', url: `/api/flights/${flightId}/respond`,
      payload: { response: { choice: 'approve' } },
    })
    await waitForStatus(app, flightId, ['done'])
    const resumed = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/resume` })

    expect(resumed.statusCode).toBe(409)
    expect(abandon).toHaveBeenCalledWith('gs-resume')
  })

  it('skips the re-claim when the session already owns this flight, and for non-demo flights', async () => {
    const claim = vi.fn(() => ({ sessionId: 'gs-start' }))
    const app = await appWith({
      claim,
      attach: vi.fn(),
      abandon: vi.fn(),
      read: vi.fn(() => ({
        active: {
          sessionId: 'gs-start', workflow: 'flight' as const, owner: 'internal' as const,
          target: { kind: 'flight' as const, id: ownedFlightId }, startedAt: 'a', updatedAt: 'a',
        },
        completed: {},
      })),
    } as unknown as GettingStartedSessionStore, parking())
    const ownedFlightId = await startParkedDemoFlight(app)
    claim.mockClear()

    await app.inject({ method: 'POST', url: `/api/flights/${ownedFlightId}/pause` })
    expect((await app.inject({ method: 'POST', url: `/api/flights/${ownedFlightId}/resume` })).statusCode).toBe(200)
    expect(claim).not.toHaveBeenCalled()

    // A non-demo feature never touches the session, active or not.
    const other = await startParkedFlight(app, { feature: 'checkout', repoPath: mkRepo('checkout-repo') })
    await app.inject({ method: 'POST', url: `/api/flights/${other}/pause` })
    expect((await app.inject({ method: 'POST', url: `/api/flights/${other}/resume` })).statusCode).toBe(200)
    expect(claim).not.toHaveBeenCalled()
  })

  it('re-claims the demo session on redo — "Start over" must not run untracked', async () => {
    const claim = vi.fn()
      .mockReturnValueOnce({ sessionId: 'gs-start' })
      .mockReturnValueOnce({ sessionId: 'gs-redo' })
    const attach = vi.fn()
    const app = await appWith({
      claim, attach, abandon: vi.fn(), read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)

    await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })
    const redone = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/redo` })

    expect(redone.statusCode).toBe(201)
    expect(claim).toHaveBeenNthCalledWith(2, 'flight', 'internal')
    expect(attach).toHaveBeenNthCalledWith(2, 'gs-redo', {
      kind: 'flight', id: redone.json<{ flightId: string }>().flightId,
    })
  })

  it('redo releases its re-claim when stage entry is refused, and maps the busy conflict', async () => {
    const claim = vi.fn()
      .mockReturnValueOnce({ sessionId: 'gs-start' })
      .mockReturnValueOnce({ sessionId: 'gs-redo' })
    const abandon = vi.fn()
    const app = await appWith({
      claim, attach: vi.fn(), abandon, read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)
    await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })

    // No portify prerequisites exist on disk, so the entry validator refuses —
    // the claim taken just before must be released with it.
    const refused = await app.inject({
      method: 'POST', url: `/api/flights/${flightId}/redo`, payload: { fromStage: 'portify' },
    })
    expect(refused.statusCode).toBe(400)
    expect(refused.json()).toMatchObject({ type: 'stage_entry_rejected' })
    expect(abandon).toHaveBeenCalledWith('gs-redo')

    // While another demo owns the workspace, redo surfaces the same typed
    // conflict the other admission paths use.
    const otherDemo = {
      sessionId: 'gs-run', workflow: 'run' as const, owner: 'internal' as const,
      target: { kind: 'run' as const, id: 'run-live' }, startedAt: 'a', updatedAt: 'a',
    }
    claim.mockImplementationOnce(() => { throw new GettingStartedBusyError(otherDemo) })
    const busy = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/redo` })
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toMatchObject({ type: 'getting_started_busy' })
  })

  it('matches the demo by repo basename on resume, so a de-conflicted feature name still re-claims', async () => {
    // Scaffold de-conflicts a colliding feature to `flight-app-2`; the record's
    // repoPaths still name the sample repo, and that is what the matcher reads.
    const claim = vi.fn(() => ({ sessionId: 'gs-resume' }))
    const attach = vi.fn()
    const app = await appWith({
      claim, attach, abandon: vi.fn(), read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedFlight(app, { feature: 'flight-app-2', repoPath: repoDir })

    await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })
    expect((await app.inject({ method: 'POST', url: `/api/flights/${flightId}/resume` })).statusCode).toBe(200)

    expect(claim).toHaveBeenCalledWith('flight', 'internal')
    expect(attach).toHaveBeenCalledWith('gs-resume', { kind: 'flight', id: flightId })
  })

  it('re-claims on a mode-carrying start — no client sends gettingStartedSource on continue', async () => {
    const claim = vi.fn()
      .mockReturnValueOnce({ sessionId: 'gs-start' })
      .mockReturnValueOnce({ sessionId: 'gs-continue' })
    const attach = vi.fn()
    const app = await appWith({
      claim, attach, abandon: vi.fn(), read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)
    await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })

    // Repos/description omitted (frozen on the record): the stored record must
    // supply the repoPaths the matcher reads.
    const resumed = await app.inject({
      method: 'POST', url: '/api/flights', payload: { feature: 'flight-app', mode: 'continue' },
    })

    expect(resumed.statusCode).toBe(201)
    expect(claim).toHaveBeenNthCalledWith(2, 'flight', 'internal')
    expect(attach).toHaveBeenNthCalledWith(2, 'gs-continue', { kind: 'flight', id: flightId })
  })

  it('re-claims a mode-carrying jump that repeats the frozen repo set', async () => {
    const claim = vi.fn()
      .mockReturnValueOnce({ sessionId: 'gs-start' })
      .mockReturnValueOnce({ sessionId: 'gs-jump' })
    const app = await appWith({
      claim, attach: vi.fn(), abandon: vi.fn(), read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)
    await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })

    // Repos sent this time (matching the frozen set): the matcher must read the
    // body's repoPaths rather than requiring the stored record's.
    const jumped = await app.inject({
      method: 'POST', url: '/api/flights',
      payload: { feature: 'flight-app', mode: 'jump', fromStage: 'scout', repoPaths: [repoDir] },
    })

    expect(jumped.statusCode).toBe(201)
    expect(claim).toHaveBeenNthCalledWith(2, 'flight', 'internal')
  })

  it('releases the mode-carrying claim when no record exists to re-enter', async () => {
    // `continue` on a feature with no flight record: the demo matcher fires on
    // the feature name alone (no stored repoPaths to consult), the conductor
    // refuses, and the claim must be released with the refusal.
    const claim = vi.fn(() => ({ sessionId: 'gs-ghost' }))
    const abandon = vi.fn()
    const app = await appWith({
      claim, attach: vi.fn(), abandon, read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())

    const refused = await app.inject({
      method: 'POST', url: '/api/flights', payload: { feature: 'flight-app', mode: 'continue' },
    })

    expect(refused.statusCode).toBe(400)
    expect(claim).toHaveBeenCalledWith('flight', 'internal')
    expect(abandon).toHaveBeenCalledWith('gs-ghost')
  })

  it('maps the busy conflict and propagates other claim failures on a mode-carrying start', async () => {
    const otherDemo = {
      sessionId: 'gs-run', workflow: 'run' as const, owner: 'internal' as const,
      target: { kind: 'run' as const, id: 'run-live' }, startedAt: 'a', updatedAt: 'a',
    }
    const claim = vi.fn()
      .mockReturnValueOnce({ sessionId: 'gs-start' })
      .mockImplementationOnce(() => { throw new GettingStartedBusyError(otherDemo) })
      .mockImplementationOnce(() => { throw new Error('session.json is not writable') })
    const app = await appWith({
      claim, attach: vi.fn(), abandon: vi.fn(), read: () => ({ active: null, completed: {} }),
    } as unknown as GettingStartedSessionStore, parking())
    const flightId = await startParkedDemoFlight(app)
    await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })

    const busy = await app.inject({
      method: 'POST', url: '/api/flights', payload: { feature: 'flight-app', mode: 'continue' },
    })
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toMatchObject({ type: 'getting_started_busy', active: { sessionId: 'gs-run' } })

    const broken = await app.inject({
      method: 'POST', url: '/api/flights', payload: { feature: 'flight-app', mode: 'continue' },
    })
    expect(broken.statusCode).toBe(500)
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
