import { describe, it, expect } from 'vitest'
import { createCompositionTracker } from './agent-stream-progress'

// Envelope builders mirroring the shapes recorded from a real claude
// `--include-partial-messages` run (flight fl_d0a98e795add's prd-summary stage).
// Keeping them as helpers means a CLI schema change is a one-line edit here.
const line = (o: unknown) => `${JSON.stringify(o)}\n`
const blockStart = (content_block: unknown) => line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block } })
const delta = (d: unknown) => line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: d } })
const textDelta = (text: string) => delta({ type: 'text_delta', text })
const sys = (o: Record<string, unknown>) => line({ type: 'system', ...o })

describe('createCompositionTracker', () => {
  it('reports the request phase the CLI announces before any content arrives', () => {
    const t = createCompositionTracker()
    // The tracker starts in `requesting`, so the CLI's own status line is not a
    // change — the first observable transition is the block that follows.
    expect(t.push(sys({ subtype: 'status', status: 'requesting' }))).toBeNull()
    expect(t.push(blockStart({ type: 'thinking', thinking: '' }))).toEqual({
      phase: 'thinking', thinkingTokens: 0, chars: 0, tail: '',
    })
    // A later turn's request phase IS a change, because thinking moved off it.
    expect(t.push(sys({ subtype: 'status', status: 'requesting' }))?.phase).toBe('requesting')
  })

  it('counts thinking tokens from the system line and ignores a repeat of the same total', () => {
    const t = createCompositionTracker()
    expect(t.push(sys({ subtype: 'thinking_tokens', estimated_tokens: 50 }))?.thinkingTokens).toBe(50)
    expect(t.push(sys({ subtype: 'thinking_tokens', estimated_tokens: 50 }))).toBeNull()
    expect(t.push(sys({ subtype: 'thinking_tokens', estimated_tokens: 900 }))?.thinkingTokens).toBe(900)
    expect(t.push(sys({ subtype: 'thinking_tokens', estimated_tokens: 'lots' }))).toBeNull()
  })

  it('takes the running token estimate off a thinking delta too', () => {
    const t = createCompositionTracker()
    expect(t.push(delta({ type: 'thinking_delta', thinking: 'hm', estimated_tokens: 120 }))).toEqual({
      phase: 'thinking', thinkingTokens: 120, chars: 0, tail: '',
    })
    // No estimate on the delta still counts as thinking; the total simply holds.
    expect(t.push(delta({ type: 'thinking_delta', thinking: 'more' }))?.thinkingTokens).toBe(120)
  })

  it('accumulates answer characters and keeps the tail as text streams', () => {
    const t = createCompositionTracker()
    t.push(blockStart({ type: 'text', text: '' }))
    t.push(textDelta('Hello'))
    expect(t.push(textDelta(' world'))).toEqual({
      phase: 'writing', thinkingTokens: 0, chars: 11, tail: 'Hello world',
    })
  })

  it('caps the tail at 240 characters while the character count keeps climbing', () => {
    const t = createCompositionTracker()
    t.push(blockStart({ type: 'text', text: '' }))
    t.push(textDelta('x'.repeat(300)))
    const snap = t.push(textDelta('END'))
    expect(snap?.chars).toBe(303)
    expect(snap?.tail).toHaveLength(240)
    // The tail is the END of the answer — what a reader wants to see arriving.
    expect(snap?.tail.endsWith('END')).toBe(true)
  })

  it('resets the answer counters when a new answer block starts', () => {
    const t = createCompositionTracker()
    t.push(blockStart({ type: 'text', text: '' }))
    t.push(textDelta('first answer'))
    expect(t.push(blockStart({ type: 'text', text: '' }))).toEqual({
      phase: 'writing', thinkingTokens: 0, chars: 0, tail: '',
    })
  })

  it('names the tool it is calling, and pairs the name with the phase', () => {
    const t = createCompositionTracker()
    const snap = t.push(blockStart({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }))
    expect(snap).toEqual({ phase: 'tool', thinkingTokens: 0, chars: 0, tail: '', tool: 'Read' })
  })

  it('ignores a tool block with no usable name rather than reporting a nameless call', () => {
    const t = createCompositionTracker()
    t.push(blockStart({ type: 'thinking', thinking: '' }))
    expect(t.push(blockStart({ type: 'tool_use', id: 'toolu_2', input: {} }))).toBeNull()
    expect(t.push(blockStart({ type: 'tool_use', id: 'toolu_3', name: '', input: {} }))).toBeNull()
    // Still thinking — the unusable block changed nothing.
    expect(t.push(sys({ subtype: 'thinking_tokens', estimated_tokens: 7 }))?.phase).toBe('thinking')
  })

  it('zeroes the per-turn token count on a fresh response, but only when it has something to clear', () => {
    const t = createCompositionTracker()
    expect(t.push(line({ type: 'stream_event', event: { type: 'message_start', message: {} } }))).toBeNull()
    t.push(sys({ subtype: 'thinking_tokens', estimated_tokens: 400 }))
    expect(t.push(line({ type: 'stream_event', event: { type: 'message_start', message: {} } }))?.thinkingTokens).toBe(0)
  })

  it('holds a chunk that splits mid-line until the rest of the line arrives', () => {
    const t = createCompositionTracker()
    const whole = textDelta('spliced')
    const cut = Math.floor(whole.length / 2)
    expect(t.push(whole.slice(0, cut))).toBeNull()
    expect(t.push(whole.slice(cut))).toEqual({
      phase: 'writing', thinkingTokens: 0, chars: 7, tail: 'spliced',
    })
  })

  it('skips noise without losing the events around it', () => {
    const t = createCompositionTracker()
    const noise = [
      'not json at all',
      '   ',
      JSON.stringify(42),
      JSON.stringify(null),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole block' }] } }).trim(),
      line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }).trim(),
      line({ type: 'stream_event', event: 'not-an-object' }).trim(),
      line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }).trim(),
      line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: 'nope' } }).trim(),
      line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } } }).trim(),
      line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: 'nope' } }).trim(),
      delta({ type: 'signature_delta', signature: 'CAIS89' }).trim(),
      delta({ type: 'input_json_delta', partial_json: '{"a":' }).trim(),
      sys({ subtype: 'hook_started', hook_name: 'SessionStart:startup' }).trim(),
      sys({ subtype: 'status', status: 'idle' }).trim(),
    ].join('\n')
    expect(t.push(`${noise}\n`)).toBeNull()
    // The stream still tracks the next real event, so noise cost nothing.
    expect(t.push(textDelta('after'))).toEqual({
      phase: 'writing', thinkingTokens: 0, chars: 5, tail: 'after',
    })
  })

  it('walks the sequence that used to read as a hang', () => {
    // The recorded shape of fl_d0a98e795add: a tool read, then a long think,
    // then a long answer. The middle two produced NOTHING in the session-JSONL
    // tail for 3m28s; every step below is now observable.
    const t = createCompositionTracker()
    expect(t.push(blockStart({ type: 'tool_use', id: 'toolu_016', name: 'Read', input: {} }))?.phase).toBe('tool')
    expect(t.push(blockStart({ type: 'thinking', thinking: '' }))?.phase).toBe('thinking')
    for (let i = 1; i <= 77; i++) t.push(sys({ subtype: 'thinking_tokens', estimated_tokens: i * 50 }))
    const thought = t.push(sys({ subtype: 'thinking_tokens', estimated_tokens: 3900 }))
    expect(thought).toEqual({ phase: 'thinking', thinkingTokens: 3900, chars: 0, tail: '' })
    t.push(blockStart({ type: 'text', text: '' }))
    for (let i = 0; i < 281; i++) t.push(textDelta('chunk of the requirements JSON '))
    const writing = t.push(textDelta('"tier'))
    expect(writing?.phase).toBe('writing')
    expect(writing?.chars).toBe(281 * 31 + 5)
    expect(writing?.tail.endsWith('"tier')).toBe(true)
    // Thinking tokens survive into the writing phase — the turn's total is still
    // the honest answer to "how much work went into this".
    expect(writing?.thinkingTokens).toBe(3900)
  })
})
