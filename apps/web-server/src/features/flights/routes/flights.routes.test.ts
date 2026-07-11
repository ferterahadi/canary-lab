import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { flightsRoutes } from './flights'
import { FlightRunStore, type FlightStore, type FlightStoreEvent } from '../logic/store'
import type { StageAdapters } from '../logic/conductor'
import type { FlightAgentSpawner } from '../logic/stages/context'
import { FLIGHT_STAGE_KEYS } from '../logic/types'
import type { FlightIndexEntry, FlightManifest } from '../logic/types'
import type { PlanFeaturesTask } from '../../../../../../shared/flights/types'

let tmpDir: string
let repoDir: string
let app: FastifyInstance

function allDone(): StageAdapters {
  return Object.fromEntries(
    FLIGHT_STAGE_KEYS.map((k) => [k, { run: async () => ({ kind: 'done' as const }) }]),
  ) as StageAdapters
}

async function buildApp(
  adapters: StageAdapters,
  flightStore?: FlightStore,
  planAgent?: FlightAgentSpawner,
): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false })
  await instance.register(flightsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    logsDir: tmpDir,
    projectRoot: tmpDir,
    adapters,
    ...(flightStore ? { flightStore } : {}),
    ...(planAgent ? { planAgent } : {}),
  })
  return instance
}

/** A store stub whose `get` throws a non-Error value, so error handlers that
 *  branch on `err instanceof Error` take the `String(err)` fallback path. */
function throwingStore(thrown: unknown): FlightStore {
  return {
    list(): FlightIndexEntry[] {
      return []
    },
    get(): FlightManifest | null {
      throw thrown
    },
    activeForRepos(): FlightIndexEntry | null {
      return null
    },
    latestForRepos(): FlightIndexEntry | null {
      return null
    },
    latestForFeature(): FlightIndexEntry | null {
      return null
    },
    save(): void {},
    remove(): void {},
    flightDir(flightId: string): string {
      return path.join(tmpDir, 'flights', flightId)
    },
    reconcileInterrupted(): void {},
    onEvent(_fn: (event: FlightStoreEvent) => void): void {},
    offEvent(_fn: (event: FlightStoreEvent) => void): void {},
  }
}

/** A store stub whose `save` throws a non-Error value synchronously — used to
 *  exercise startFlight's non-FlightConflictError rethrow path. */
