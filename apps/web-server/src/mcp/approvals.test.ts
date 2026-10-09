import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import Fastify from 'fastify'
import { inputRequired, type InputRequiredResult, type ServerContext } from '@modelcontextprotocol/server'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { ApprovalStore } from './approval-store'
import { withApprovals } from './approval-context'
import { approvalContext } from './approval-context'
import { registerApprovalRoutes } from './approval-routes'
import { requestUserInput } from './elicitation'
import { asJsonResult, errorResult } from './tool-support'
import type { CanaryLabMcpDeps } from './tool-schemas'
import { registerApprovalTools } from './tool-groups/approvals'
import { captureTools } from './tool-groups/__fixtures__/tool-group-harness'

const temp = trackTempDirs('approvals-')
const context = (state?: unknown, answer?: unknown) => ({ sessionId: 'client-1', mcpReq: { requestState: () => state, inputResponses: { answer } } }) as unknown as ServerContext
const facts = { surface: 'other' as const, canFanOut: false, sampling: false, elicitation: { form: true, url: false } }
function setup(supportsForm = true) {
  const logsDir = temp(); const events = { publish: vi.fn() }; const store = new ApprovalStore(logsDir, events)
  let revision = 'one'
  const apply = vi.fn(async (answer: { choice: string }) => asJsonResult({ chosen: answer.choice }))
  const invoke = withApprovals('start_run', async (_args, request) => requestUserInput(request, { ...facts, elicitation: { form: supportsForm, url: false } }, {
    scope: ['fixture', logsDir], revision, mode: 'form', schema: z.object({ choice: z.enum(['Update coverage first', 'Run now with stale coverage']) }),
    message: 'Coverage is stale. Choose what to do.', fallback: () => asJsonResult({ oldFallback: true }),
  }, apply), { approvals: store, getUiUrl: () => 'http://localhost:1234' } as CanaryLabMcpDeps)
  return { logsDir, store, events, apply, invoke, change: () => { revision = 'two' } }
}
afterEach(() => vi.useRealTimers())

