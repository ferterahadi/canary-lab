import { describe, expect, it } from 'vitest'
import { CLIENT_KIND, type ToolGroupContext } from '../tool-support'
import { registerFlightTools } from './flight'

// What an external coding agent is TOLD when the flight it is working for stops.
//
// This is the one surface where prose is load-bearing rather than decorative. The
// agent cannot be interrupted mid-turn — the MCP server ships tools only, no
// connected client declares `sampling`, and the external work happens BETWEEN tool
// calls, so there is no open request to cancel. Its next tool call is the entire
// channel. If that reply reads as "retry", it retries; if it says "resume the
// flight", it restarts the thing the user just stopped.

type Handler = (args: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }>

interface HarnessOpts {
  /** Reply the fake REST layer returns for every flightsRequest. */
  reply: { statusCode: number; body: unknown }
}

function harness(opts: HarnessOpts) {
  const handlers = new Map<string, Handler>()
  const configs = new Map<string, { inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }>()
  const requests: Array<{ method: string; url: string; payload?: unknown }> = []
  const ctx = {
    registerTool: ((name: string, config: { inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }, handler: Handler) => {
      handlers.set(name, handler)
      configs.set(name, config)
    }) as unknown as ToolGroupContext['registerTool'],
    deps: {
      flightsRequest: async (req: { method: string; url: string; payload?: unknown }) => {
        requests.push(req)
        return opts.reply
      },
    } as unknown as ToolGroupContext['deps'],
    clientFacts: () => ({ kind: 'other' as const, name: 'test', canFanOut: false }),
    clientKindInput: CLIENT_KIND.default('other'),
  } as unknown as ToolGroupContext
  registerFlightTools(ctx)
  const text = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    const result = await handlers.get(tool)!(args)
    return result.content?.[0]?.text ?? ''
  }
  // errorResult returns plain prose, asJsonResult returns JSON — a caller asserting
  // on the structured shape wants the latter.
  const call = async (tool: string, args: Record<string, unknown>) =>
    JSON.parse(await text(tool, args)) as Record<string, unknown>
  return { call, text, requests, configs }
}

const parkedFlight = (over: Record<string, unknown> = {}) => ({
  flightId: 'fl-1',
  feature: 'checkout',
  status: 'waiting-for-approval',
  currentStage: 'scout',
  stages: [{ key: 'scout', status: 'waiting-for-approval', checkpoint: {
    kind: 'external-work',
    message: 'do the scout step',
    options: ['submit', 'run-internally'],
    data: { stage: 'scout', prompt: 'survey the repo', handOffId: 'abc12345' },
  } }],
  ...over,
})

