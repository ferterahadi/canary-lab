import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flightHarness,
  parkedFlight,
  parkedOn,
  plainFlight,
  type FlightReply,
} from './__fixtures__/flight-tools-harness'

// `start_flight`'s follow/resume/start fork, the per-checkpoint steering copy,
// and the inline-budget trim. Separate file from flight.stand-down.test.ts
// because this one mocks the stage-remedy module: `get_flight` calls it on every
// read and it does live `git status` work, which a unit test must not do.
//
// The steering strings are asserted on because they ARE the surface: the MCP
// instructions get truncated at 2048 chars, so what an external agent actually
// does next comes from the tool RESULT.
const remedy = vi.hoisted(() => ({ answer: null as unknown }))
vi.mock('../../features/flights/logic/stage-remedy', () => ({
  flightStageRemedy: async () => remedy.answer,
}))

beforeEach(() => {
  remedy.answer = null
})

/** `start_flight` reads the index first, then acts. Routes both legs. */
function startRoutes(opts: {
  flights?: Array<Record<string, unknown>>
  detail?: FlightReply
  resume?: FlightReply
  create?: FlightReply
}) {
  return (req: { method: string; url: string }): FlightReply => {
    if (req.method === 'GET' && req.url === '/api/flights') {
      return { statusCode: 200, body: { flights: opts.flights ?? [] } }
    }
    if (req.url.endsWith('/resume')) return opts.resume ?? { statusCode: 200, body: plainFlight('running') }
    if (req.method === 'GET') return opts.detail ?? { statusCode: 200, body: plainFlight('running') }
    return opts.create ?? { statusCode: 201, body: plainFlight('running') }
  }
}

describe('start_flight — locating the record before starting one', () => {
  it('refuses a call that names neither repos nor a feature', async () => {
    const { text, requests } = flightHarness({ reply: { statusCode: 200, body: {} } })

    const out = await text('start_flight', {})

    // There is nothing to match on, so guessing would start a flight for the
    // wrong repos rather than fail.
    expect(out).toContain('needs repoPaths for a fresh start')
    expect(requests).toEqual([])
  })

  it('follows an active flight on the same repos instead of starting a second', async () => {
    const { call, requests } = flightHarness({
      reply: startRoutes({
        flights: [{ flightId: 'fl-live', feature: 'shop', status: 'running', repoPaths: ['/repo/shop'] }],
        detail: { statusCode: 200, body: plainFlight('running', { flightId: 'fl-live' }) },
      }),
    })

    const out = await call('start_flight', { repoPaths: ['/repo/shop'], description: 'checkout' })

    expect(out).toMatchObject({ flightId: 'fl-live', note: 'a flight is already active for these repos — following it' })
    expect(String(out.next)).toContain('Flight is running')
    // No POST: following is a read, not a start.
    expect(requests.every((r) => r.method === 'GET')).toBe(true)
  })

  it('matches a repo set that differs only by an unresolved path', async () => {
    const { call } = flightHarness({
      reply: startRoutes({
        flights: [{ flightId: 'fl-live', status: 'waiting-for-approval', repoPaths: ['/repo/shop'] }],
        detail: { statusCode: 200, body: parkedFlight({ flightId: 'fl-live' }) },
      }),
    })

    const out = await call('start_flight', { repoPaths: ['/repo/shop/../shop'], description: 'checkout' })

    expect(out.flightId).toBe('fl-live')
  })

  it('locates a repo-less re-entry by feature name', async () => {
    const { call } = flightHarness({
      reply: startRoutes({
        flights: [{ flightId: 'fl-old', feature: 'checkout', status: 'paused', repoPaths: ['/repo/shop'] }],
        resume: { statusCode: 200, body: plainFlight('running') },
      }),
    })

    const out = await call('start_flight', { feature: 'checkout' })

    expect(out.note).toBe('resumed the paused flight from its first open stage')
  })

  it('maps a resume refused by an active Getting Started demo to the typed busy result', async () => {
    // Resuming the demo flight re-claims the workspace demo session, so it can
    // collide with another active demo exactly like start — the agent needs the
    // same typed shape, not a generic "resume failed".
    const { call } = flightHarness({
      reply: startRoutes({
        flights: [{ flightId: 'fl-old', feature: 'flight-app', status: 'paused' }],
        resume: {
          statusCode: 409,
          body: { type: 'getting_started_busy', error: 'demo busy', active: { sessionId: 'gs-run' } },
        },
      }),
    })

    const out = await call('start_flight', { feature: 'flight-app' })

    expect(out).toMatchObject({
      type: 'getting_started_busy',
      message: 'demo busy',
      active: { sessionId: 'gs-run' },
      next: 'Follow the active demo in its current owner; do not start another run or Flight.',
    })
  })

  it('surfaces a failed resume rather than silently starting fresh', async () => {
    const { text } = flightHarness({
      reply: startRoutes({
        flights: [{ flightId: 'fl-old', feature: 'checkout', status: 'paused' }],
        resume: { statusCode: 409, body: { error: 'flight is aborted' } },
      }),
    })

    expect(await text('start_flight', { feature: 'checkout' })).toContain('resume failed (409): flight is aborted')
  })

  it('starts fresh past a paused record when asked to', async () => {
    const { call, requests } = flightHarness({
      reply: startRoutes({
        flights: [{ flightId: 'fl-old', feature: 'checkout', status: 'paused', repoPaths: ['/repo/shop'] }],
        create: { statusCode: 201, body: plainFlight('running') },
      }),
    })

    await call('start_flight', { repoPaths: ['/repo/shop'], description: 'checkout', fresh: true })

    expect(requests.some((r) => r.url.endsWith('/resume'))).toBe(false)
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/flights')).toBe(true)
  })
})

