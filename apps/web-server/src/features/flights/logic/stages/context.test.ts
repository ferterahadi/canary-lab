import { describe, expect, it } from 'vitest'
import path from 'path'
import {
  PollTimeoutError,
  StageCancelledError,
  decodeSubmission,
  extractJson,
  featureDirFor,
  pollUntil,
  stageFeedback,
  stageJobRef,
  stageModelPlan,
  stageModels,
} from './context'
import type { FlightStageDeps } from './context'

function deps(over: Partial<FlightStageDeps> = {}): FlightStageDeps {
  return {
    featuresDir: '/tmp/flight-features',
    logsDir: '/tmp/flight-logs',
    projectRoot: '/tmp/flight-project',
    inject: async () => ({ statusCode: 200, json: () => ({}) }),
    ...over,
  }
}

describe('flight stage context helpers', () => {
  it('extracts structured answers and preserves non-JSON checkpoint submissions', () => {
    expect(extractJson<{ approved: boolean }>('Here is the answer:\n```json\n{"approved":true}\n```')).toEqual({ approved: true })
    expect(decodeSubmission('{"requirements":["R1"]}')).toEqual({ ok: true, data: { requirements: ['R1'] } })
    expect(decodeSubmission('human feedback stays text')).toEqual({ ok: false, error: 'the submission was not parseable JSON' })
    expect(decodeSubmission({ freeform: true })).toEqual({ ok: true, data: { freeform: true } })
  })

  it('reports an actionable extract failure when the agent answer contains no JSON', () => {
    expect(() => extractJson('I could not produce an object')).toThrow('agent did not return parseable JSON')
  })

  it('settles immediately, rejects aborted work, and labels timeout type accurately', async () => {
    await expect(pollUntil(async () => 'done', (value) => value === 'done', {
      what: 'coverage mapping', timeoutMs: 10,
    })).resolves.toBe('done')

    const controller = new AbortController()
    controller.abort()
    await expect(pollUntil(async () => 'pending', () => false, {
      what: 'coverage mapping', timeoutMs: 10, signal: controller.signal,
    })).rejects.toEqual(expect.objectContaining({ name: 'StageCancelledError' }))

    await expect(pollUntil(async () => 'pending', () => false, {
      what: 'coverage mapping', timeoutMs: 0,
    })).rejects.toEqual(expect.objectContaining({ name: 'PollTimeoutError', message: 'coverage mapping did not settle within 0s' }))
    await expect(pollUntil(async () => 'pending', () => false, {
      what: 'coverage mapping', timeoutMs: 0, progressKey: (value) => value,
    })).rejects.toEqual(expect.objectContaining({ name: 'PollTimeoutError', message: 'coverage mapping made no progress within 0s' }))
  })

  it('keeps the stage model choice with its conducting agent and does not leak feedback', () => {
    const model = { model: 'gpt-5.6-sol', effort: 'high' } as const
    const manifest = { opts: { agent: 'codex' as const, models: { gen: model } }, feedback: { stage: 'specs-coverage', note: 'cover the retry path' } }

    expect(stageModels(manifest, 'gen')).toEqual(model)
    expect(stageModels(manifest, 'mapping')).toBeUndefined()
    expect(stageModelPlan(manifest, 'gen')).toEqual({ codex: model })
    expect(stageModelPlan({ opts: { models: { gen: model } } }, 'gen')).toEqual({ claude: model })
    expect(stageFeedback(manifest, 'specs-coverage')).toBe('cover the retry path')
    expect(stageFeedback(manifest, 'docs')).toBeUndefined()
  })

  it('builds stable job records and falls back to the pre-scaffold feature directory', () => {
    const stageDeps = deps()
    expect(stageJobRef(stageDeps, { flightId: 'fl_123', feature: 'checkout' }, 'coverage-map')).toEqual({
      flightId: 'fl_123', feature: 'checkout', stage: 'coverage-map', logsDir: '/tmp/flight-logs',
    })
    expect(featureDirFor(stageDeps, 'checkout')).toBe(path.join('/tmp/flight-features', 'checkout'))
  })

  it('formats cancellation and both timeout forms for the stage log', () => {
    expect(new StageCancelledError('agent spawn')).toMatchObject({
      name: 'StageCancelledError', message: 'agent spawn cancelled by flight pause/abort',
    })
    expect(new PollTimeoutError('portify', 65_000)).toMatchObject({ message: 'portify did not settle within 65s' })
    expect(new PollTimeoutError('portify', 65_000, { idle: true })).toMatchObject({ message: 'portify made no progress within 65s' })
  })
})
