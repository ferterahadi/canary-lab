import { describe, expect, it } from 'vitest'
import type { RobustnessJobManifest } from '../../../../../shared/robustness/jobs'
import { jobNextSteps, registerRobustnessTools } from './robustness'
import { captureTools } from './__fixtures__/tool-group-harness'

// The two Robustness Lab tools are thin over the REST routes; what they add is
// (1) the request they build, (2) a slim result — no driver log, no per-probe
// trace unless asked — and (3) `nextSteps` that send a finding to the repair
// loop. Those three are what the tests pin; admission lives in the route tests.

const FORMAT = 'canary-lab/robustness-envelope@1' as const

function job(over: Partial<RobustnessJobManifest> = {}): RobustnessJobManifest {
  return {
    jobId: 'rj-1',
    feature: 'checkout',
    runId: 'run-9',
    envelope: { format: FORMAT, latency: { ms: 250 } },
    status: 'done',
    startedAt: '2026-09-10T00:00:00Z',
    endedAt: '2026-09-10T00:10:00Z',
    cells: { planned: 4, done: 4 },
    findings: [],
    skipped: [],
    log: 'cell e2e/a.spec.ts latency: clean (run r1)\n',
    ...over,
  }
}

const confirmed = {
  cell: { specFile: 'e2e/checkout.spec.ts', atom: 'latency' as const },
  failedTests: ['pays with a saved card'],
  runId: 'run-cell',
  requirements: ['@req-pay-1'],
  status: 'confirmed' as const,
  envelope: { format: FORMAT, latency: { ms: 250 } },
  shrink: {
    status: 'confirmed' as const,
    envelope: { format: FORMAT, latency: { ms: 125 } },
    probes: 3,
    budgetExhausted: false,
    confirmations: { asked: 3, reproduced: 3 },
    steps: [{ probe: 0, envelope: { format: FORMAT, latency: { ms: 250 } }, reproduced: true, why: 'check' }],
    repro: 'latency 125 ms',
  },
  repro: 'latency 125 ms',
}

function harness(responses: Array<{ statusCode: number; body: unknown }> | null) {
  const requests: Array<{ method: string; url: string; payload?: unknown }> = []
  const queue = responses ? [...responses] : null
  const tools = captureTools(registerRobustnessTools, queue
    ? {
        robustnessRequest: async (o: { method: string; url: string; payload?: unknown }) => {
          requests.push(o)
          return queue.shift()!
        },
      }
    : {})
  return { ...tools, requests }
}

describe('start_robustness', () => {
  it('posts to the suite\'s robustness route with only the fields given, and returns the slim record with the poll advice', async () => {
    const { call, requests } = harness([{ statusCode: 202, body: job({ status: 'running', cells: { planned: 4, done: 0 } }) }])
    const result = await call('start_robustness', { feature: 'check out' })
    expect(requests).toEqual([{ method: 'POST', url: '/api/features/check%20out/robustness', payload: {} }])
    expect(result.jobId).toBe('rj-1')
    expect(result.log).toBeUndefined()
    expect(result.nextSteps).toEqual([expect.stringContaining('poll get_robustness(jobId) again in ~30 s')])
  })

  it('forwards runId and the envelope raw — the route is the validator', async () => {
    const { call, requests } = harness([{ statusCode: 202, body: job({ status: 'running' }) }])
    await call('start_robustness', { feature: 'checkout', runId: 'run-3', envelope: { format: FORMAT, latency: { ms: 50 } } })
    expect(requests[0]?.payload).toEqual({ runId: 'run-3', envelope: { format: FORMAT, latency: { ms: 50 } } })
  })

  it('relays the route\'s refusal with its status and reason, pointing at the running job on a conflict', async () => {
    const { text } = harness([
      { statusCode: 409, body: { error: 'a matrix is already running for checkout', jobId: 'rj-live' } },
      { statusCode: 400, body: { error: 'this suite starts no services, so there is nothing to perturb' } },
      { statusCode: 500, body: 'boom' },
    ])
    expect(await text('start_robustness', { feature: 'checkout' })).toBe('start_robustness failed (409): a matrix is already running for checkout — read it with get_robustness(jobId:"rj-live")')
    expect(await text('start_robustness', { feature: 'checkout' })).toBe('start_robustness failed (400): this suite starts no services, so there is nothing to perturb')
    expect(await text('start_robustness', { feature: 'checkout' })).toBe('start_robustness failed (500): "boom"')
  })

  it('says so when the server has no robustness routes wired', async () => {
    const { text } = harness(null)
    expect(await text('start_robustness', { feature: 'checkout' })).toBe('Robustness Lab is unavailable on this server')
    expect(await text('get_robustness', { jobId: 'rj-1' })).toBe('Robustness Lab is unavailable on this server')
    expect(await text('get_robustness', { feature: 'checkout' })).toBe('Robustness Lab is unavailable on this server')
  })
})