describe('start_flight — what it sends', () => {
  const created = { statusCode: 201, body: plainFlight('running') }

  it('derives the feature from the first repo when none is named', async () => {
    const { call, requests } = flightHarness({ reply: startRoutes({ create: created }) })

    await call('start_flight', { repoPaths: ['/work/flight-app'], description: 'lending' })

    expect(requests.at(-1)?.payload).toEqual({
      repoPaths: ['/work/flight-app'],
      description: 'lending',
      feature: 'flight-app',
      // Unasked-for and always present: an MCP caller is an interactive agent, so the
      // thinking stages default to IT. Pinned here because the omission is what let two
      // real flights run internally while the user expected to be handed the work.
      stageProducer: 'external',
    })
  })

  it('forwards every optional knob under its wire name', async () => {
    const { call, requests } = flightHarness({ reply: startRoutes({ create: created }) })

    await call('start_flight', {
      repoPaths: ['/repo/shop'], description: 'checkout', feature: 'shop',
      env: 'staging', coverage_target: 80, base: 'main', yolo: true,
      autopilot: false, agent: 'codex', stage_producer: 'external',
    })

    expect(requests.at(-1)?.payload).toEqual({
      repoPaths: ['/repo/shop'], description: 'checkout', feature: 'shop',
      env: 'staging', coverageTarget: 80, base: 'main', yolo: true,
      autopilot: false, agent: 'codex', stageProducer: 'external',
    })
  })

  it('omits the frozen inputs on a jump so the stored ones are reused', async () => {
    const { call, requests } = flightHarness({ reply: startRoutes({ create: created }) })

    await call('start_flight', { feature: 'checkout', from_stage: 'run' })

    // The producer still rides along; the conductor pins the STORED one on a jump, so
    // this cannot retro-switch a flight whose earlier stages ran internally.
    expect(requests.at(-1)?.payload).toEqual({ feature: 'checkout', mode: 'jump', fromStage: 'run', stageProducer: 'external' })
  })

  it('marks a redo as a redo, and carries no fromStage', async () => {
    const { call, requests } = flightHarness({ reply: startRoutes({ create: created }) })

    await call('start_flight', { feature: 'checkout', redo: true })

    expect(requests.at(-1)?.payload).toEqual({ feature: 'checkout', mode: 'redo', stageProducer: 'external' })
  })

  // The web UI's Redo dialog has always been able to tell the entry stage what
  // went wrong; the agent could re-run a stage but not say why. It matters most
  // now that the UI is read-only under external drive — otherwise re-entering a
  // step would silently lose the one piece of context that makes the retry
  // different from the attempt that just failed.
  it('carries a re-entry feedback note on a jump and on a redo', async () => {
    const { call, requests } = flightHarness({ reply: startRoutes({ create: created }) })

    await call('start_flight', { feature: 'checkout', from_stage: 'docs', feedback: 'it summarised the wrong repo' })
    expect(requests.at(-1)?.payload).toMatchObject({ mode: 'jump', fromStage: 'docs', feedback: 'it summarised the wrong repo' })

    await call('start_flight', { feature: 'checkout', redo: true, feedback: 'start clean' })
    expect(requests.at(-1)?.payload).toMatchObject({ mode: 'redo', feedback: 'start clean' })
  })

  // A note with no re-entry has nowhere to go — the conductor only scopes it to
  // an ENTRY stage — so it is dropped rather than sent and silently ignored.
  it('drops a feedback note on a fresh start or a plain resume', async () => {
    const { call, requests } = flightHarness({ reply: startRoutes({ create: created }) })

    await call('start_flight', { repoPaths: ['/repo/shop'], description: 'checkout flow', feedback: 'ignored' })

    expect(requests.at(-1)?.payload).not.toHaveProperty('feedback')
  })

  it('treats an empty repo list as no repos at all', async () => {
    const { text, requests } = flightHarness({ reply: startRoutes({ create: created }) })

    // `repoPaths: []` passes the schema's optionality but names nothing, so it
    // is the same unlocatable call as omitting it.
    expect(await text('start_flight', { repoPaths: [] })).toContain('needs repoPaths for a fresh start')
    expect(requests).toEqual([])
  })

  it('omits repoPaths from the payload when only a feature was given', async () => {
    const { call, requests } = flightHarness({ reply: startRoutes({ create: created }) })

    await call('start_flight', { feature: 'checkout', repoPaths: [], from_stage: 'run' })

    expect(requests.at(-1)?.payload).not.toHaveProperty('repoPaths')
    expect(requests.at(-1)?.payload).toMatchObject({ feature: 'checkout' })
  })
})