describe('respond_flight_checkpoint — a stopped flight tells the client to stand down', () => {
  it('maps the paused rejection to a typed stand-down, not a bare error', async () => {
    const { call } = harness({
      reply: {
        statusCode: 409,
        body: { error: 'flight fl-1 is paused, not waiting for approval', type: 'flight_not_parked', status: 'paused', pauseReason: 'user' },
      },
    })
    const out = await call('respond_flight_checkpoint', { flightId: 'fl-1', choice: 'submit', data: { x: 1 } })

    expect(out).toMatchObject({ type: 'flight_stopped', status: 'paused', pauseReason: 'user' })
    const next = String(out.next)
    // The three instructions that matter, because each one is a mistake an agent
    // makes by default: it retries, it resumes, or it says nothing to the user.
    expect(next).toContain('DISCARD')
    expect(next).toContain('Do not resubmit')
    expect(next).toMatch(/do not resume the flight yourself/i)
    // And it must NOT read as retryable.
    expect(next).not.toMatch(/try again|retry/i)
  })

  it('says terminal, not resumable, when the flight was aborted', async () => {
    const { call } = harness({
      reply: { statusCode: 409, body: { error: 'aborted', type: 'flight_not_parked', status: 'aborted' } },
    })
    const out = await call('respond_flight_checkpoint', { flightId: 'fl-1', choice: 'submit' })
    expect(out).toMatchObject({ type: 'flight_stopped', status: 'aborted' })
    expect(String(out.next)).toContain('ABORTED')
    expect(String(out.next)).toContain('redo:true')
  })

  it('maps a takeover rejection to stop-and-release instructions', async () => {
    const { call } = harness({
      reply: {
        statusCode: 409,
        body: {
          error: 'takeover requested',
          type: 'flight_takeover_requested',
          requestedAt: '2026-08-25T01:00:00.000Z',
        },
      },
    })
    const out = await call('respond_flight_checkpoint', {
      flightId: 'fl-1', choice: 'submit', data: { x: 1 },
    })
    expect(out).toMatchObject({
      type: 'takeover_requested',
      flightId: 'fl-1',
      requestedAt: '2026-08-25T01:00:00.000Z',
    })
    expect(String(out.next)).toContain('STOP your work')
    expect(String(out.next)).toContain('choice:"run-internally"')
    expect(String(out.next)).not.toMatch(/retry/i)
  })

  it('leaves every other failure as a plain error', async () => {
    const { text } = harness({ reply: { statusCode: 404, body: { error: 'flight not found: nope' } } })
    const out = await text('respond_flight_checkpoint', { flightId: 'nope', choice: 'submit' })
    // No stand-down framing for an unrelated failure — "discard your work" would be
    // wrong advice for a typo'd id.
    expect(out).toContain('respond failed (404)')
    expect(out).not.toContain('flight_stopped')
  })

  it('forwards the hand-off token so the server can match the submit to its ask', async () => {
    const { call, requests } = harness({ reply: { statusCode: 200, body: parkedFlight() } })
    await call('respond_flight_checkpoint', { flightId: 'fl-1', choice: 'submit', token: 'abc12345' })
    expect(requests[0].payload).toMatchObject({ response: { choice: 'submit', token: 'abc12345' } })
  })

  it('omits the token when the caller passes none', async () => {
    const { call, requests } = harness({ reply: { statusCode: 200, body: parkedFlight() } })
    await call('respond_flight_checkpoint', { flightId: 'fl-1', choice: 'continue' })
    expect((requests[0].payload as { response: Record<string, unknown> }).response).not.toHaveProperty('token')
  })
})

