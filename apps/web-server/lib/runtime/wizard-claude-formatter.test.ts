import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  elapsed,
  handleLine,
  resultSummary,
  tag,
  toolSummary,
  formatFullToolResult,
  inspectionSummary,
  splitShellPipes,
  toolResultText,
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
    expect(toolResultText([{ type: 'text', text: 'array first' }, { type: 'text', text: 'array second' }]))
      .toBe('array first\narray second')
    expect(formatFullToolResult('first\nsecond')).toContain('second')
    expect(splitShellPipes('grep -E "className|id=|type=" app.ts | head -50'))
      .toEqual(['grep -E "className|id=|type=" app.ts', 'head -50'])
    expect(inspectionSummary({ name: 'Read', input: {} }, 'abc')).toBe('Number of characters: 3')
    expect(inspectionSummary({ name: 'Glob', input: {} }, 'a.ts\nb.ts\n')).toBe('Number of files: 2')
    expect(inspectionSummary({ name: 'Grep', input: {} }, 'a:1\nb:2\n')).toBe('Number of matches: 2')
    expect(inspectionSummary({ name: 'Bash', input: { command: 'ls apps' } }, 'a\nb\n')).toBe('Number of files: 2')
    expect(inspectionSummary({ name: 'Bash', input: { command: 'rg "needle" apps | head -50' } }, 'a\nb\n')).toBe('Number of matches: 2')
    expect(inspectionSummary({ name: 'Bash', input: { command: 'grep needle apps/a.ts | wc -l' } }, '12\n')).toBe('Number of matches: 12')
    expect(inspectionSummary({ name: 'Bash', input: { command: 'grep needle apps/a.ts | awk \'{print $1}\'' } }, 'secret')).toBe('Content read.')
    expect(inspectionSummary({ name: 'Bash', input: { command: 'if test -d apps; then find apps -type f; fi' } }, 'apps/a.ts')).toBe('Content read.')
    expect(inspectionSummary({ name: 'Bash', input: { command: 'npm test' } }, 'ok')).toBeNull()
    expect(resultSummary(123)).toBe('')
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
      partial: true,
      message: {
        content: [{ type: 'text', text: '<file path="top-level-partial.spec.ts">\n' }],
      },
    }))
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
    expect(out).toContain('top-level-partial.spec.ts')
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

  it('prints thinking and tool progress, then prints full successful tool results', () => {
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
    expect(out).toContain('second line')
    expect(out).not.toContain('more lines')
  })

  it('summarizes successful Read tool result content while keeping the file path visible', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-read', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
    }))
    handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-read',
          content: '1\t# Secret read body\n2\tDo not display this line',
        }],
      },
    }))
    const out = writes.join('')
    expect(out).toContain('Read')
    expect(out).toContain('README.md')
    expect(out).toContain('Number of characters:')
    expect(out).not.toContain('Secret read body')
    expect(out).not.toContain('Do not display this line')
  })

  it('summarizes Glob, Grep, and Bash ls results without displaying their contents', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'glob-1', name: 'Glob', input: { pattern: '**/*.ts' } },
          { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'secret' } },
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls apps/web' } },
        ],
      },
    }))
    handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'glob-1', content: 'apps/web/a.ts\napps/web/b.ts\n' },
          { type: 'tool_result', tool_use_id: 'grep-1', content: 'apps/web/a.ts:secret\napps/web/b.ts:secret\n' },
          { type: 'tool_result', tool_use_id: 'bash-1', content: 'src\nvite.config.ts\n' },
        ],
      },
    }))
    const out = writes.join('')
    expect(out).toContain('Number of files: 2')
    expect(out).toContain('Number of matches: 2')
    expect(out).not.toContain('apps/web/a.ts')
    expect(out).not.toContain('apps/web/b.ts:secret')
    expect(out).not.toContain('vite.config.ts')
  })

  it('summarizes Bash grep pipelines without displaying matching source lines', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'bash-grep-1',
            name: 'Bash',
            input: {
              command: 'grep -E "className|id=|placeholder|type=" /Users/fernandi/Documents/tiktok-portal/src/main.tsx | head -50',
            },
          },
        ],
      },
    }))
    handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'bash-grep-1',
          content: [
            '    <footer className="footer-links">',
            '      <main className={narrow ? "shell narrow" : "shell"}>',
            '        <section className="panel">',
            '        <button className="primary" type="button">Refresh tokens</button>',
          ].join('\n'),
        }],
      },
    }))

    const out = writes.join('')
    expect(out).toContain('Bash')
    expect(out).toContain('grep -E')
    expect(out).toContain('Number of matches: 4')
    expect(out).not.toContain('<section className="panel">')
    expect(out).not.toContain('Refresh tokens')
  })

  it('hides successful inspection-like Bash output even when the pipeline is unknown', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'bash-grep-awk',
            name: 'Bash',
            input: { command: 'grep "secret" apps/web/a.ts | awk \'{print $1}\'' },
          },
        ],
      },
    }))
    handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'bash-grep-awk',
          content: 'apps/web/a.ts:secret-token',
        }],
      },
    }))

    const out = writes.join('')
    expect(out).toContain('Content read.')
    expect(out).not.toContain('secret-token')
  })

  it('keeps Read errors visible', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-read-error', name: 'Read', input: { file_path: 'missing.md' } },
        ],
      },
    }))
    handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-read-error',
          content: 'file not found',
          is_error: true,
        }],
      },
    }))
    const out = writes.join('')
    expect(out).toContain('missing.md')
    expect(out).toContain('file not found')
  })

  it('handles empty thinking, array tool results, unknown tools, and tool errors', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '   ' },
          { type: 'thinking' },
          { type: 'tool_use' },
          { type: 'tool_use', id: '', name: 'Custom', input: { payload: 'value' } },
          { type: 'unknown' },
        ],
      },
    }))
    handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: '', content: [{ type: 'text', text: 'failed text' }], is_error: true },
          { type: 'tool_result', content: 'no id text' },
          { type: 'tool_result', tool_use_id: '', content: [{ type: 'text', text: 123 }] },
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
    handleLine(JSON.stringify({ type: 'result', result: 123 }))
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