describe('start_flight — typed refusals', () => {
  it('reports a Getting Started demo owning the workspace', async () => {
    const { call } = flightHarness({
      reply: startRoutes({
        create: {
          statusCode: 409,
          body: { type: 'getting_started_busy', error: 'a demo run owns the workspace', active: { workflow: 'run' } },
        },
      }),
    })

    const out = await call('start_flight', { repoPaths: ['/repo/shop'], description: 'x' })

    expect(out).toMatchObject({ type: 'getting_started_busy', active: { workflow: 'run' } })
    expect(String(out.next)).toContain('do not start another run or Flight')
  })

  it('turns an existing settled record into the redo/jump choice', async () => {
    const { call } = flightHarness({
      reply: startRoutes({
        create: {
          statusCode: 409,
          body: {
            type: 'flight_exists_requires_choice',
            existingFlightId: 'fl-old', existingStatus: 'done', options: ['redo', 'from_stage'],
          },
        },
      }),
    })

    const out = await call('start_flight', { repoPaths: ['/repo/shop'], description: 'x', feature: 'shop' })

    expect(out).toMatchObject({
      type: 'flight_exists_requires_choice', feature: 'shop',
      existingFlightId: 'fl-old', existingStatus: 'done', options: ['redo', 'from_stage'],
    })
    // The wipe has to be stated: it is the part a user would not expect.
    expect(String(out.next)).toContain('WIPES')
  })

  it('reports a null feature on the exists-choice when the caller named none', async () => {
    const { call } = flightHarness({
      reply: startRoutes({
        create: { statusCode: 409, body: { type: 'flight_exists_requires_choice', existingFlightId: 'fl-old' } },
      }),
    })

    const out = await call('start_flight', { repoPaths: ['/repo/shop'], description: 'x' })

    expect(out.feature).toBeNull()
  })

  it('explains the frozen-inputs rejection instead of repeating the server text', async () => {
    const { text } = flightHarness({
      reply: startRoutes({
        create: { statusCode: 409, body: { type: 'flight_frozen', error: 'repoPaths differ from the stored set' } },
      }),
    })

    const out = await text('start_flight', { repoPaths: ['/repo/other'], description: 'x', feature: 'shop', from_stage: 'run' })

    expect(out).toContain('repoPaths differ from the stored set')
    expect(out).toContain('WITHOUT repoPaths/description')
  })

  it('falls back to generic wording when a frozen rejection carries no message', async () => {
    const { text } = flightHarness({
      reply: startRoutes({ create: { statusCode: 409, body: { type: 'flight_frozen' } } }),
    })

    expect(await text('start_flight', { feature: 'shop', from_stage: 'run' }))
      .toContain('repos and intent are frozen')
  })

  it('surfaces any other start failure with its status', async () => {
    const { text } = flightHarness({
      reply: startRoutes({ create: { statusCode: 400, body: { error: 'repoPaths must be absolute' } } }),
    })

    expect(await text('start_flight', { repoPaths: ['rel/path'], description: 'x' }))
      .toContain('start_flight failed (400): repoPaths must be absolute')
  })

  it('surfaces a failure with no message at all', async () => {
    const { text } = flightHarness({ reply: startRoutes({ create: { statusCode: 500, body: {} } }) })

    expect(await text('start_flight', { repoPaths: ['/repo/shop'], description: 'x' }))
      .toContain('start_flight failed (500)')
  })
})

