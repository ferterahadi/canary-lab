import { describe, it, expect, vi } from 'vitest'
import {
  c,
  relPath,
  stripLineNumbers,
  firstNonEmpty,
  summarizeResult,
  toolLabel,
  formatToolCall,
  formatToolResult,
  handleLine,
} from './claude-formatter'

describe('c (color)', () => {
  it('returns plain text when not a TTY', () => {
    expect(c('red', 'x')).toBe('x')
  })
})

describe('relPath', () => {
  it('strips CWD prefix', () => {
    expect(relPath(`${process.cwd()}/a/b`)).toBe('a/b')
  })
  it('returns "." for CWD', () => {
    expect(relPath(process.cwd())).toBe('.')
  })
  it('empty input → empty', () => {
    expect(relPath('')).toBe('')
  })
})

describe('stripLineNumbers', () => {
  it('strips cat -n style prefixes', () => {
    expect(stripLineNumbers('   1\tfoo\n   2\tbar\n')).toBe('foo\nbar\n')
  })
  it('leaves content without prefixes alone', () => {
    expect(stripLineNumbers('no prefix\nhere')).toBe('no prefix\nhere')
  })
})

describe('firstNonEmpty', () => {
  it('returns first non-empty trimmed line', () => {
    expect(firstNonEmpty('\n  \nhello\nworld')).toBe('hello')
  })
  it('returns empty if all blank', () => {
    expect(firstNonEmpty('   \n\n  ')).toBe('')
  })
})

describe('summarizeResult', () => {
  it('returns (empty) marker for empty', () => {
    expect(summarizeResult('')).toBe('(empty)')
  })
  it('single-line returns head', () => {
    expect(summarizeResult('one line')).toBe('one line')
  })
  it('multi-line shows head + (+N more lines)', () => {
    expect(summarizeResult('a\nb\nc')).toBe('a (+2 more lines)')
  })
  it('truncates long heads with ellipsis', () => {
    expect(summarizeResult('x'.repeat(200), 10)).toBe('xxxxxxxxx…')
  })
  it('strips line numbers before summarizing', () => {
    expect(summarizeResult('   1\treal line')).toBe('real line')
  })
})

describe('toolLabel', () => {
  it('includes an icon and the padded tool name', () => {
    const label = toolLabel('Read')
    expect(label).toContain('📖')
    expect(label).toMatch(/Read\s/)
  })
  it('uses bullet for unknown tools', () => {
    expect(toolLabel('Unknown')).toContain('•')
  })
})

describe('formatToolCall', () => {
  it('Bash: command + optional description', () => {
    expect(formatToolCall('Bash', { command: 'ls' })).toBe('ls')
    expect(formatToolCall('Bash', { command: 'ls', description: 'list' })).toContain('# list')
  })
  it('Read/Edit/Write: relative path', () => {
    expect(formatToolCall('Read', { file_path: `${process.cwd()}/a.ts` })).toBe('a.ts')
    expect(formatToolCall('Write', { file_path: `${process.cwd()}/b.ts` })).toBe('b.ts')
  })
  it('Glob: pattern + optional "in <path>"', () => {
    expect(formatToolCall('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(formatToolCall('Glob', { pattern: '*.ts', path: `${process.cwd()}/src` })).toContain(' in src')
  })
  it('Grep: pattern + optional path + glob', () => {
    const out = formatToolCall('Grep', { pattern: 'foo', glob: '*.ts' })
    expect(out).toContain('foo')
    expect(out).toContain('(*.ts)')
  })
  it('TodoWrite: count with singular/plural', () => {
    expect(formatToolCall('TodoWrite', { todos: [{ a: 1 }] })).toBe('1 todo')
    expect(formatToolCall('TodoWrite', { todos: [1, 2, 3] })).toBe('3 todos')
    expect(formatToolCall('TodoWrite', { todos: [] })).toBe('0 todos')
  })
  it('default: JSON-truncated', () => {
    const out = formatToolCall('Other', { a: 1 })
    expect(out).toContain('{"a":1}')
  })
  it('returns empty string for non-object input', () => {
    expect(formatToolCall('Bash', null as any)).toBe('')
  })
})

describe('formatToolResult', () => {
  it('returns null for empty text', () => {
    expect(formatToolResult('Read', '')).toBeNull()
  })
  it('Edit/Write collapse to ✓ applied', () => {
    expect(formatToolResult('Edit', 'anything here')).toContain('✓ applied')
    expect(formatToolResult('Write', 'anything here')).toContain('✓ applied')
  })
  it('Read summarizes with 80 char budget', () => {
    expect(formatToolResult('Read', '   1\thello\n   2\tworld')).toContain('hello')
  })
  it('Bash with blank output returns ✓', () => {
    expect(formatToolResult('Bash', '  ')).toBeNull()
  })
  it('default path summarizes', () => {
    expect(formatToolResult('Other', 'a\nb')).toContain('a')
  })
})

describe('handleLine', () => {
  it('ignores empty/invalid input', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine('')
    handleLine('{not json')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('system init line prints session info', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abcd1234efgh',
        model: 'claude-sonnet',
      }),
    )
    const out = (spy.mock.calls[0]?.[0] as string) ?? ''
    expect(out).toContain('session')
    expect(out).toContain('abcd1234')
    expect(out).toContain('claude-sonnet')
    spy.mockRestore()
  })

  it('result line prints duration and done/failed marker', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(JSON.stringify({ type: 'result', duration_ms: 1234, is_error: false }))
    const done = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(done).toContain('✓ done')
    expect(done).toContain('in 1.2s')

    spy.mockClear()
    handleLine(JSON.stringify({ type: 'result', duration_ms: 500, is_error: true }))
    const failed = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(failed).toContain('✗ failed')
    spy.mockRestore()
  })

  it('result line prints token usage + turns + cost when present', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'result',
        duration_ms: 1000,
        is_error: false,
        num_turns: 3,
        total_cost_usd: 0.0523,
        usage: {
          input_tokens: 120,
          output_tokens: 80,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 200,
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('120 in / 80 out')
    expect(out).toContain('200 cache read · 30 cache created')
    expect(out).toContain('3 turns')
    expect(out).toContain('$0.0523')
    spy.mockRestore()
  })

  it('result line omits token summary when no usage data is present', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(JSON.stringify({ type: 'result', duration_ms: 1, is_error: false }))
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).not.toContain('in /')
    expect(out).not.toContain('cache')
    spy.mockRestore()
  })

  it('assistant message with text prints quoted block', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'line one\nline two' }] },
      }),
    )
    const out = (spy.mock.calls[0]?.[0] as string) ?? ''
    expect(out).toContain('│ line one')
    expect(out).toContain('│ line two')
    spy.mockRestore()
  })

  it('assistant tool_use followed by user tool_result pairs by id', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      }),
    )
    handleLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi\n' }],
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('Bash')
    expect(out).toContain('echo hi')
    expect(out).toContain('↳')
    expect(out).toContain('hi')
    spy.mockRestore()
  })
})
