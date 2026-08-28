import { describe, it, expect } from 'vitest'
import type { AgentActivity } from '../types'
import type { StageContext } from '../flight-stages'
import { agentProgressSink } from './agent-progress'

const textDelta = (text: string) =>
  `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })}\n`

/** Records both channels so tests pin the transcript/manifest boundary. */
function recordingCtx() {
  const log: string[] = []
  const published: AgentActivity[] = []
  const ctx = {
    appendLog: (chunk: string) => { log.push(chunk) },
    setAgentActivity: (activity: AgentActivity) => { published.push(activity) },
  } as unknown as StageContext
  return { ctx, log, published }
}

describe('agentProgressSink', () => {
  it('publishes the first activity it can derive', () => {
    const { ctx, published } = recordingCtx()
    let clock = 1_000_000
    agentProgressSink(ctx, () => clock)(textDelta('hello'))
    expect(published).toEqual([{ phase: 'writing', thinkingTokens: 0, chars: 5, tail: 'hello' }])
  })

  it('does not copy raw CLI chunks into the Flight manifest while throttling activity', () => {
    const { ctx, log, published } = recordingCtx()
    let clock = 1_000_000
    const sink = agentProgressSink(ctx, () => clock)
    sink(textDelta('a'))
    clock += 200
    sink(textDelta('b'))
    clock += 200
    sink(textDelta('c'))
    expect(published).toHaveLength(1)
    expect(log).toEqual([])
  })

  it('publishes again once the window has passed, with the accumulated answer', () => {
    const { ctx, published } = recordingCtx()
    let clock = 1_000_000
    const sink = agentProgressSink(ctx, () => clock)
    sink(textDelta('one '))
    clock += 400
    sink(textDelta('two '))
    clock += 700
    sink(textDelta('three'))
    expect(published).toHaveLength(2)
    expect(published[1]).toEqual({ phase: 'writing', thinkingTokens: 0, chars: 13, tail: 'one two three' })
  })

  it('ignores a chunk that yields no activity', () => {
    const { ctx, log, published } = recordingCtx()
    let clock = 1_000_000
    agentProgressSink(ctx, () => clock)('[specs] plain adapter line, not stream-json\n')
    expect(log).toEqual([])
    expect(published).toEqual([])
  })

  it('uses the real clock when no clock is injected', () => {
    const { ctx, published } = recordingCtx()
    const sink = agentProgressSink(ctx)
    sink(textDelta('x'))
    // Back-to-back calls land inside the throttle window on any real clock, so
    // the default path is exercised and still rate-limits.
    sink(textDelta('y'))
    expect(published).toHaveLength(1)
  })
})