describe('get_flight — the list mode', () => {
  it('returns slim rows, keeping the pause reason that decides the narration', async () => {
    const { call } = flightHarness({
      reply: {
        statusCode: 200,
        body: {
          flights: [
            { flightId: 'fl-1', feature: 'checkout', status: 'paused', pauseReason: 'queued', currentStage: null, repoPaths: ['/a'], stages: [{ key: 'scout' }] },
            { flightId: 'fl-2', feature: 'search', status: 'done', currentStage: null, repoPaths: ['/b'] },
          ],
        },
      },
    })

    const out = await call('get_flight', {})

    expect(out.flights).toEqual([
      { flightId: 'fl-1', feature: 'checkout', status: 'paused', pauseReason: 'queued', currentStage: null, repoPaths: ['/a'] },
      { flightId: 'fl-2', feature: 'search', status: 'done', currentStage: null, repoPaths: ['/b'] },
    ])
  })

  it('lists nothing without failing when the index is empty', async () => {
    const { call } = flightHarness({ reply: { statusCode: 200, body: {} } })

    expect(await call('get_flight', {})).toEqual({ flights: [] })
  })

  it('reports an unknown id rather than an empty view', async () => {
    const { text } = flightHarness({ reply: { statusCode: 404, body: {} } })

    expect(await text('get_flight', { flightId: 'nope' })).toContain('flight not found: nope')
  })
})

// A parked hand-off has no deadline by design, so the read is the only place a
// client that took the work and vanished can be noticed. Observed live: a client
// wrote the docs file, posted the user a status table, and ended its turn at
// stage 5 of 11 — the flight stayed "waiting-for-approval" with six stages that
// would never start.
describe('get_flight — a hand-off nobody is working', () => {
  const OLD = new Date(Date.now() - 90 * 60 * 1000).toISOString()
  const handOff = (over: Record<string, unknown> = {}) => ({
    ...parkedOn('external-work', { stage: 'docs', prompt: 'do the thing', handOffId: 'h-1' }, ['submit', 'run-internally']),
    updatedAt: OLD,
    ...over,
  })

  it('reports a hand-off no client has checked in on, and says it is still answerable', async () => {
    const { call } = flightHarness({ reply: { statusCode: 200, body: handOff() } })

    const out = await call('get_flight', { flightId: 'fl-1' })

    expect(out.handOffIdle).toMatchObject({ stage: 'docs', neverPolled: true })
    expect(String(out.next)).toContain('STALLED HAND-OFF')
    // The reader must learn it can still submit — otherwise it restarts the stage
    // and throws away work that is sitting on disk.
    expect(String(out.next)).toContain('still answerable')
    // The steering for the hand-off itself still follows the warning.
    expect(String(out.next)).toContain('respond_flight_checkpoint')
  })

  it('goes quiet again once this client has checked in', async () => {
    const { call } = flightHarness({ reply: { statusCode: 200, body: handOff() } })

    await call('get_flight', { flightId: 'fl-1' })
    const second = await call('get_flight', { flightId: 'fl-1' })

    // The first read counted as contact, so the clock now runs from it — a client
    // polling on the documented cadence never sees this warning.
    expect(second.handOffIdle).toBeUndefined()
    expect(String(second.next)).not.toContain('STALLED HAND-OFF')
  })

  it('leaves a fresh hand-off alone', async () => {
    const { call } = flightHarness({
      reply: { statusCode: 200, body: handOff({ updatedAt: new Date().toISOString() }) },
    })

    expect((await call('get_flight', { flightId: 'fl-1' })).handOffIdle).toBeUndefined()
  })

  // Only a hand-off can be abandoned by a client. Every other checkpoint is a
  // QUESTION for the user, and a user taking their time is not a stall.
  it('says nothing about a long-parked question for the user', async () => {
    const { call } = flightHarness({
      reply: { statusCode: 200, body: { ...parkedOn('prd-source'), updatedAt: OLD } },
    })

    expect((await call('get_flight', { flightId: 'fl-1' })).handOffIdle).toBeUndefined()
  })

  it('says nothing about a flight that is not parked at all', async () => {
    const { call } = flightHarness({
      reply: { statusCode: 200, body: { ...plainFlight('running'), updatedAt: OLD } },
    })

    expect((await call('get_flight', { flightId: 'fl-1' })).handOffIdle).toBeUndefined()
  })

  // The imperative that has to ride the result rather than the skill: a skill can
  // be compacted out of a client's context halfway through the pipeline.
  it('tells the client not to end its turn while the step is open', async () => {
    const { call } = flightHarness({
      reply: { statusCode: 200, body: handOff({ updatedAt: new Date().toISOString() }) },
    })

    const next = String((await call('get_flight', { flightId: 'fl-1' })).next)

    expect(next).toContain('DO NOT END YOUR TURN')
    expect(next).toContain('a status update to the user is not progress')
  })
})

