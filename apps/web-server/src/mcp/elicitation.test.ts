import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ServerContext, InputRequiredResult } from '@modelcontextprotocol/server'
import { matchesUserInput, requestNextUserInput, requestUserInput } from './elicitation'
import { asJsonResult } from './tool-support'

const facts = { surface: 'other' as const, canFanOut: false, sampling: false, elicitation: { form: true, url: true } }
const context = (state?: unknown, answer?: unknown) => ({ sessionId: 'test', mcpReq: { requestState: () => state, inputResponses: { answer } } }) as unknown as ServerContext
const form = (scope: string, revision = 'v1') => ({ scope, revision, mode: 'form' as const, message: 'Choose isolation', schema: z.object({ isolation: z.enum(['worktree', 'queue']) }), fallback: () => asJsonResult({ fallback: true }) })

describe('MCP 2.0 elicitation', () => {
  it('returns input_required and applies a validated response only once, even on concurrent retries', async () => {
    const spec = form('once')
    const apply = vi.fn(async () => asJsonResult({ applied: true }))
    const opened = await requestUserInput(context(), facts, spec, apply) as InputRequiredResult
    expect(opened).toMatchObject({ resultType: 'input_required', inputRequests: { answer: { method: 'elicitation/create', params: { requestedSchema: { properties: { isolation: { enum: ['worktree', 'queue'] } } } } } } })
    expect(apply).not.toHaveBeenCalled()
    const accepted = context(opened.requestState, { action: 'accept', content: { isolation: 'queue' } })
    const results = await Promise.all([requestUserInput(accepted, facts, spec, apply), requestUserInput(accepted, facts, spec, apply)])
    expect(results[0]).toEqual(results[1])
    expect(apply).toHaveBeenCalledExactlyOnceWith({ isolation: 'queue' })
  })

  it.each(['decline', 'cancel'])('leaves %s pending without applying or reopening a question', async (action) => {
    const spec = form(action)
    const apply = vi.fn(async () => asJsonResult({ applied: true }))
    const opened = await requestUserInput(context(), facts, spec, apply) as InputRequiredResult
    const result = await requestUserInput(context(opened.requestState, { action }), facts, spec, apply)
    const text = JSON.stringify(result)
    expect(text).toContain('Do not repeat the question')
    expect(result).not.toHaveProperty('inputRequests')
    expect(apply).not.toHaveBeenCalled()
    // A client that declares elicitation but wires no handler declines by itself
    // (Claude Desktop's Code tab does exactly this). Canary sees the same payload
    // either way, so it must report the CLIENT's answer and never bank a decision
    // as the human's — for a test-review approval that would be a fabricated one.
    const { reason } = JSON.parse((result as { content: [{ text: string }] }).content[0].text)
    expect(reason).toContain(`The client answered "${action}"`)
    expect(reason).toMatch(/cannot tell whether a human saw this request/)
    expect(reason).not.toMatch(/the user chose|user declined|user cancelled|user canceled/i)
  })

  it('rejects malformed, forged, cross-operation, and stale responses before mutation', async () => {
    const spec = form('validation')
    const apply = vi.fn(async () => asJsonResult({ applied: true }))
    const opened = await requestUserInput(context(), facts, spec, apply) as InputRequiredResult
    const answer = { action: 'accept', content: { isolation: 'queue' } }
    for (const [state, input, current] of [
      ['forged', answer, spec],
      [opened.requestState, answer, form('different-operation')],
      [opened.requestState, answer, form('validation', 'v2')],
      [opened.requestState, { action: 'accept', content: { isolation: 'delete' } }, spec],
    ] as const) {
      const result = await requestUserInput(context(state, input), facts, current, apply)
      expect(result).not.toHaveProperty('inputRequests')
    }
    expect(apply).not.toHaveBeenCalled()
  })

  it('uses capability fallback and never sends URL requests to form-only clients', async () => {
    const fallback = vi.fn(() => asJsonResult({ fallback: true }))
    const apply = vi.fn(async () => asJsonResult({ applied: true }))
    await requestUserInput(context(), { ...facts, elicitation: { form: true, url: false } }, { scope: 'url', mode: 'url', message: 'Enter secrets in Canary', url: 'http://localhost:1234', fallback }, apply)
    await requestUserInput(undefined, facts, { ...form('disconnected'), fallback }, apply)
    expect(fallback).toHaveBeenCalledTimes(2)
    expect(apply).not.toHaveBeenCalled()
  })

  // The client picks the requestState value it echoes back, so a non-string is
  // reachable from the wire. It must read as an unknown handle rather than be
  // used to index the pending map.
  it('treats a non-string echoed handle as unknown', async () => {
    const apply = vi.fn(async () => asJsonResult({ applied: true }))
    const result = await requestUserInput(context(42, { action: 'accept', content: { isolation: 'queue' } }), facts, form('non-string'), apply)
    expect(JSON.stringify(result)).toContain('belongs to a different operation')
    expect(apply).not.toHaveBeenCalled()
  })

  // A peer that echoes a live handle but no parseable answer is a protocol
  // fault, not a user decision. Recording it as one would bank a decline
  // receipt and suppress the question for good, so it stays an error and the
  // handle stays answerable.
  it('reports a response that is not an elicitation answer as an error, without banking it', async () => {
    const spec = form('malformed-answer')
    const apply = vi.fn(async () => asJsonResult({ applied: true }))
    const opened = await requestUserInput(context(), facts, spec, apply) as InputRequiredResult
    for (const answer of [undefined, { action: 'approve' }, 'accept', { content: { isolation: 'queue' } }]) {
      const result = await requestUserInput(context(opened.requestState, answer), facts, spec, apply)
      expect(JSON.stringify(result)).toContain('Invalid elicitation response')
    }
    const accepted = await requestUserInput(context(opened.requestState, { action: 'accept', content: { isolation: 'queue' } }), facts, spec, apply)
    expect(JSON.stringify(accepted)).toContain('applied')
    expect(apply).toHaveBeenCalledExactlyOnceWith({ isolation: 'queue' })
  })

  it('expires input after restart/expiry instead of trusting echoed state', async () => {
    vi.useFakeTimers()
    try {
      const apply = vi.fn(async () => asJsonResult({ applied: true }))
      const spec = form('expiry')
      const opened = await requestUserInput(context(), facts, spec, apply) as InputRequiredResult
      vi.advanceTimersByTime(31 * 60 * 1000)
      await requestUserInput(context(opened.requestState, { action: 'accept', content: { isolation: 'queue' } }), facts, spec, apply)
      expect(apply).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes an echoed handle only to the question that opened it', async () => {
    const opened = await requestUserInput(context(), facts, form('coverage'), async () => asJsonResult({ applied: true })) as InputRequiredResult
    const resumed = context(opened.requestState, { action: 'accept', content: { isolation: 'queue' } })

    expect(matchesUserInput(resumed, 'coverage')).toBe(true)
    expect(matchesUserInput(resumed, 'repository-isolation')).toBe(false)
    expect(matchesUserInput(context('unknown-handle'), 'coverage')).toBe(false)
    expect(matchesUserInput(context(42), 'coverage')).toBe(false)
  })

  it('opens a second question while the first answer is being applied', async () => {
    const first = form('coverage')
    const second = form('repository-isolation')
    const opened = await requestUserInput(context(), facts, first, async () => asJsonResult({ unreachable: true })) as InputRequiredResult
    const resumed = context(opened.requestState, { action: 'accept', content: { isolation: 'queue' } })

    const next = requestNextUserInput(resumed, facts, second, async () => asJsonResult({ applied: true })) as InputRequiredResult

    expect(next).toMatchObject({ resultType: 'input_required' })
    expect(next.requestState).not.toBe(opened.requestState)
    expect(matchesUserInput(context(next.requestState), 'repository-isolation')).toBe(true)
  })

  // Open questions live in a process-wide map that only expiry and answers
  // drain, so an agent that opens them and walks away must be refused rather
  // than allowed to grow it without bound. Refusal leaves the work pending, so
  // nothing is lost — and this runs last because it fills that shared map.
  it('refuses a new question once the pending map is full, rather than growing it', async () => {
    const apply = vi.fn(async () => asJsonResult({ applied: true }))
    const spec = form('flood')
    let last = await requestUserInput(context(), facts, spec, apply)
    for (let opened = 1; opened < 1200 && 'inputRequests' in last; opened++) {
      last = await requestUserInput(context(), facts, spec, apply)
    }
    expect(JSON.stringify(last)).toContain('Too many open input requests')
    expect(apply).not.toHaveBeenCalled()
  })
})
