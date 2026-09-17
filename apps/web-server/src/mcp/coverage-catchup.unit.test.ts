import { afterEach, describe, expect, it, vi } from 'vitest'
import { withCoverageCatchup } from './coverage-catchup'
import type { CanaryLabMcpDeps, CanaryLabToolHandler } from './tool-schemas'
import { coverageJobStore } from '../features/coverage/logic/coverage/jobs/store'
import { registerCoverageChangeTools } from './tool-groups/coverage-changes'
import { captureTools } from './tool-groups/__fixtures__/tool-group-harness'

afterEach(() => vi.restoreAllMocks())
const context = {} as Parameters<CanaryLabToolHandler>[1]
const json = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] })
const read = vi.fn(async () => ({ statusCode: 200, body: { changed: true, change: { feature: 'shop' } } }))
function deps(extra: Record<string, unknown> = {}) {
  return { coverageRequest: read, store: { logsDir: '/nonexistent-coverage-unit', get: (id: string) => id === 'run' ? { manifest: { feature: 'shop' } } : null }, ...extra } as unknown as CanaryLabMcpDeps
}

describe('suite-scoped tool catch-up', () => {
  it('does not wrap unsupported servers or recursively wrap the wait tool', () => {
    const handler: CanaryLabToolHandler = () => json({})
    expect(withCoverageCatchup('get_run', handler, deps({ coverageRequest: undefined }))).toBe(handler)
    expect(withCoverageCatchup('wait_for_feature_change', handler, deps())).toBe(handler)
  })

  it.each([
    { args: { featureId: 'shop' }, body: {} },
    { args: { runId: 'run' }, body: {} },
    { args: {}, body: { feature: 'shop' } },
    { args: {}, body: { manifest: { feature: 'shop' } } },
    { args: {}, body: { flight: { feature: 'shop' } } },
  ])('associates only the relevant suite from $args and $body', async ({ args, body }) => {
    const result = await withCoverageCatchup('read', () => json(body), deps())(args, context)
    expect(result).toMatchObject({ content: [json(body).content[0], { text: expect.stringContaining('coverageUpdate') }] })
    expect(read).toHaveBeenLastCalledWith({ method: 'GET', url: '/api/features/shop/coverage/changes?timeoutMs=0' })
  })

  it('resolves an active coverage job to its suite', async () => {
    vi.spyOn(coverageJobStore('/nonexistent-coverage-unit'), 'get').mockReturnValue({ feature: 'shop' } as never)
    expect(await withCoverageCatchup('read', () => json({}), deps())({ jobId: 'job' }, context))
      .toMatchObject({ content: [{ type: 'text' }, { text: expect.stringContaining('coverageUpdate') }] })
  })

  it.each([
    { content: [] },
    { content: [{ type: 'text', text: 'plain prose' }] },
    { content: [{ type: 'text', text: '{"feature":42}' }] },
    { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] },
    { content: 'invalid' },
    { resultType: 'input_required' },
  ])('preserves unrelated, malformed, and elicitation replies', async (result) => {
    expect(await withCoverageCatchup('read', () => result as never, deps())({ runId: 'missing', jobId: 'missing' }, context)).toEqual(result)
  })

  it.each([new Error('offline'), 'disconnected'])('reports unavailable after a read failure: %s', async (error) => {
    const result = await withCoverageCatchup('read', () => json({}), deps({ coverageRequest: async () => { throw error } }))({ feature: 'shop' }, context)
    expect(JSON.stringify(result)).toContain('unavailable')
  })

  it('preserves route errors as unavailable rather than claiming freshness', async () => {
    const result = await withCoverageCatchup('read', () => json({}), deps({ coverageRequest: async () => ({ statusCode: 503, body: { error: 'offline' } }) }))({ feature: 'shop' }, context)
    expect(JSON.stringify(result)).toContain('unavailable')
  })
})

describe('coverage change tool error surface', () => {
  it('names unsupported observation and route errors', async () => {
    expect(await captureTools(registerCoverageChangeTools, {}).text('wait_for_feature_change', { feature: 'shop' })).toContain('unavailable')
    const request = vi.fn(async () => ({ statusCode: 404, body: { error: 'feature not found' } }))
    expect(await captureTools(registerCoverageChangeTools, { coverageRequest: request }).text('wait_for_feature_change', { feature: 'shop', timeout_ms: 0, afterRevision: 'v1' })).toContain('feature not found')
    expect(await captureTools(registerCoverageChangeTools, { coverageRequest: request }).text('wait_for_feature_change', { feature: 'shop', timeout_ms: 0 })).toContain('feature not found')
  })
})