describe('get_flight — the dirty-repo remedy', () => {
  it('hands over the exact repos to clean, alongside the normal steering', async () => {
    remedy.answer = { stage: 'run', repos: [{ name: 'shop', modified: 3, path: '/repo/shop' }] }
    const { call } = flightHarness({
      reply: { statusCode: 200, body: plainFlight('paused', { pauseReason: 'stage-failed' }) },
    })

    const out = await call('get_flight', { flightId: 'fl-1' })

    expect(out.remedy).toMatchObject({ stage: 'run' })
    const next = String(out.next)
    expect(next).toContain('"shop" (3 files, /repo/shop)')
    expect(next).toContain('git stash push -u')
    // The base steering survives — the remedy is additive, not a replacement.
    expect(next).toContain('start_flight on the same repos resumes it')
  })

  it('says so when the repos were cleaned outside the conversation', async () => {
    remedy.answer = { stage: 'run', repos: [] }
    const { call } = flightHarness({
      reply: { statusCode: 200, body: plainFlight('paused', { pauseReason: 'stage-failed' }) },
    })

    const next = String((await call('get_flight', { flightId: 'fl-1' })).next)

    expect(next).toContain('every repo is CLEAN now')
  })

  it('skips the agent-jobs read entirely when a remedy is present', async () => {
    remedy.answer = { stage: 'run', repos: [] }
    const { call, requests } = flightHarness({
      reply: { statusCode: 200, body: plainFlight('paused', { pauseReason: 'stage-failed' }) },
    })

    await call('get_flight', { flightId: 'fl-1' })

    expect(requests.some((r) => r.url.startsWith('/api/agent-jobs'))).toBe(false)
  })
})

describe('get_flight — the flight view', () => {
  it('carries the terminal fields a client reads for the deliverable', async () => {
    const { call } = flightHarness({
      reply: {
        statusCode: 200,
        body: plainFlight('done', {
          runVerdict: 'passed',
          links: { evaluationZip: '/logs/eval.zip' },
          stages: [
            { key: 'run', status: 'done' },
            { key: 'portify', status: 'skipped', skipReason: 'gate' },
            { key: 'docs', status: 'failed', error: 'no docs found' },
          ],
        }),
      },
    })

    const out = await call('get_flight', { flightId: 'fl-1' })

    expect(out).toMatchObject({
      runVerdict: 'passed',
      links: { evaluationZip: '/logs/eval.zip' },
      stages: [
        { key: 'run', status: 'done' },
        { key: 'portify', status: 'skipped', skipReason: 'gate' },
        { key: 'docs', status: 'failed', error: 'no docs found' },
      ],
    })
    expect(String(out.next)).toContain('links.evaluationZip is the deliverable')
  })

  it('reports a stage error on the record itself', async () => {
    const { call } = flightHarness({
      reply: { statusCode: 200, body: plainFlight('failed', { error: 'scaffold blew up' }) },
    })

    const out = await call('get_flight', { flightId: 'fl-1' })

    expect(out.error).toBe('scaffold blew up')
    // No steering exists for a hard failure — it is terminal and self-evident.
    expect(out.next).toBe('')
  })

  it('trims an oversized non-external payload to a pointer at the web UI', async () => {
    const { call } = flightHarness({
      reply: { statusCode: 200, body: parkedOn('similarity-choice', { candidates: 'x'.repeat(9 * 1024) }) },
    })

    const out = await call('get_flight', { flightId: 'fl-1' })

    expect((out.checkpoint as { data: Record<string, unknown> }).data)
      .toEqual({ omitted: true, reason: expect.stringContaining('review it in the web UI') })
  })

  it('trims an external-work payload with no promptPath the same way', async () => {
    // Without a path there is nothing to Read, so the degraded form is the same
    // "go look in the UI" as any other oversized checkpoint.
    const { call } = flightHarness({
      reply: { statusCode: 200, body: parkedOn('external-work', { stage: 'scout', prompt: 'x'.repeat(9 * 1024) }) },
    })

    const data = ((await call('get_flight', { flightId: 'fl-1' })).checkpoint as { data: Record<string, unknown> }).data

    expect(data).toEqual({ omitted: true, reason: expect.stringContaining('review it in the web UI') })
  })

  it('keeps a small context beside a trimmed prompt, and drops a large one', async () => {
    const small = flightHarness({
      reply: {
        statusCode: 200,
        body: parkedOn('external-work', {
          stage: 'scout', prompt: 'x'.repeat(9 * 1024),
          promptPath: '/f/task.md', context: { repo: 'shop' },
        }),
      },
    })
    const dataSmall = ((await small.call('get_flight', { flightId: 'fl-1' })).checkpoint as { data: Record<string, unknown> }).data
    expect(dataSmall).toMatchObject({ promptOmitted: true, context: { repo: 'shop' } })

    const big = flightHarness({
      reply: {
        statusCode: 200,
        body: parkedOn('external-work', {
          stage: 'scout', prompt: 'x'.repeat(9 * 1024),
          promptPath: '/f/task.md', context: { blob: 'y'.repeat(9 * 1024) },
        }),
      },
    })
    const dataBig = ((await big.call('get_flight', { flightId: 'fl-1' })).checkpoint as { data: Record<string, unknown> }).data
    expect(dataBig).not.toHaveProperty('context')
  })
})

