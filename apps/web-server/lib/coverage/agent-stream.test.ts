import { describe, it, expect } from 'vitest'
import { parseClaudeStreamLine, makeClaudeStreamSink } from './agent-stream'

describe('parseClaudeStreamLine', () => {
  it('extracts a text delta (stream_event wrapper)', () => {
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } } })
    expect(parseClaudeStreamLine(line)).toEqual({ t: 'delta', text: 'hel' })
  })

  it('extracts a text delta (flat shape)', () => {
    const line = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } })
    expect(parseClaudeStreamLine(line)).toEqual({ t: 'delta', text: 'lo' })
  })

  it('extracts a complete assistant text block', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"mappings":[]}' }] } })
    expect(parseClaudeStreamLine(line)).toEqual({ t: 'assistant', text: '{"mappings":[]}' })
  })

  it('surfaces a tool_use by name', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })
    expect(parseClaudeStreamLine(line)).toEqual({ t: 'tool', name: 'Read' })
  })

  it('extracts the terminal result text', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'FINAL' })
    expect(parseClaudeStreamLine(line)).toEqual({ t: 'result', text: 'FINAL' })
  })

  it('returns null on init / unknown / garbage lines', () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull()
    expect(parseClaudeStreamLine('not json')).toBeNull()
    expect(parseClaudeStreamLine('')).toBeNull()
  })
})

describe('makeClaudeStreamSink', () => {
  it('streams token deltas live and returns the result text', () => {
    const out: string[] = []
    const sink = makeClaudeStreamSink((s) => out.push(s))
    // Split across chunks + partial lines to exercise the line buffer.
    sink.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Map' } } }) + '\n')
    sink.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ping' } } }) + '\n')
    sink.push(JSON.stringify({ type: 'result', subtype: 'success', result: '{"mappings":[{"testName":"t","requirements":["R1"]}]}' }) + '\n')
    expect(out.join('')).toBe('Mapping')                       // live token stream
    expect(sink.finalText()).toContain('"mappings"')           // final answer for the engine
  })

  it('does not double-print: deltas suppress the complete-block echo', () => {
    const out: string[] = []
    const sink = makeClaudeStreamSink((s) => out.push(s))
    sink.push(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'AB' } }) + '\n')
    sink.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'AB' }] } }) + '\n')
    expect(out.join('')).toBe('AB')                            // not 'ABAB'
  })

  it('echoes the complete block when no deltas were seen (partials off)', () => {
    const out: string[] = []
    const sink = makeClaudeStreamSink((s) => out.push(s))
    sink.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole answer' }] } }) + '\n')
    expect(out.join('')).toBe('whole answer')
    expect(sink.finalText()).toBe('whole answer')              // falls back to concatenated assistant text
  })

  it('flushes a trailing partial line on finalText()', () => {
    const sink = makeClaudeStreamSink()
    sink.push(JSON.stringify({ type: 'result', result: 'no trailing newline' })) // no '\n'
    expect(sink.finalText()).toBe('no trailing newline')
  })

  it('falls back to raw stdout when nothing parses', () => {
    const sink = makeClaudeStreamSink()
    sink.push('plain non-json output\n')
    expect(sink.finalText()).toBe('plain non-json output\n')
  })
})