describe('get_robustness', () => {
  it('reads a job slim — no log, no shrink steps — and sends a confirmed finding to the repair loop', async () => {
    const { call, requests } = harness([{ statusCode: 200, body: job({ findings: [confirmed] }) }])
    const result = await call('get_robustness', { jobId: 'rj/1', includeLog: false, includeTrace: false })
    expect(requests).toEqual([{ method: 'GET', url: '/api/robustness/rj%2F1', payload: undefined }])
    expect(result.log).toBeUndefined()
    const [finding] = result.findings as Array<{ shrink: { steps: unknown[]; repro: string; envelope: unknown } }>
    expect(finding?.shrink.steps).toEqual([])
    expect(finding?.shrink.repro).toBe('latency 125 ms')
    expect(finding?.shrink.envelope).toEqual({ format: FORMAT, latency: { ms: 125 } })
    expect(result.nextSteps).toEqual([expect.stringContaining('start_run(feature, perturbation: finding.shrink.envelope ?? finding.envelope')])
  })

  it('inlines the log and the trace on request', async () => {
    const { call } = harness([{ statusCode: 200, body: job({ findings: [confirmed] }) }])
    const result = await call('get_robustness', { jobId: 'rj-1', includeLog: true, includeTrace: true })
    expect(result.log).toBe('cell e2e/a.spec.ts latency: clean (run r1)\n')
    const [finding] = result.findings as Array<{ shrink: { steps: unknown[] } }>
    expect(finding?.shrink.steps).toHaveLength(1)
  })

  it('leaves a finding without a shrink record untouched', async () => {
    const { call } = harness([{ statusCode: 200, body: job({ status: 'running', findings: [{ ...confirmed, status: 'found', shrink: undefined, repro: undefined }] }) }])
    const result = await call('get_robustness', { jobId: 'rj-1', includeLog: false, includeTrace: false })
    const [finding] = result.findings as Array<{ status: string; shrink?: unknown }>
    expect(finding?.status).toBe('found')
    expect(finding?.shrink).toBeUndefined()
  })

  it('names a job it could not find', async () => {
    const { text } = harness([{ statusCode: 404, body: { error: 'robustness job not found' } }])
    expect(await text('get_robustness', { jobId: 'rj-x', includeLog: false, includeTrace: false })).toBe('robustness job not found: rj-x')
  })

  it('lists a suite\'s jobs when only the feature is given, and says how to start one when there are none', async () => {
    const rows = [{ jobId: 'rj-2', feature: 'checkout', runId: 'run-9', status: 'done', startedAt: 't', findings: 1 }]
    const { call, requests } = harness([{ statusCode: 200, body: rows }, { statusCode: 200, body: [] }])
    const listed = await call('get_robustness', { feature: 'checkout', includeLog: false, includeTrace: false })
    expect(requests[0]?.url).toBe('/api/features/checkout/robustness')
    expect(listed).toEqual({ feature: 'checkout', jobs: rows })
    const empty = await call('get_robustness', { feature: 'checkout', includeLog: false, includeTrace: false })
    expect(empty.nextSteps).toEqual([expect.stringContaining('start_robustness(feature)')])
  })

  it('asks for jobId or feature when given neither', async () => {
    const { text } = harness([])
    expect(await text('get_robustness', { includeLog: false, includeTrace: false })).toBe('Provide jobId or feature')
  })
})

describe('jobNextSteps — what a settled job tells the agent to do', () => {
  it('a clean, complete matrix has nothing to repair', () => {
    expect(jobNextSteps(job())).toEqual(['no finding: every cell held under the envelope — nothing to repair'])
  })

  it('confirmed findings send to repair; unconfirmed and skipped are named as neither defects nor passes', () => {
    const steps = jobNextSteps(job({
      findings: [confirmed, { ...confirmed, cell: { specFile: 'e2e/b.spec.ts', atom: 'duplicate' }, status: 'unconfirmed' }],
      skipped: [{ cell: { specFile: 'e2e/c.spec.ts', atom: 'restart' }, reason: 'service failed to boot', runId: 'run-c' }],
    }))
    expect(steps).toHaveLength(3)
    expect(steps[0]).toContain('for each confirmed finding call start_run')
    expect(steps[1]).toBe('1 finding(s) are unconfirmed — the shrunk envelope did not reproduce 3/3; report them as unconfirmed, never as defects and never as passes')
    expect(steps[2]).toBe('1 cell(s) could not be judged (skipped[].reason) — a skipped cell is not a pass')
  })

  it('a stopped matrix says what stands and how to run a fresh one, with the error when there is one', () => {
    expect(jobNextSteps(job({ status: 'aborted', cells: { planned: 4, done: 2 } }))).toEqual([
      'the matrix ended aborted: findings so far stand, nothing after them was judged — start_robustness(feature) runs a fresh matrix',
    ])
    expect(jobNextSteps(job({ status: 'failed', error: 'cell could not start' }))).toEqual([
      'the matrix ended failed (cell could not start): findings so far stand, nothing after them was judged — start_robustness(feature) runs a fresh matrix',
    ])
  })
})
