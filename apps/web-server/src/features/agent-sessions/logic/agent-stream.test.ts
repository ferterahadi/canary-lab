import { describe, it, expect } from 'vitest'
import { recoverClaudeFinalText, recoverClaudeAssistantText } from './agent-stream'

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

describe('recoverClaudeAssistantText', () => {
  it('keeps an earlier turn when a later one only signs off in prose', () => {
    // The scout failure mode: the JSON answer lands in turn 1, then the agent
    // adds a chatter turn (which also becomes the terminal result). The final
    // recovery drops the JSON; the all-turns recovery keeps it.
    const out = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '```json\n{"configSource":"x","envFiles":[]}\n```' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Already delivered the JSON above.' }] } }),
      JSON.stringify({ type: 'result', result: 'Already delivered the JSON above.' }),
    ].join('\n')
    expect(recoverClaudeFinalText(out)).toBe('Already delivered the JSON above.')
    const all = recoverClaudeAssistantText(out)
    expect(all).toContain('"configSource"')
    expect(all).toContain('Already delivered the JSON above.')
  })

  it('falls back to raw stdout when there are no assistant turns', () => {
    expect(recoverClaudeAssistantText('not json at all')).toBe('not json at all')
  })
})