describe('shared browser and MCP approvals', () => {
  it('preserves tools without browser support and reuses the dedicated test-review flow', async () => {
    const handler = vi.fn(async () => asJsonResult({ ok: true }))
    const h = setup()
    expect(withApprovals('start_run', handler, {} as CanaryLabMcpDeps)).toBe(handler)
    expect(withApprovals('review_test_changes', handler, { approvals: h.store } as CanaryLabMcpDeps)).toBe(handler)
    for (const getUiUrl of [undefined, () => undefined]) {
      await withApprovals('start_run', handler, { approvals: h.store, getUiUrl } as CanaryLabMcpDeps)({}, context())
    }
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('associates run and portify decisions with their owning feature', async () => {
    const h = setup()
    const handler = async () => asJsonResult({ feature: approvalContext.getStore()?.feature })
    const invoke = withApprovals('fixture', handler, { approvals: h.store, getUiUrl: () => 'http://localhost',
      store: { get: (id: string) => id === 'run' ? { manifest: { feature: 'run-feature' } } : undefined },
      getPortify: (id: string) => id === 'portify' ? { feature: 'portify-feature' } : undefined,
    } as unknown as CanaryLabMcpDeps)
    expect(JSON.stringify(await invoke({ runId: 'run' }, context()))).toContain('run-feature')
    expect(JSON.stringify(await invoke({ workflowId: 'portify' }, context()))).toContain('portify-feature')
    expect(await invoke({ runId: 'missing' }, context())).toEqual(asJsonResult({}))
    expect(await invoke({ workflowId: 'missing' }, context())).toEqual(asJsonResult({}))
  })
  it('publishes one durable decision with a browser link in the native form and settles both on a browser answer', async () => {
    const h = setup()
    const form = await h.invoke({ feature: 'shop' }, context()) as InputRequiredResult
    const id = String(form.requestState)
    expect(JSON.stringify(form)).toContain(`dialog=notifications&approval=${id}`)
    expect(h.store.list()).toMatchObject([{ id, feature: 'shop', command: 'start_run', status: 'pending' }])
    const wait = h.store.wait(id, 30_000)
    await h.store.answer(id, { choice: 'Run now with stale coverage' })
    expect(await wait).toEqual(asJsonResult({ chosen: 'Run now with stale coverage' }))
    // A still-visible native form cannot override the browser's first answer.
    expect(await h.invoke({ feature: 'shop' }, context(id, { action: 'accept', content: { choice: 'Update coverage first' } })))
      .toEqual(asJsonResult({ chosen: 'Run now with stale coverage' }))
    expect(h.apply).toHaveBeenCalledTimes(1)
    expect(h.store.list()[0]).toMatchObject({ status: 'answered', answer: { choice: 'Run now with stale coverage' } })
    expect(h.events.publish).toHaveBeenCalledWith({ type: 'approvals-changed' })
  })

  it('deduplicates native retries and broadcasts a native decision to the browser', async () => {
    const h = setup(); const args = { feature: 'shop' }
    const first = await h.invoke(args, context()) as InputRequiredResult
    const second = await h.invoke(args, context()) as InputRequiredResult
    expect(first.requestState).toBe(second.requestState)
    await h.invoke(args, context(first.requestState, { action: 'accept', content: { choice: 'Update coverage first' } }))
    expect(h.store.list()[0].status).toBe('answered')
    await h.store.answer(String(first.requestState), { choice: 'Run now with stale coverage' })
    expect(h.apply).toHaveBeenCalledTimes(1)
  })

  it('creates a browser fallback without form support, including after native decline', async () => {
    const h = setup(false)
    expect(JSON.stringify(await h.invoke({ feature: 'shop' }, context()))).toContain('wait_for_approval')
    const id = h.store.list()[0].id
    await h.store.answer(id, { choice: 'Update coverage first' })
    expect(h.apply).toHaveBeenCalledTimes(1)
    const native = setup()
    const form = await native.invoke({}, context()) as InputRequiredResult
    const declined = await native.invoke({}, context(form.requestState, { action: 'decline' }))
    expect(JSON.stringify(declined)).toContain('reviewUrl')
    expect(native.store.list()[0].status).toBe('pending')
    await native.store.answer(String(form.requestState), { choice: 'Update coverage first' })
    expect(native.apply).toHaveBeenCalledTimes(1)
  })

  it('validates answers and rejects stale revisions without mutating the domain', async () => {
    const h = setup(); const form = await h.invoke({}, context()) as InputRequiredResult
    const id = String(form.requestState)
    await h.store.answer(id, { choice: 'made up' })
    expect(h.store.list()[0]).toMatchObject({ status: 'pending', error: expect.stringContaining('valid answer') })
    expect(h.apply).not.toHaveBeenCalled()
    h.change()
    await h.store.answer(id, { choice: 'Update coverage first' })
    expect(h.store.list()[0].status).toBe('expired')
    expect(h.apply).not.toHaveBeenCalled()
    expect(JSON.stringify(await h.store.wait(id, 0))).toContain('expired')
  })

  it('records failed execution without rerunning a side effect on retries', async () => {
    const h = setup(); h.apply.mockRejectedValue(new Error('domain unavailable'))
    const form = await h.invoke({}, context()) as InputRequiredResult
    await expect(h.store.answer(String(form.requestState), { choice: 'Update coverage first' })).rejects.toThrow('domain unavailable')
    expect(h.store.list()[0]).toMatchObject({ status: 'failed', error: 'domain unavailable' })
    await expect(h.store.answer(String(form.requestState), { choice: 'Update coverage first' })).rejects.toThrow('domain unavailable')
    expect(h.apply).toHaveBeenCalledTimes(1)
  })

  it('expires unanswered requests on time and restart while retaining completed receipts', async () => {
    vi.useFakeTimers()
    const h = setup(); await h.invoke({}, context())
    vi.advanceTimersByTime(31 * 60_000)
    expect(h.store.list()[0].status).toBe('expired')
    const live = setup(); await live.invoke({}, context())
    const restored = new ApprovalStore(live.logsDir)
    expect(restored.list()[0]).toMatchObject({ status: 'expired', error: expect.stringContaining('restarted') })
    await expect(restored.answer(restored.list()[0].id, { choice: 'Update coverage first' })).rejects.toThrow('restarted')
    expect(live.apply).not.toHaveBeenCalled()
    const done = setup(); await done.invoke({}, context()); const id = done.store.list()[0].id
    await done.store.answer(id, { choice: 'Update coverage first' })
    const receipts = new ApprovalStore(done.logsDir)
    expect(await receipts.wait(id, 0)).toEqual(asJsonResult({ chosen: 'Update coverage first' }))
    expect(await receipts.answer(id, { choice: 'Run now with stale coverage' })).toMatchObject({ status: 'answered' })
  })

  it('settles only once when the native answer arrives during browser execution', async () => {
    const h = setup()
    let finish!: () => void
    h.apply.mockImplementation(async () => { await new Promise<void>((resolve) => { finish = resolve }); return asJsonResult({ chosen: 'browser' }) })
    const form = await h.invoke({}, context()) as InputRequiredResult
    const id = String(form.requestState)
    const browser = h.store.answer(id, { choice: 'Update coverage first' })
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledOnce())
    const native = h.invoke({}, context(id, { action: 'accept', content: { choice: 'Run now with stale coverage' } }))
    finish()
    await browser
    expect(await native).toEqual(asJsonResult({ chosen: 'browser' }))
    expect(h.apply).toHaveBeenCalledOnce()
  })

  it('retires a question when a domain guard stops its replay before reaching elicitation', async () => {
    const h = setup(); let changed = false
    const invoke = withApprovals('start_run', (args, ctx) => changed ? Promise.resolve(asJsonResult({ status: 'needs-input', reason: 'work changed' })) : h.invoke(args, ctx),
      { approvals: h.store, getUiUrl: () => 'http://localhost:1234' } as CanaryLabMcpDeps)
    const form = await invoke({}, context()) as InputRequiredResult
    changed = true
    await invoke({}, context(form.requestState, { action: 'accept', content: { choice: 'Update coverage first' } }))
    expect(h.store.list()[0].status).toBe('expired')
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('keeps a failed tool receipt and refuses answers while another answer is running', async () => {
    const h = setup(); h.apply.mockResolvedValue(errorResult('Cannot apply'))
    await h.invoke({}, context()); const id = h.store.list()[0].id
    h.store.update(id, { status: 'answering' })
    await expect(h.store.answer(id, {})).rejects.toThrow('no longer pending')
    expect(JSON.stringify(await h.invoke({}, context(id, { action: 'accept', content: {} })))).toContain('no longer pending')
    h.store.update(id, { status: 'pending' })
    await h.store.answer(id, { choice: 'Update coverage first' })
    expect(await h.store.wait(id, 0)).toEqual(errorResult('Cannot apply'))
    expect(h.store.list()[0].status).toBe('failed')
  })

  it('bounds read-only waits and reports unknown ids without adding authority', async () => {
    vi.useFakeTimers()
    const h = setup(); await h.invoke({}, context()); const id = h.store.list()[0].id
    const wait = h.store.wait(id, 99_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(JSON.stringify(await wait)).toContain('still_waiting')
    expect(vi.getTimerCount()).toBe(0)
    expect(await h.store.wait('unknown', 0)).toMatchObject({ isError: true })
    await expect(h.store.answer('unknown', {})).rejects.toThrow('not found')
    h.store.update('unknown', { status: 'expired' })
    expect(h.store.list()).toHaveLength(1)
  })

  it('expires an unanswered approval on its own clock and tells open views', async () => {
    vi.useFakeTimers()
    const h = setup(); await h.invoke({}, context()); const [{ id }] = h.store.list()
    h.events.publish.mockClear()
    const stop = h.store.startExpiry()
    // The last tick before the 30-minute deadline leaves it pending; the next one expires it.
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1)
    expect(h.store.get(id)?.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.store.get(id)).toMatchObject({ status: 'expired', error: expect.stringContaining('expired') })
    expect(h.events.publish).toHaveBeenCalledWith({ type: 'approvals-changed' })
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a wait open through another approval\'s change and settles on its own answer', async () => {
    const h = setup(); await h.invoke({}, context()); const [own] = h.store.list()
    let settled = false
    const wait = h.store.wait(own.id, 30_000).then((result) => { settled = true; return result })
    h.store.open({ ...own, id: '00000000-0000-4000-8000-000000000000' }, async () => asJsonResult({}))
    await vi.waitFor(() => expect(h.store.list()).toHaveLength(2))
    expect(settled).toBe(false)
    await h.store.answer(own.id, { choice: 'Update coverage first' })
    expect(await wait).toEqual(asJsonResult({ chosen: 'Update coverage first' }))
  })

  it('serves wait_for_approval from the shared store and refuses it on a server without one', async () => {
    const h = setup(); await h.invoke({}, context()); const [{ id }] = h.store.list()
    await h.store.answer(id, { choice: 'Run now with stale coverage' })
    const args = { approvalId: id, timeout_ms: 0 }
    expect(await captureTools(registerApprovalTools, { approvals: h.store }).raw('wait_for_approval', args))
      .toEqual(asJsonResult({ chosen: 'Run now with stale coverage' }))
    expect(await captureTools(registerApprovalTools, {}).raw('wait_for_approval', args))
      .toEqual(errorResult('Browser approvals are unavailable on this server.'))
  })

  it.each(['url-state', undefined])('hands later domain-owned browser checkpoints back to the original command (%j)', async (requestState) => {
    const h = setup(); await h.invoke({}, context()); const id = h.store.list()[0].id
    h.store.update(id, { status: 'answered', result: inputRequired({ requestState,
      inputRequests: { answer: inputRequired.elicitUrl({ message: 'Import documents', url: 'http://localhost/docs' }) },
    }) })
    const result = await h.store.wait(id, 0)
    expect(JSON.stringify(result)).toContain('http://localhost/docs')
    expect(JSON.stringify(result)).toContain('resume the original command')
    expect('requestState' in result).toBe(false)
  })

  it('allows same-origin browser answers but refuses cross-origin posts and malformed payloads', async () => {
    const h = setup(); await h.invoke({}, context()); const id = h.store.list()[0].id
    const app = Fastify(); registerApprovalRoutes(app, h.store)
    try {
      expect((await app.inject('/api/approvals')).json()).toHaveLength(1)
      const url = `/api/approvals/${id}/answer`
      for (const headers of [{}, { origin: 'https://attacker.test' }, { origin: 'http://localhost', 'sec-fetch-site': 'cross-site' }]) {
        expect((await app.inject({ method: 'POST', url, headers, payload: { answer: { choice: 'Update coverage first' } } })).statusCode).toBe(403)
      }
      expect((await app.inject({ method: 'POST', url, headers: { origin: 'http://localhost' }, payload: {} })).statusCode).toBe(400)
      expect(h.apply).not.toHaveBeenCalled()
      expect((await app.inject({ method: 'POST', url, headers: { origin: 'http://localhost' }, payload: { answer: { choice: 'Update coverage first' } } })).json()).toMatchObject({ status: 'answered' })
    } finally { await app.close() }
  })
})