describe('get_flight — steering after a stop', () => {
  it('a USER pause tells the agent to stand down, never to resume', async () => {
    const { call } = harness({
      reply: { statusCode: 200, body: { flightId: 'fl-1', feature: 'checkout', status: 'paused', pauseReason: 'user', currentStage: 'scout', stages: [] } },
    })
    const out = await call('get_flight', { flightId: 'fl-1' })
    const next = String(out.next)
    expect(next).toContain('USER paused')
    expect(next).toMatch(/do not resume it unless they ask/i)
    expect(next).toMatch(/discard that result/i)
  })

  it('a stage failure still offers the resume, because that IS the fix', async () => {
    const { call } = harness({
      reply: { statusCode: 200, body: { flightId: 'fl-1', feature: 'checkout', status: 'paused', pauseReason: 'stage-failed', currentStage: 'run', stages: [] } },
    })
    expect(String((await call('get_flight', { flightId: 'fl-1' })).next)).toContain('start_flight on the same repos resumes it')
  })

  it('a queued flight keeps its "waiting, not stuck" wording', async () => {
    const { call } = harness({
      reply: { statusCode: 200, body: { flightId: 'fl-1', feature: 'checkout', status: 'paused', pauseReason: 'queued', currentStage: null, stages: [] } },
    })
    expect(String((await call('get_flight', { flightId: 'fl-1' })).next)).toContain('queued, not stuck')
  })

  it('an aborted flight says so instead of returning nothing', async () => {
    // It used to return '' — so an agent asking why its submit failed got a view
    // with no guidance at all and was free to invent some.
    const { call } = harness({
      reply: { statusCode: 200, body: { flightId: 'fl-1', feature: 'checkout', status: 'aborted', currentStage: null, stages: [] } },
    })
    const next = String((await call('get_flight', { flightId: 'fl-1' })).next)
    expect(next).toContain('ABORTED')
    expect(next).toMatch(/discard/i)
  })

  it('an external-work park carries the token rule and the before-submit re-check', async () => {
    const { call } = harness({ reply: { statusCode: 200, body: parkedFlight() } })
    const next = String((await call('get_flight', { flightId: 'fl-1' })).next)
    expect(next).toContain('token:"abc12345"')
    expect(next).toMatch(/re-call get_flight immediately before submitting/i)
  })

  it('leads with the discard notice when a submit was already refused here', async () => {
    // Ordering is the point: an agent that reads the task first and the rejection
    // second does the same thing over again.
    const flight = parkedFlight()
    flight.stages[0].checkpoint.data = { ...flight.stages[0].checkpoint.data, lastRejection: 'stale_submission' }
    const { call } = harness({ reply: { statusCode: 200, body: flight } })
    const next = String((await call('get_flight', { flightId: 'fl-1' })).next)
    expect(next.startsWith('A previous submit for this step was DISCARDED')).toBe(true)
  })

  it('tells the external client to release when the user requested takeover', async () => {
    const flight = parkedFlight({ updatedAt: '2020-01-01T00:00:00.000Z' })
    flight.stages[0].checkpoint.data = {
      ...flight.stages[0].checkpoint.data,
      takeoverRequestedAt: '2026-08-25T01:00:00.000Z',
    }
    const { call } = harness({ reply: { statusCode: 200, body: flight } })
    const out = await call('get_flight', { flightId: 'fl-1' })
    expect(String(out.next)).toMatch(/^TAKEOVER REQUESTED/)
    expect(String(out.next)).toContain('choice:"run-internally"')
    // The request is not an abandoned hand-off. Waiting is intentional until
    // this client releases, so the generic 45-minute idle warning is suppressed.
    expect(out.handOffIdle).toBeUndefined()
  })

  it('keeps the Report path in a takeover of legacy external Parallel setup', async () => {
    const flight = parkedFlight({ currentStage: 'portify', links: { evaluationZip: '/runs/evaluation.zip' } })
    flight.stages[0].checkpoint.data = {
      ...flight.stages[0].checkpoint.data,
      stage: 'portify',
      takeoverRequestedAt: '2026-08-25T01:00:00.000Z',
    }
    const { call } = harness({ reply: { statusCode: 200, body: flight } })
    const next = String((await call('get_flight', { flightId: 'fl-1' })).next)

    expect(next).toContain('TAKEOVER REQUESTED')
    expect(next).toContain('Report is ready')
    expect(next).toContain('/runs/evaluation.zip')
  })

  it('keeps the hand-off id when an oversized prompt is trimmed out of the view', async () => {
    // Without the id the client cannot submit at all, so it is structural — it has
    // to survive the same trim that drops the prompt.
    const flight = parkedFlight()
    flight.stages[0].checkpoint.data = {
      stage: 'scout',
      prompt: 'x'.repeat(9 * 1024),
      promptPath: '/flights/fl-1/scout/external-task.md',
      handOffId: 'abc12345',
      takeoverRequestedAt: '2026-08-25T01:00:00.000Z',
    }
    const { call } = harness({ reply: { statusCode: 200, body: flight } })
    const out = await call('get_flight', { flightId: 'fl-1' })
    const data = (out.checkpoint as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({
      handOffId: 'abc12345',
      takeoverRequestedAt: '2026-08-25T01:00:00.000Z',
      promptOmitted: true,
    })
    expect(data.prompt).toBeUndefined()
  })
})

describe('pause_flight / abort_flight — stopping from the client, not just the browser', () => {
  const stoppedFlight = (status: string, pauseReason?: string) => ({
    flightId: 'fl-1', feature: 'checkout', status, currentStage: null, stages: [],
    ...(pauseReason ? { pauseReason } : {}),
  })

  it('pause_flight hits the same route the UI does', async () => {
    const { call, requests } = harness({ reply: { statusCode: 200, body: stoppedFlight('paused', 'user') } })
    const out = await call('pause_flight', { flightId: 'fl-1' })
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/flights/fl-1/pause' })
    // Same view + steering shape every other flight tool returns, so a client does
    // not need a special reader for this one.
    expect(out).toMatchObject({ flightId: 'fl-1', status: 'paused', pauseReason: 'user' })
    expect(String(out.next)).toContain('USER paused')
  })

  it('abort_flight hits the abort route and reports a terminal end', async () => {
    const { call, requests } = harness({ reply: { statusCode: 200, body: stoppedFlight('aborted') } })
    const out = await call('abort_flight', { flightId: 'fl-1', confirm: true })
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/flights/fl-1/abort' })
    expect(out).toMatchObject({ status: 'aborted' })
    expect(String(out.next)).toContain('ABORTED')
  })

  it('gates abort on confirm, but never pause', async () => {
    // The reason these are two tools instead of one with a mode argument: a schema
    // cannot require `confirm` for only one value of a mode arg, so a single tool
    // would either nag on the safe path or leave the terminal one unguarded.
    const { configs } = harness({ reply: { statusCode: 200, body: stoppedFlight('paused', 'user') } })
    expect(Object.keys(configs.get('abort_flight')!.inputSchema!)).toContain('confirm')
    expect(configs.get('abort_flight')!.annotations).toMatchObject({ destructiveHint: true })
    expect(Object.keys(configs.get('pause_flight')!.inputSchema!)).not.toContain('confirm')
  })

  it('surfaces the route rejection when the flight is not active', async () => {
    const { text } = harness({ reply: { statusCode: 409, body: { error: 'flight fl-1 is done, not active — nothing to pause' } } })
    expect(await text('pause_flight', { flightId: 'fl-1' })).toContain('pause failed (409)')
  })

  it('surfaces an unknown flight on abort', async () => {
    const { text } = harness({ reply: { statusCode: 404, body: { error: 'flight not found: nope' } } })
    expect(await text('abort_flight', { flightId: 'nope', confirm: true })).toContain('abort failed (404)')
  })
})

describe('stop_flight_agent — the narrow stop', () => {
  /** The harness above returns one reply for every request; this one varies by URL,
   *  because the tool reads the job list and then posts a stop. */
  function jobsHarness(jobs: Array<{ jobId: string; status: string; stage?: string }>, stopCode = 202) {
    const handlers = new Map<string, Handler>()
    const requests: Array<{ method: string; url: string }> = []
    const ctx = {
      registerTool: ((name: string, _c: unknown, handler: Handler) => { handlers.set(name, handler) }) as unknown as ToolGroupContext['registerTool'],
      deps: {
        flightsRequest: async (req: { method: string; url: string }) => {
          requests.push(req)
          if (req.url.startsWith('/api/agent-jobs?')) return { statusCode: 200, body: { jobs } }
          if (req.url.endsWith('/stop')) return { statusCode: stopCode, body: { stopped: stopCode === 202 } }
          return { statusCode: 200, body: {} }
        },
      } as unknown as ToolGroupContext['deps'],
      clientFacts: () => ({ kind: 'other' as const, name: 'test', canFanOut: false }),
      clientKindInput: CLIENT_KIND.default('other'),
    } as unknown as ToolGroupContext
    registerFlightTools(ctx)
    return {
      requests,
      call: async (tool: string, args: Record<string, unknown>) =>
        JSON.parse((await handlers.get(tool)!(args)).content?.[0]?.text ?? '{}') as Record<string, unknown>,
    }
  }

  it('stops the live agent and says what that does to the flight', async () => {
    const { call, requests } = jobsHarness([{ jobId: 'fl-1:specs-coverage', status: 'running', stage: 'specs-coverage' }])
    const out = await call('stop_flight_agent', { flightId: 'fl-1', confirm: true })
    expect(requests.map((r) => r.url)).toContain('/api/agent-jobs/fl-1%3Aspecs-coverage/stop')
    expect(out.stopped).toEqual([{ jobId: 'fl-1:specs-coverage', stage: 'specs-coverage' }])
    // The consequence has to be in the copy: the flight does NOT sail on, it parks
    // stage-failed. Promising otherwise is the overclaim this wording exists to
    // prevent.
    expect(String(out.next)).toContain('stage-failed')
    expect(String(out.next)).toContain('run/export were left alone')
  })

  it('leaves settled agents alone', async () => {
    const { call, requests } = jobsHarness([{ jobId: 'fl-1:scout', status: 'done' }])
    const out = await call('stop_flight_agent', { flightId: 'fl-1', confirm: true })
    expect(out.stopped).toEqual([])
    expect(requests.some((r) => r.url.endsWith('/stop'))).toBe(false)
  })

  it('explains WHY there is nothing to stop rather than erroring', async () => {
    // A flight parked on a checkpoint, or one whose stage delegated its work to a
    // run/workflow, legitimately has no live agent. "No agent" is a state, not a
    // failure — and the reasons are worth naming so the agent does not retry.
    const { call } = jobsHarness([])
    const next = String((await call('stop_flight_agent', { flightId: 'fl-1', confirm: true })).next)
    expect(next).toContain('no live agent')
    expect(next).toContain('pause_flight')
  })

  it('reports nothing stopped when the agent finished mid-call', async () => {
    // The read said running, the stop found it gone. Racy by nature; the result
    // must not claim a stop that did not happen.
    const { call } = jobsHarness([{ jobId: 'fl-1:scout', status: 'running' }], 200)
    const out = await call('stop_flight_agent', { flightId: 'fl-1', confirm: true })
    expect(out.stopped).toEqual([])
    expect(String(out.next)).toContain('finished on their own')
  })

  it('stops BOTH halves when a stage has two live agents', async () => {
    // specs-coverage runs an author and a mapper under two records.
    const { call, requests } = jobsHarness([
      { jobId: 'fl-1:specs-coverage', status: 'running', stage: 'specs-coverage' },
      { jobId: 'fl-1:coverage-map', status: 'running', stage: 'coverage-map' },
    ])
    const out = await call('stop_flight_agent', { flightId: 'fl-1', confirm: true })
    expect((out.stopped as unknown[])).toHaveLength(2)
    expect(requests.filter((r) => r.url.endsWith('/stop'))).toHaveLength(2)
  })

  it('surfaces a failed job read instead of guessing', async () => {
    const handlers = new Map<string, Handler>()
    const ctx = {
      registerTool: ((name: string, _c: unknown, handler: Handler) => { handlers.set(name, handler) }) as unknown as ToolGroupContext['registerTool'],
      deps: { flightsRequest: async () => ({ statusCode: 500, body: {} }) } as unknown as ToolGroupContext['deps'],
      clientFacts: () => ({ kind: 'other' as const, name: 'test', canFanOut: false }),
      clientKindInput: CLIENT_KIND.default('other'),
    } as unknown as ToolGroupContext
    registerFlightTools(ctx)
    const res = await handlers.get('stop_flight_agent')!({ flightId: 'fl-1', confirm: true })
    expect(res.content?.[0]?.text ?? '').toContain("could not read this flight's agent jobs")
  })
})

describe('get_flight — the current stage\'s agent', () => {
  it('carries a live agent record so a client knows it could be stopped', async () => {
    const handlers = new Map<string, Handler>()
    const ctx = {
      registerTool: ((name: string, _c: unknown, handler: Handler) => { handlers.set(name, handler) }) as unknown as ToolGroupContext['registerTool'],
      deps: {
        flightsRequest: async (req: { url: string }) => {
          if (req.url.startsWith('/api/agent-jobs?')) {
            return { statusCode: 200, body: { jobs: [{ jobId: 'fl-1:scout', status: 'running', stage: 'scout' }] } }
          }
          return { statusCode: 200, body: { flightId: 'fl-1', feature: 'checkout', status: 'running', currentStage: 'scout', stages: [] } }
        },
      } as unknown as ToolGroupContext['deps'],
      clientFacts: () => ({ kind: 'other' as const, name: 'test', canFanOut: false }),
      clientKindInput: CLIENT_KIND.default('other'),
    } as unknown as ToolGroupContext
    registerFlightTools(ctx)
    const out = JSON.parse((await handlers.get('get_flight')!({ flightId: 'fl-1' })).content?.[0]?.text ?? '{}')
    expect(out.agentJob).toEqual({ jobId: 'fl-1:scout', status: 'running', stage: 'scout' })
  })

  it('never lets a failed agent-jobs read break the flight view', async () => {
    const handlers = new Map<string, Handler>()
    const ctx = {
      registerTool: ((name: string, _c: unknown, handler: Handler) => { handlers.set(name, handler) }) as unknown as ToolGroupContext['registerTool'],
      deps: {
        flightsRequest: async (req: { url: string }) => {
          if (req.url.startsWith('/api/agent-jobs?')) throw new Error('store on fire')
          return { statusCode: 200, body: { flightId: 'fl-1', feature: 'checkout', status: 'running', currentStage: 'scout', stages: [] } }
        },
      } as unknown as ToolGroupContext['deps'],
      clientFacts: () => ({ kind: 'other' as const, name: 'test', canFanOut: false }),
      clientKindInput: CLIENT_KIND.default('other'),
    } as unknown as ToolGroupContext
    registerFlightTools(ctx)
    const out = JSON.parse((await handlers.get('get_flight')!({ flightId: 'fl-1' })).content?.[0]?.text ?? '{}')
    // Bookkeeping must never sink the read the agent actually needs.
    expect(out.status).toBe('running')
    expect(out.agentJob).toBeUndefined()
  })
})
