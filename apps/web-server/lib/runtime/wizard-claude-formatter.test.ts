import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  elapsed,
  handleLine,
  resultSummary,
  tag,
  toolSummary,
  truncate,
} from './wizard-claude-formatter'

let writes: string[]
let spy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  writes = []
  spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })
})

afterEach(() => {
  spy.mockRestore()
})

describe('wizard claude formatter', () => {
  it('formats helper summaries compactly', () => {
    expect(elapsed()).toMatch(/^\d+:\d{2}$/)
    expect(tag()).toMatch(/^\[\d+:\d{2}\]$/)
    expect(truncate('abcdef', 4)).toBe('abc...')
    expect(toolSummary('Bash', { command: 'npm run test' })).toBe('npm run test')
    expect(toolSummary('Read', { file_path: 'apps/web/server.ts' })).toBe('apps/web/server.ts')
    expect(toolSummary('Grep', { pattern: 'needle' })).toBe('needle')
    expect(toolSummary('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(toolSummary('Edit', { file_path: 'x.ts' })).toBe('x.ts')
    expect(toolSummary('Write', { file_path: 'x.ts' })).toBe('x.ts')
    expect(toolSummary('Other', { nested: { value: true } })).toContain('"value":true')
    expect(toolSummary('Other', null as any)).toBe('')
    expect(resultSummary('')).toBe('')
    expect(resultSummary('\nfirst\nsecond')).toBe('first')
    expect(resultSummary([{ type: 'text', text: 'array first\narray second' }])).toBe('array first')
    expect(resultSummary([{ type: 'image', source: 'ignored' }])).toBe('')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(toolSummary('Other', circular)).toBe('')
  })

  it('ignores empty, invalid, and unsupported payloads', () => {
    handleLine('')
    handleLine('not json')
    handleLine(JSON.stringify({ type: 'assistant', message: { content: 'not-array' } }))
    handleLine(JSON.stringify({ type: 'user', message: { content: 'not-array' } }))
    expect(writes).toEqual([])
  })

  it('prints session progress', () => {
    handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abcdef1234', model: 'opus' }))
    const out = writes.join('')
    expect(out).toContain('[[canary-lab:wizard-session agent=claude id=abcdef1234]]')
    expect(out).toContain('session')
    expect(out).toContain('abcdef12')
    expect(out).toContain('(opus)')
  })

  it('uses fallback session label when the id is missing', () => {
    handleLine(JSON.stringify({ type: 'system', subtype: 'init' }))
    const out = writes.join('')
    expect(out).toContain('started')
    expect(out).toContain('(unknown)')
  })

  it('emits assistant text raw so wizard markers remain parseable', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<plan-output>\n{"steps":[{"step":"Login","actions":[],"expectedOutcome":"ok"}]}\n</plan-output>',
        }],
      },
    }))
    const out = writes.join('')
    expect(out).toContain('<plan-output>')
    expect(out).toContain('"steps"')
    expect(out).not.toContain('│')
  })

  it('turns partial assistant text into progress without raw file blocks', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        stop_reason: null,
        content: [{
          type: 'text',
          text: '<file path="feature.config.cjs">\nmodule.exports = {}\n',
        }],
      },
    }))
    const out = writes.join('')
    expect(out).toContain('writing')
    expect(out).toContain('feature.config.cjs')
    expect(out).not.toContain('<file path="feature.config.cjs">')
  })

  it('does not repeat progress for the same partial file path', () => {
    const partial = {
      type: 'assistant',
      message: {
        stop_reason: null,
        content: [{ type: 'text', text: '<file path="e2e/login.spec.ts">\n' }],
      },
    }
    handleLine(JSON.stringify(partial))
    handleLine(JSON.stringify(partial))
    const out = writes.join('')
    expect(out.match(/e2e\/login\.spec\.ts/g)).toHaveLength(1)
  })

  it('prints a single generic partial drafting line before file paths are visible', () => {
    const partial = {
      type: 'assistant',
      message: {
        stop_reason: null,
        content: [{ type: 'text', text: 'I am preparing the feature scaffold' }],
      },
    }
    handleLine(JSON.stringify(partial))
    handleLine(JSON.stringify(partial))
    const out = writes.join('')
    expect(out).toContain('drafting')
    expect(out.match(/spec output/g)).toHaveLength(1)
  })

  it('prints thinking and tool progress, then summarizes successful tool results', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'working through the plan\nwith details' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo ok' } },
        ],
      },
    }))
    handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok\nsecond line' }],
      },
    }))
    const out = writes.join('')
    expect(out).toContain('thinking')
    expect(out).toContain('working through the plan')
    expect(out).toContain('Bash')
    expect(out).toContain('echo ok')
    expect(out).toContain('->')
    expect(out).toContain('ok')
  })

  it('handles empty thinking, array tool results, unknown tools, and tool errors', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '   ' },
          { type: 'tool_use', id: '', name: 'Custom', input: { payload: 'value' } },
        ],
      },
    }))
    handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: '', content: [{ type: 'text', text: 'failed text' }], is_error: true },
          { type: 'tool_result', tool_use_id: 'missing', content: [{ type: 'image', source: 'ignored' }] },
          { type: 'ignored', content: 'skip me' },
        ],
      },
    }))
    const out = writes.join('')
    expect(out).toContain('Custom')
    expect(out).toContain('"payload":"value"')
    expect(out).toContain('x')
    expect(out).toContain('failed text')
    expect(out).not.toContain('skip me')
  })

  it('prints result status with optional duration', () => {
    handleLine(JSON.stringify({ type: 'result', duration_ms: 1234, is_error: false }))
    handleLine(JSON.stringify({ type: 'result', duration_ms: 0, is_error: true }))
    const out = writes.join('')
    expect(out).toContain('done')
    expect(out).toContain('in 1.2s')
    expect(out).toContain('failed')
  })

  it('emits final result text raw when Claude only streams partial assistant text', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        stop_reason: null,
        content: [{ type: 'text', text: '<plan-output>\n[' }],
      },
    }))
    handleLine(JSON.stringify({
      type: 'result',
      duration_ms: 1000,
      is_error: false,
      result: '<plan-output>\n[{"step":"Login","actions":[],"expectedOutcome":"ok"}]\n</plan-output>',
    }))
    const out = writes.join('')
    expect(out).toContain('<plan-output>')
    expect(out).toContain('</plan-output>')
  })

  it('does not duplicate result text after a final assistant message was emitted', () => {
    const finalText = '<plan-output>\n[]\n</plan-output>'
    handleLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: finalText }] },
    }))
    handleLine(JSON.stringify({
      type: 'result',
      duration_ms: 1000,
      is_error: false,
      result: finalText,
    }))
    const out = writes.join('')
    expect(out.match(/<plan-output>/g)).toHaveLength(1)
  })
})