describe('get_flight — steering per checkpoint kind', () => {
  const nextFor = async (body: Record<string, unknown>): Promise<string> => {
    const { call } = flightHarness({ reply: { statusCode: 200, body } })
    return String((await call('get_flight', { flightId: 'fl-1' })).next)
  }

  it('names the options for a checkpoint it has no special copy for', async () => {
    const next = await nextFor(parkedOn('similarity-choice', undefined, ['new', 'extend']))

    expect(next).toContain('parked on the similarity-choice checkpoint')
    expect(next).toContain('["new","extend"]')
  })

  it('falls back to a generic label when the checkpoint declares no kind', async () => {
    const next = await nextFor({
      flightId: 'fl-1', feature: 'checkout', status: 'waiting-for-approval', currentStage: 'docs',
      stages: [{ key: 'docs', status: 'waiting-for-approval', checkpoint: { message: 'hm' } }],
    })

    expect(next).toContain('parked on the checkpoint checkpoint')
    expect(next).toContain('[]')
  })

  it('frames prd-source as a two-path fork on a first visit', async () => {
    const next = await nextFor(parkedOn('prd-source', {}, ['continue', 'collect-repo-docs', 'infer-from-diff']))

    expect(next).toContain('two-path fork')
    expect(next).toContain('write_feature_doc("checkout"')
    expect(next).not.toContain('NOTE —')
  })

  for (const [label, last, expected] of [
    ['a no-diff attempt', { mode: 'infer-from-diff', outcome: 'no-diff' }, 'found no meaningful diff'],
    ['an attempt that reported why', { mode: 'collect-repo-docs', outcome: 'empty', reason: 'only READMEs' }, 'searched and found nothing relevant: only READMEs'],
    ['an attempt with no reason', { mode: 'collect-repo-docs', outcome: 'no-output' }, 'ran but produced no requirements doc'],
  ] as const) {
    it(`warns off repeating ${label}`, async () => {
      const next = await nextFor(parkedOn('prd-source', { lastAttempt: last }, ['continue']))

      // The re-park must not read as a neutral first visit: repeating the same
      // collector over the same repos is the one choice already known to fail.
      expect(next).toContain('Do NOT simply repeat that same choice')
      expect(next).toContain(expected)
      expect(next).toContain(`a previous "${last.mode}" gather`)
    })
  }

  it('tells an external-work client to read the prompt from disk when it was trimmed', async () => {
    const next = await nextFor(parkedOn('external-work', {
      stage: 'specs-coverage', promptPath: '/f/task.md', handOffId: 'tok-1',
    }, ['submit', 'run-internally']))

    expect(next).toContain('Read checkpoint.data.promptPath (/f/task.md)')
    expect(next).toContain('Pass token:"tok-1"')
  })

  it('points at the inline prompt when there is one, and omits the token rule without an id', async () => {
    const next = await nextFor(parkedOn('external-work', { stage: 'scout', prompt: 'survey it' }, ['submit']))

    expect(next).toContain('checkpoint.data.prompt is the task')
    expect(next).not.toContain('Pass token:')
  })

  it('tells a fan-out-capable client to divide the reading', async () => {
    const { call } = flightHarness({
      reply: { statusCode: 200, body: parkedFlight() },
      clientFacts: { surface: 'claude-code', canFanOut: true, sampling: false },
    })

    const next = String((await call('get_flight', { flightId: 'fl-1' })).next)

    expect(next).toContain('supports subagents')
  })

  it('tells a Desktop chat client to read serially instead', async () => {
    const { call } = flightHarness({
      reply: { statusCode: 200, body: parkedFlight() },
      clientFacts: { surface: 'claude-desktop-chat', canFanOut: false, sampling: false },
    })

    const next = String((await call('get_flight', { flightId: 'fl-1' })).next)

    expect(next).toContain('no subagent primitive')
  })

  for (const [kind, marker] of [
    ['config-approval', 'the REAL on-disk feature.config.cjs'],
    ['export-mode', 'raw = fast report straight from run evidence'],
    ['portify-gate', 'UPFRONT parallel-readiness ask'],
    ['portify-apply', 'passed a concurrent double-boot'],
  ] as const) {
    it(`explains the ${kind} choice in its own terms`, async () => {
      expect(await nextFor(parkedOn(kind))).toContain(marker)
    })
  }
})