function saveThrowsStore(thrown: unknown): FlightStore {
  return {
    list(): FlightIndexEntry[] {
      return []
    },
    get(): FlightManifest | null {
      return null
    },
    activeForRepos(): FlightIndexEntry | null {
      return null
    },
    latestForRepos(): FlightIndexEntry | null {
      return null
    },
    latestForFeature(): FlightIndexEntry | null {
      return null
    },
    save(): void {
      throw thrown
    },
    remove(): void {},
    flightDir(flightId: string): string {
      return path.join(tmpDir, 'flights', flightId)
    },
    reconcileInterrupted(): void {},
    onEvent(_fn: (event: FlightStoreEvent) => void): void {},
    offEvent(_fn: (event: FlightStoreEvent) => void): void {},
  }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-routes-')))
  repoDir = path.join(tmpDir, 'product-repo')
  fs.mkdirSync(repoDir, { recursive: true })
})
afterEach(async () => {
  await app?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const startBody = (over: Record<string, unknown> = {}) => ({
  feature: 'checkout',
  repoPaths: [repoDir],
  description: 'checkout flow',
  ...over,
})

async function waitForStatus(flightId: string, statuses: string[], timeoutMs = 3000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const resp = await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })
    const manifest = resp.json() as Record<string, unknown>
    if (statuses.includes(String(manifest.status))) return manifest
    if (Date.now() > deadline) throw new Error(`flight never reached ${statuses.join('/')}: ${String(manifest.status)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('flights routes', () => {
  it('validates the start payload', async () => {
    app = await buildApp(allDone())
    for (const body of [
      {},
      startBody({ repoPaths: [] }),
      startBody({ description: ' ' }),
      startBody({ feature: '' }),
      startBody({ coverageTarget: 200 }),
      startBody({ repoPaths: [path.join(tmpDir, 'nope')] }),
    ]) {
      const resp = await app.inject({ method: 'POST', url: '/api/flights', body })
      expect(resp.statusCode).toBe(400)
    }
  })

  it('starts a flight (201, non-blocking) and exposes it via list + get', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    expect(started.statusCode).toBe(201)
    const manifest = started.json() as { flightId: string; status: string; repoPaths: string[] }
    expect(manifest.status).toBe('running')
    expect(manifest.repoPaths).toEqual([repoDir])

    const listed = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((listed.json() as { flights: unknown[] }).flights).toHaveLength(1)

    const settled = await waitForStatus(manifest.flightId, ['done'])
    expect(settled.currentStage).toBeNull()
  })

  it('409s a second start for the same repo while one is active (single-flight)', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
    }
    app = await buildApp(adapters)
    const first = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (first.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['waiting-for-approval'])

    const dup = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ feature: 'other' }) })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ type: 'flight_conflict', existingFlightId: flightId })
  })

  it('releases a checkpoint via respond and refuses one when nothing waits', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
      onCheckpointResponse: async () => ({ kind: 'done' as const }),
    }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['waiting-for-approval'])

    const bad = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/respond`, body: {} })
    expect(bad.statusCode).toBe(400)

    const responded = await app.inject({
      method: 'POST',
      url: `/api/flights/${flightId}/respond`,
      body: { response: { choice: 'approve' } },
    })
    expect(responded.statusCode).toBe(200)
    await waitForStatus(flightId, ['done'])

    const again = await app.inject({
      method: 'POST',
      url: `/api/flights/${flightId}/respond`,
      body: { response: { choice: 'approve' } },
    })
    expect(again.statusCode).toBe(409)
  })

  it('resumes a paused flight and aborts an active one', async () => {
    let fail = true
    const adapters = allDone()
    adapters.docs = {
      run: async () => (fail ? { kind: 'failed', error: 'no docs' } : { kind: 'done' }),
    }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['paused'])

    fail = false
    const resumed = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/resume` })
    expect(resumed.statusCode).toBe(200)
    await waitForStatus(flightId, ['done'])

    const reResumed = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/resume` })
    expect(reResumed.statusCode).toBe(409)

    const aborted = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/abort` })
    expect(aborted.statusCode).toBe(200)
    expect((aborted.json() as { status: string }).status).toBe('aborted')
  })

  it('404s an unknown flight', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({ method: 'GET', url: '/api/flights/fl_nope' })
    expect(resp.statusCode).toBe(404)
    const resumed = await app.inject({ method: 'POST', url: '/api/flights/fl_nope/resume' })
    expect(resumed.statusCode).toBe(404)
  })

  it('404s respond and abort for an unknown flight (real "not found" Error)', async () => {
    app = await buildApp(allDone())
    const respond = await app.inject({
      method: 'POST',
      url: '/api/flights/fl_nope/respond',
      body: { response: { choice: 'approve' } },
    })
    expect(respond.statusCode).toBe(404)
    expect(respond.json()).toMatchObject({ error: 'flight not found: fl_nope' })

    const abort = await app.inject({ method: 'POST', url: '/api/flights/fl_nope/abort' })
    expect(abort.statusCode).toBe(404)
    expect(abort.json()).toMatchObject({ error: 'flight not found: fl_nope' })
  })

  it('accepts an explicit base branch option', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ base: 'develop' }),
    })
    expect(resp.statusCode).toBe(201)
    const manifest = resp.json() as { opts: { base?: string } }
    expect(manifest.opts.base).toBe('develop')
  })

  it('builds its own store when flightStore is omitted', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    expect(started.statusCode).toBe(201)
    const flightId = (started.json() as { flightId: string }).flightId
    const fetched = await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })
    expect(fetched.statusCode).toBe(200)
  })

  it('defaults an undefined POST body to {} and 400s on missing repoPaths', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({ method: 'POST', url: '/api/flights' })
    expect(resp.statusCode).toBe(400)
    expect(resp.json()).toMatchObject({ error: 'repoPaths (non-empty string array) is required' })
  })

  it('rethrows a non-conflict error raised while starting a flight', async () => {
    app = await buildApp(allDone(), saveThrowsStore('disk full'))
    const resp = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    expect(resp.statusCode).toBe(500)
  })

  it('falls back to String(err) when respond/resume/abort throw a non-Error', async () => {
    app = await buildApp(allDone(), throwingStore('boom'))

    const respond = await app.inject({
      method: 'POST',
      url: '/api/flights/fl_x/respond',
      body: { response: { choice: 'approve' } },
    })
    expect(respond.statusCode).toBe(409)
    expect(respond.json()).toMatchObject({ error: 'boom' })

    const resume = await app.inject({ method: 'POST', url: '/api/flights/fl_x/resume' })
    expect(resume.statusCode).toBe(409)
    expect(resume.json()).toMatchObject({ error: 'boom' })

    const abort = await app.inject({ method: 'POST', url: '/api/flights/fl_x/abort' })
    expect(abort.statusCode).toBe(409)
    expect(abort.json()).toMatchObject({ error: 'boom' })
  })

  describe('agent-session', () => {
    it('400s when the stage query is missing or malformed', async () => {
      app = await buildApp(allDone())
      const missing = await app.inject({ method: 'GET', url: '/api/flights/fl_x/agent-session' })
      expect(missing.statusCode).toBe(400)

      const malformed = await app.inject({
        method: 'GET',
        url: '/api/flights/fl_x/agent-session?stage=Not_Valid!',
      })
      expect(malformed.statusCode).toBe(400)
    })

    it('404s when no agent-session ref exists for the stage', async () => {
      app = await buildApp(allDone())
      const resp = await app.inject({ method: 'GET', url: '/api/flights/fl_x/agent-session?stage=scout' })
      expect(resp.statusCode).toBe(404)
      expect(resp.json()).toEqual({ reason: 'no-session' })
    })

    it('returns the agent session when a ref is on disk', async () => {
      const store = new FlightRunStore(tmpDir)
      app = await buildApp(allDone(), store)
      const stageDir = path.join(store.flightDir('fl_x'), 'scout')
      fs.mkdirSync(stageDir, { recursive: true })
      const logPath = path.join(stageDir, 'session.jsonl')
      fs.writeFileSync(
        logPath,
        `${JSON.stringify({ type: 'assistant', message: { model: 'claude-x' } })}\n`,
      )
      fs.writeFileSync(
        path.join(stageDir, 'agent-session.json'),
        JSON.stringify({ agent: 'claude', sessionId: 'sess-1', logPath }),
      )

      const resp = await app.inject({ method: 'GET', url: '/api/flights/fl_x/agent-session?stage=scout' })
      expect(resp.statusCode).toBe(200)
      const body = resp.json() as { agent: string; sessionId: string; model?: string; events: unknown[] }
      expect(body.agent).toBe('claude')
      expect(body.sessionId).toBe('sess-1')
      expect(body.model).toBe('claude-x')
    })
  })
})

describe('flight entry modes (continue / redo / jump)', () => {
  it('400s an invalid mode and an invalid fromStage', async () => {
    app = await buildApp(allDone())
    const badMode = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ mode: 'sideways' }) })
    expect(badMode.statusCode).toBe(400)
    expect((badMode.json() as { error: string }).error).toMatch(/invalid mode/)

    const badStage = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'warp' }) })
    expect(badStage.statusCode).toBe(400)
    expect((badStage.json() as { error: string }).error).toMatch(/invalid fromStage/)
  })

  it('409s flight_exists_requires_choice on a modeless re-start, and redo reuses the record', async () => {
    app = await buildApp(allDone())
    const first = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (first.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const again = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    expect(again.statusCode).toBe(409)
    const body = again.json() as { type: string; options: string[]; existingFlightId: string }
    expect(body.type).toBe('flight_exists_requires_choice')
    expect(body.options).toEqual(['continue', 'redo', 'jump'])
    expect(body.existingFlightId).toBe(flightId)

    const redo = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ mode: 'redo' }) })
    expect(redo.statusCode).toBe(201)
    expect((redo.json() as { flightId: string }).flightId).toBe(flightId)
    const listed = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((listed.json() as { flights: unknown[] }).flights).toHaveLength(1)
    await waitForStatus(flightId, ['done'])
  })

  it('rejects a jump whose prerequisites are missing, naming the first missing artifact', async () => {
    app = await buildApp(allDone())
    const jump = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ fromStage: 'specs-coverage' }),
    })
    expect(jump.statusCode).toBe(400)
    const body = jump.json() as { type: string; error: string }
    expect(body.type).toBe('stage_entry_rejected')
    expect(body.error).toMatch(/feature\.config\.cjs/)
  })

  it('accepts a jump whose on-disk prerequisites exist (fresh feature, stage-entry skips recorded)', async () => {
    const featureDir = path.join(tmpDir, 'features', 'checkout_flow')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api.env'), 'PORT=0\n')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')

    app = await buildApp(allDone())
    const jump = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ feature: 'checkout_flow', fromStage: 'specs-coverage' }),
    })
    expect(jump.statusCode).toBe(201)
    const manifest = jump.json() as { flightId: string; stages: Array<{ key: string; status: string; skipReason?: string }> }
    const scout = manifest.stages.find((s) => s.key === 'scout')!
    expect(scout.status).toBe('skipped')
    expect(scout.skipReason).toBe('stage-entry')
    await waitForStatus(manifest.flightId, ['done'])
  })

  it('rejects a heal entry point outright', async () => {
    app = await buildApp(allDone())
    const jump = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'heal' }) })
    expect(jump.statusCode).toBe(400)
    expect((jump.json() as { error: string }).error).toMatch(/use --from-stage run/)
  })
})

describe('flight entry options (GET /api/flights/entry)', () => {
  interface EntryBody {
    feature: string
    flight: { flightId: string; status: string; stages: Array<{ key: string; status: string }> } | null
    active: boolean
    canContinue: boolean
    prefill: { repoPaths: string[]; description: string; env: string; coverageTarget: number }
    stages: Array<{ key: string; allowed: boolean; reason?: string }>
  }
  const entryFor = async (feature: string) => {
    const resp = await app.inject({ method: 'GET', url: `/api/flights/entry?feature=${feature}` })
    return { status: resp.statusCode, body: resp.json() as EntryBody }
  }
  const stageOf = (body: EntryBody, key: string) => body.stages.find((s) => s.key === key)!

  /** A real feature.config the loader can parse, with declared repos. */
  function writeFeatureConfig(feature: string): string {
    const featureDir = path.join(tmpDir, 'features', feature)
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'feature.config.cjs'),
      `module.exports.config = { name: '${feature}', repos: [{ name: 'app', localPath: '${repoDir}' }] }\n`,
    )
    return featureDir
  }

  it('400s without a feature and 404s a feature with no record and no config', async () => {
    app = await buildApp(allDone())
    expect((await app.inject({ method: 'GET', url: '/api/flights/entry' })).statusCode).toBe(400)
    const missing = await entryFor('ghost')
    expect(missing.status).toBe(404)
  })

  it('expands ~ in config-declared repo paths for the prefill', async () => {
    const featureDir = path.join(tmpDir, 'features', 'homey')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'feature.config.cjs'),
      `module.exports.config = { name: 'homey', repos: [{ name: 'app', localPath: '~/some/repo' }] }\n`,
    )
    app = await buildApp(allDone())
    const { body } = await entryFor('homey')
    expect(body.prefill.repoPaths).toEqual([path.join(os.homedir(), 'some/repo')])
  })

  it('locks every stage entry (except the full flight) for a feature that never flew — R41', async () => {
    writeFeatureConfig('checkout')
    app = await buildApp(allDone())
    const { status, body } = await entryFor('checkout')
    expect(status).toBe(200)
    expect(body.flight).toBeNull()
    expect(body.active).toBe(false)
    expect(body.canContinue).toBe(false)
    expect(body.prefill.repoPaths).toEqual([repoDir])
    expect(body.prefill.description).toBe('')
    // No flight record → the stage-entry menu is fully locked: a first flight
    // always starts from the beginning, even when on-disk evidence would
    // otherwise satisfy a jump. (The start route stays permissive for CLI.)
    expect(stageOf(body, 'similarity').allowed).toBe(true)
    for (const key of ['scout', 'env-capture', 'docs', 'specs-coverage', 'run', 'evaluation-export'] as const) {
      expect(stageOf(body, key)).toMatchObject({ allowed: false })
      expect(stageOf(body, key).reason).toMatch(/first flight/)
    }
  })

  it('unlocks stages as on-disk evidence appears, and prefills from the latest manifest', async () => {
    const featureDir = writeFeatureConfig('checkout')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api.env'), 'PORT=0\n')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'checkout.spec.ts'), '// spec\n')

    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const { body } = await entryFor('checkout')
    expect(body.flight).toMatchObject({ flightId, status: 'done' })
    expect(body.active).toBe(false)
    expect(body.canContinue).toBe(false)
    expect(body.prefill).toMatchObject({ repoPaths: [repoDir], description: 'checkout flow', env: 'local' })
    expect(stageOf(body, 'run').allowed).toBe(true)
    // No runId recorded on the flight links (stub adapters) → export blocked.
    expect(stageOf(body, 'evaluation-export').allowed).toBe(false)
    expect(stageOf(body, 'evaluation-export').reason).toMatch(/no run yet/)
  })

  it('flags an active flight (attach, don’t start) and continue for a paused one', async () => {
    writeFeatureConfig('checkout')
    let gate: (() => void) | null = null
    let fail = true
    const adapters = allDone()
    adapters.docs = {
      run: async () => {
        await new Promise<void>((resolve) => { gate = resolve })
        return fail ? { kind: 'failed', error: 'no docs' } : { kind: 'done' }
      },
    }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    // The docs adapter parks on the gate — wait until the conductor reaches it
    // so "active" is observed mid-stage, not at the pre-drive instant.
    const deadline = Date.now() + 3000
    while (gate === null) {
      if (Date.now() > deadline) throw new Error('docs adapter never started')
      await new Promise((r) => setTimeout(r, 10))
    }

    const whileActive = await entryFor('checkout')
    expect(whileActive.body.active).toBe(true)
    expect(whileActive.body.canContinue).toBe(false)

    gate!()
    await waitForStatus(flightId, ['paused'])
    fail = false

    const whilePaused = await entryFor('checkout')
    expect(whilePaused.body.active).toBe(false)
    expect(whilePaused.body.canContinue).toBe(true)
    expect(whilePaused.body.flight).toMatchObject({ flightId, status: 'paused' })
  })
})

describe('POST /api/flights/:id/pause + /redo, frozen args, DELETE', () => {
  const hangingScout = (): StageAdapters => {
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    return adapters
  }

  it('pause parks an active flight with pauseReason user; 409 on a settled one; 404 unknown', async () => {
    app = await buildApp(hangingScout())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['running'])

    const paused = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })
    expect(paused.statusCode).toBe(200)
    expect(paused.json()).toMatchObject({ status: 'paused', pauseReason: 'user' })

    const again = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })
    expect(again.statusCode).toBe(409)

    const unknown = await app.inject({ method: 'POST', url: '/api/flights/nope/pause' })
    expect(unknown.statusCode).toBe(404)
  })

  it('redo restarts the same record from stage 1 (201); 409 while active', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const redone = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/redo` })
    expect(redone.statusCode).toBe(201)
    expect((redone.json() as { flightId: string }).flightId).toBe(flightId)
    await waitForStatus(flightId, ['done'])
  })

  it('repos + intent are frozen: a redo with different values is a 409 flight_frozen', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const otherRepo = path.join(tmpDir, 'other-repo')
    fs.mkdirSync(otherRepo, { recursive: true })
    const repoChange = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ repoPaths: [otherRepo], mode: 'redo' }),
    })
    expect(repoChange.statusCode).toBe(409)
    expect(repoChange.json()).toMatchObject({ type: 'flight_frozen' })

    const intentChange = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ description: 'a different intent', mode: 'redo' }),
    })
    expect(intentChange.statusCode).toBe(409)
    expect(intentChange.json()).toMatchObject({ type: 'flight_frozen' })
  })

  it('a mode-carrying POST may omit repos + description — the stored values are reused', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const redone = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: { feature: 'checkout', mode: 'redo' },
    })
    expect(redone.statusCode).toBe(201)
    const body = redone.json() as { flightId: string; repoPaths: string[]; description: string }
    expect(body.flightId).toBe(flightId)
    expect(body.repoPaths).toEqual([repoDir])
    expect(body.description).toBe('checkout flow')
    await waitForStatus(flightId, ['done'])
  })

  it('DELETE removes a settled record (feature returns to not-flown); 409 while active; 404 unknown', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const deleted = await app.inject({ method: 'DELETE', url: `/api/flights/${flightId}` })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ deleted: true })
    const list = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((list.json() as { flights: unknown[] }).flights).toHaveLength(0)

    const unknown = await app.inject({ method: 'DELETE', url: `/api/flights/${flightId}` })
    expect(unknown.statusCode).toBe(404)

    const activeApp = await buildApp(hangingScout())
    const started2 = await activeApp.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const activeId = (started2.json() as { flightId: string }).flightId
    const whileActive = await activeApp.inject({ method: 'DELETE', url: `/api/flights/${activeId}` })
    expect(whileActive.statusCode).toBe(409)
    await activeApp.close()
  })
})

