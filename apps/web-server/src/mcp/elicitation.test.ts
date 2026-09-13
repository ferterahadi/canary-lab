import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ServerContext, InputRequiredResult } from '@modelcontextprotocol/server'
import { requestUserInput } from './elicitation'
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
    expect(JSON.stringify(result)).toContain('Do not repeat the question')
    expect(result).not.toHaveProperty('inputRequests')
    expect(apply).not.toHaveBeenCalled()
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
})
