import { describe, it, expect } from 'vitest'
import { recoverClaudeFinalText } from './agent-stream'

describe('recoverClaudeFinalText', () => {
  it('prefers the terminal result envelope', () => {
    const out = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
      JSON.stringify({ type: 'result', result: 'the final answer' }),
    ].join('\n')
    expect(recoverClaudeFinalText(out)).toBe('the final answer')
  })

  it('falls back to concatenated assistant text when there is no result envelope', () => {
    const out = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '<plan-output>[]' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '</plan-output>' }] } }),
    ].join('\n')
    expect(recoverClaudeFinalText(out)).toBe('<plan-output>[]</plan-output>')
  })

  it('ignores non-JSON / tool noise lines', () => {
    const out = [
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
      JSON.stringify({ type: 'result', result: 'answer' }),
    ].join('\n')
    expect(recoverClaudeFinalText(out)).toBe('answer')
  })

  it('falls back to raw stdout when nothing parses', () => {
    expect(recoverClaudeFinalText('just plain text output')).toBe('just plain text output')
  })

  // line 17: empty / whitespace-only lines → !trimmed branch → continue
  it('skips blank lines between JSON entries', () => {
    const out =
      JSON.stringify({ type: 'result', result: 'final' }) +
      '\n\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ignored' }] } })
    expect(recoverClaudeFinalText(out)).toBe('final')
  })

  // line 20: parsed JSON is not an object (e.g. a plain string or number) → continue
  it('skips lines whose JSON value is not an object', () => {
    const out = [
      JSON.stringify('just a string'),         // typeof !== 'object'
      JSON.stringify(42),                       // typeof !== 'object'
      JSON.stringify({ type: 'result', result: 'ok' }),
    ].join('\n')
    expect(recoverClaudeFinalText(out)).toBe('ok')
  })

  // line 29: assistant message whose content is not an array → Array.isArray false branch
  it('skips assistant messages whose content is not an array', () => {
    const out = [
      JSON.stringify({ type: 'assistant', message: { content: 'string-content' } }),
      JSON.stringify({ type: 'result', result: 'final' }),
    ].join('\n')
    expect(recoverClaudeFinalText(out)).toBe('final')
  })
})