describe('GET /api/flights collapses to latest-per-feature (R67)', () => {
  it('pre-invariant duplicate records for one feature render as one row (the newest)', async () => {
    const store = new FlightRunStore(tmpDir)
    const stages = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))
    const mk = (flightId: string, feature: string, createdAt: string): FlightManifest => ({
      flightId,
      feature,
      repoPaths: [repoDir],
      description: 'legacy',
      opts: { env: 'local', coverageTarget: 100, yolo: false },
      status: 'done',
      currentStage: null,
      stages: stages.map((s) => ({ ...s })),
      createdAt,
      updatedAt: createdAt,
    })
    // Saved oldest-first; list() is newest-first, so fl-legacy-3 is the keeper.
    store.save(mk('fl-legacy-1', 'first-flight-smoke', '2026-01-01T00:00:00Z'))
    store.save(mk('fl-legacy-2', 'first-flight-smoke', '2026-01-02T00:00:00Z'))
    store.save(mk('fl-legacy-3', 'first-flight-smoke', '2026-01-03T00:00:00Z'))
    store.save(mk('fl-other', 'other-feature', '2026-01-01T12:00:00Z'))

    app = await buildApp(allDone(), store)
    const res = await app.inject({ method: 'GET', url: '/api/flights' })
    const flights = (res.json() as { flights: Array<{ flightId: string; feature: string }> }).flights
    expect(flights).toHaveLength(2)
    expect(flights.find((f) => f.feature === 'first-flight-smoke')!.flightId).toBe('fl-legacy-3')
  })
})