describe('every flight tool refuses cleanly with no flights dependency', () => {
  const TOOLS: Array<[string, Record<string, unknown>]> = [
    ['start_flight', { repoPaths: ['/repo/shop'], description: 'x' }],
    ['get_flight', { flightId: 'fl-1' }],
    ['pause_flight', { flightId: 'fl-1' }],
    ['abort_flight', { flightId: 'fl-1', confirm: true }],
    ['stop_flight_agent', { flightId: 'fl-1', confirm: true }],
    ['respond_flight_checkpoint', { flightId: 'fl-1', choice: 'submit' }],
  ]

  for (const [tool, args] of TOOLS) {
    it(`${tool} says the dependency is missing`, async () => {
      const { text } = flightHarness({ reply: { statusCode: 200, body: {} }, unavailable: true })

      // A CLI-only build registers the tools without the REST bridge; every one
      // of them has to say why rather than throwing an SDK-level error.
      expect(await text(tool, args)).toContain('flightsRequest dependency is not configured')
    })
  }

  it('registers exactly the six flight tools', async () => {
    const { toolNames } = flightHarness({ reply: { statusCode: 200, body: {} } })

    expect(toolNames.sort()).toEqual([
      'abort_flight', 'get_flight', 'pause_flight',
      'respond_flight_checkpoint', 'start_flight', 'stop_flight_agent',
    ])
  })
})

describe('flight tools — the missing-field fallbacks', () => {
  const bare = { flightId: 'fl-1', feature: 'checkout', status: 'running', currentStage: 'scout' }

  it('reads a flight record that carries no stages array at all', async () => {
    const { call } = flightHarness({ reply: { statusCode: 200, body: bare } })

    const out = await call('get_flight', { flightId: 'fl-1' })

    expect(out.stages).toEqual([])
    expect(out).not.toHaveProperty('checkpoint')
  })

  it('reads an index response that carries no flights array', async () => {
    const { text } = flightHarness({
      reply: (req) => req.method === 'GET' && req.url === '/api/flights'
        ? { statusCode: 200, body: {} }
        : { statusCode: 201, body: bare },
    })

    // No index rows means nothing to follow or resume — it starts fresh.
    expect(await text('start_flight', { repoPaths: ['/repo/shop'], description: 'x' })).toContain('fl-1')
  })

  it('skips an index row that lists no repos when matching on repos', async () => {
    const { call, requests } = flightHarness({
      reply: (req) => req.url === '/api/flights' && req.method === 'GET'
        ? { statusCode: 200, body: { flights: [{ flightId: 'fl-other', status: 'running' }] } }
        : { statusCode: 201, body: bare },
    })

    await call('start_flight', { repoPaths: ['/repo/shop'], description: 'x' })

    // A repo-less row can never match a repo set, so it must not be followed.
    expect(requests.some((r) => r.method === 'POST')).toBe(true)
  })

  it('reports a message-less resume, pause, abort and respond failure by status alone', async () => {
    const resume = flightHarness({
      reply: (req) => req.url === '/api/flights' && req.method === 'GET'
        ? { statusCode: 200, body: { flights: [{ flightId: 'fl-1', feature: 'checkout', status: 'paused' }] } }
        : { statusCode: 500, body: {} },
    })
    expect(await resume.text('start_flight', { feature: 'checkout' })).toBe('resume failed (500): ')

    const other = flightHarness({ reply: { statusCode: 500, body: {} } })
    expect(await other.text('pause_flight', { flightId: 'fl-1' })).toBe('pause failed (500): ')
    expect(await other.text('abort_flight', { flightId: 'fl-1', confirm: true })).toBe('abort failed (500): ')
    expect(await other.text('respond_flight_checkpoint', { flightId: 'fl-1', choice: 'submit' })).toBe('respond failed (500): ')
  })

  it('keeps the flight view when the remedy check itself throws', async () => {
    remedy.answer = Promise.reject(new Error('git is not installed'))
    const { call } = flightHarness({ reply: { statusCode: 200, body: bare } })

    const out = await call('get_flight', { flightId: 'fl-1' })

    // A broken git must not cost the agent the read it actually asked for.
    expect(out.status).toBe('running')
    expect(out).not.toHaveProperty('remedy')
  })

  it('ignores an agent-jobs response with no jobs array', async () => {
    const { call } = flightHarness({
      reply: (req) => req.url.startsWith('/api/agent-jobs')
        ? { statusCode: 200, body: {} }
        : { statusCode: 200, body: bare },
    })

    expect(await call('get_flight', { flightId: 'fl-1' })).not.toHaveProperty('agentJob')
  })

  it('ignores a failed agent-jobs read', async () => {
    const { call } = flightHarness({
      reply: (req) => req.url.startsWith('/api/agent-jobs')
        ? { statusCode: 503, body: {} }
        : { statusCode: 200, body: bare },
    })

    expect(await call('get_flight', { flightId: 'fl-1' })).not.toHaveProperty('agentJob')
  })

  it('keeps a rejection notice on an oversized external-work payload', async () => {
    const { call } = flightHarness({
      reply: {
        statusCode: 200,
        body: parkedOn('external-work', {
          stage: 'scout', prompt: 'x'.repeat(9 * 1024),
          promptPath: '/f/task.md', handOffId: 'tok-9', lastRejection: 'stale_submission',
        }, ['submit']),
      },
    })

    const data = ((await call('get_flight', { flightId: 'fl-1' })).checkpoint as { data: Record<string, unknown> }).data

    // Both survive the trim: without the id the client cannot submit, and
    // without the rejection it repeats the work that was just discarded.
    expect(data).toMatchObject({ handOffId: 'tok-9', lastRejection: 'stale_submission', promptOmitted: true })
  })

  it('stops a job that reports no stage, and says so without one', async () => {
    const { call } = flightHarness({
      reply: (req) => req.url.startsWith('/api/agent-jobs?')
        ? { statusCode: 200, body: { jobs: [{ jobId: 'fl-1:scout', status: 'running' }] } }
        : { statusCode: 202, body: { stopped: true } },
    })

    const out = await call('stop_flight_agent', { flightId: 'fl-1', confirm: true })

    expect(out.stopped).toEqual([{ jobId: 'fl-1:scout' }])
  })

  it('finds nothing to stop when the jobs response has no jobs array', async () => {
    const { call } = flightHarness({ reply: { statusCode: 200, body: {} } })

    const out = await call('stop_flight_agent', { flightId: 'fl-1', confirm: true })

    expect(out.stopped).toEqual([])
    expect(String(out.next)).toContain('no live agent')
  })

  it('reports nothing stopped when the stop call is refused', async () => {
    const { call } = flightHarness({
      reply: (req) => req.url.startsWith('/api/agent-jobs?')
        ? { statusCode: 200, body: { jobs: [{ jobId: 'fl-1:scout', status: 'running' }] } }
        : { statusCode: 409, body: {} },
    })

    const out = await call('stop_flight_agent', { flightId: 'fl-1', confirm: true })

    expect(out.stopped).toEqual([])
  })
})

describe('respond_flight_checkpoint — what rides the response', () => {
  it('sends only the fields the caller actually supplied', async () => {
    const { call, requests } = flightHarness({ reply: { statusCode: 200, body: parkedFlight() } })

    await call('respond_flight_checkpoint', { flightId: 'fl-1' })

    expect(requests[0].payload).toEqual({ response: {} })
  })

  it('carries every field when the caller supplies them all', async () => {
    const { call, requests } = flightHarness({ reply: { statusCode: 200, body: parkedFlight() } })

    await call('respond_flight_checkpoint', {
      flightId: 'fl-1', choice: 'revise', values: { API_KEY: 'x' },
      data: { configSource: 'module.exports = {}' }, feedback: 'use port 4100', token: 'tok-1',
    })

    expect(requests[0].payload).toEqual({
      response: {
        choice: 'revise', values: { API_KEY: 'x' },
        data: { configSource: 'module.exports = {}' }, feedback: 'use port 4100', token: 'tok-1',
      },
    })
  })

  it('sends an explicitly null data field, which is a real answer', async () => {
    const { call, requests } = flightHarness({ reply: { statusCode: 200, body: parkedFlight() } })

    await call('respond_flight_checkpoint', { flightId: 'fl-1', choice: 'submit', data: null })

    // `data !== undefined` rather than a truthiness check: null is a submitted
    // result, not an omitted one.
    expect(requests[0].payload).toEqual({ response: { choice: 'submit', data: null } })
  })
})