describe('plan-features (R54)', () => {
  const planText = (features: unknown) => `\`\`\`json\n${JSON.stringify({ split: Array.isArray(features) && (features as unknown[]).length > 1, features })}\n\`\`\``

  const agentReturning = (text: string | (() => string)): FlightAgentSpawner => async () => ({
    text: typeof text === 'function' ? text() : text,
  })

  async function planAndWait(instance: FastifyInstance, body?: Record<string, unknown>): Promise<PlanFeaturesTask> {
    const res = await instance.inject({
      method: 'POST',
      url: '/api/flights/plan-features',
      body: { repoPaths: [repoDir], description: 'test everything in this repo', ...body },
    })
    expect(res.statusCode).toBe(202)
    const { taskId } = res.json() as { taskId: string }
    const deadline = Date.now() + 3000
    for (;;) {
      const poll = await instance.inject({ method: 'GET', url: `/api/flights/plan-features/${taskId}` })
      const task = poll.json() as PlanFeaturesTask
      if (task.status !== 'running') return task
      if (Date.now() > deadline) throw new Error('plan task never settled')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('runs the plan agent and settles the proposal (normalized, deduped names)', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'Auth Flow', description: 'test login + signup', scope: 'auth only', group: 'My Shop' },
      { name: 'checkout-flow', description: 'test the checkout', scope: 'cart to payment', group: 'My Shop' },
    ])))
    const task = await planAndWait(app)
    expect(task.status).toBe('done')
    expect(task.result).toMatchObject({
      split: true,
      features: [
        { name: 'auth-flow', description: 'test login + signup', group: 'my-shop' },
        { name: 'checkout-flow', description: 'test the checkout', group: 'my-shop' },
      ],
    })
  })

  it('an unparseable agent answer fails the task with the parse story', async () => {
    app = await buildApp(allDone(), undefined, agentReturning('I could not decide.'))
    const task = await planAndWait(app)
    expect(task.status).toBe('failed')
    expect(task.error).toMatch(/JSON/)
  })

  it('launch creates one running flight + queued siblings that drain sequentially', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'one', description: 'test one' },
      { name: 'two', description: 'test two' },
      { name: 'three', description: 'test three' },
    ])))
    const task = await planAndWait(app)
    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    expect(launched.statusCode).toBe(201)
    const { flightIds } = launched.json() as { flightIds: string[] }
    expect(flightIds).toHaveLength(3)
    // Stub adapters settle instantly, so the drain chain runs the whole batch.
    const deadline = Date.now() + 3000
    for (;;) {
      const list = await app.inject({ method: 'GET', url: '/api/flights' })
      const flights = (list.json() as { flights: Array<{ status: string; opts?: unknown }> }).flights
      if (flights.length === 3 && flights.every((f) => f.status === 'done')) break
      if (Date.now() > deadline) throw new Error(`batch never drained: ${JSON.stringify(flights)}`)
      await new Promise((r) => setTimeout(r, 10))
    }
    // A second launch must not double-create the batch.
    const again = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    expect(again.statusCode).toBe(409)
  })

  it('launch rejects name collisions with existing features/flights up front', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'checkout', description: 'test checkout' },
      { name: 'fresh-one', description: 'test fresh' },
    ])))
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    await waitForStatus((started.json() as { flightId: string }).flightId, ['done'])
    const task = await planAndWait(app)
    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    expect(launched.statusCode).toBe(409)
    expect(launched.json()).toMatchObject({ type: 'feature_name_conflicts', conflicts: ['checkout'] })
    // Nothing was created — a partial batch would be worse than the rejection.
    const list = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((list.json() as { flights: Array<{ feature: string }> }).flights.map((f) => f.feature)).toEqual(['checkout'])
  })

  it('POST attaches to a running task for the same inputs instead of double-spawning', async () => {
    let spawns = 0
    let release: (() => void) | null = null
    const gated: FlightAgentSpawner = async () => {
      spawns += 1
      await new Promise<void>((resolve) => { release = resolve })
      return { text: planText([{ name: 'solo', description: 'test solo' }]) }
    }
    app = await buildApp(allDone(), undefined, gated)
    const body = { repoPaths: [repoDir], description: 'test everything in this repo' }
    const first = await app.inject({ method: 'POST', url: '/api/flights/plan-features', body })
    const second = await app.inject({ method: 'POST', url: '/api/flights/plan-features', body })
    expect((second.json() as { taskId: string }).taskId).toBe((first.json() as { taskId: string }).taskId)
    expect(spawns).toBe(1)
    release!()
  })
})

describe('~-relative repo paths (dialog picker parity)', () => {
  it('expands a leading ~ on start like the entry prefill does', async () => {
    const os = await import('os')
    const home = os.homedir()
    const rel = `.cl-flight-route-test-${process.pid}`
    const abs = path.join(home, rel)
    fs.mkdirSync(abs, { recursive: true })
    try {
      app = await buildApp(allDone())
      const started = await app.inject({
        method: 'POST',
        url: '/api/flights',
        body: startBody({ repoPaths: [`~/${rel}`] }),
      })
      expect(started.statusCode).toBe(201)
      expect((started.json() as { repoPaths: string[] }).repoPaths[0]).toBe(fs.realpathSync(abs))
    } finally {
      fs.rmSync(abs, { recursive: true, force: true })
    }
  })
})
