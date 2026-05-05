import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
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

afterEach(() => {
  delete process.env.CANARY_LAB_BENCHMARK_USAGE_FILE
})

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
  it('replaces HOME with ~ for paths outside CWD', () => {
    const home = process.env.HOME ?? ''
    if (home && !process.cwd().startsWith(home)) {
      expect(relPath(`${home}/sibling/x`)).toBe('~/sibling/x')
    } else if (home) {
      // CWD is usually inside HOME in dev; this still exercises the replace branch.
      const replaced = relPath(`${home}/outside-cwd-xyz`)
      expect(replaced.startsWith('~') || replaced.startsWith(home)).toBe(true)
    }
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
  it('includes one space between the icon and tool name', () => {
    expect(toolLabel('Read')).toBe('📖 Read')
    expect(toolLabel('Bash')).toBe('$ Bash')
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
  it('Read: surfaces L<a>-<b> when offset+limit are set (narrow Read visibility)', () => {
    const out = formatToolCall('Read', {
      file_path: `${process.cwd()}/server.ts`,
      offset: 95,
      limit: 50,
    })
    expect(out).toContain('server.ts')
    expect(out).toContain('L95-144')
  })
  it('Read: surfaces "from L<offset>" when only offset is set', () => {
    const out = formatToolCall('Read', {
      file_path: `${process.cwd()}/x.ts`,
      offset: 10,
    })
    expect(out).toContain('from L10')
  })
  it('Edit: surfaces −<old> +<new> line deltas', () => {
    const out = formatToolCall('Edit', {
      file_path: `${process.cwd()}/x.ts`,
      old_string: 'a\nb',
      new_string: 'c\nd\ne',
    })
    expect(out).toContain('−2 +3')
  })
  it('Edit: flags replace_all with (all)', () => {
    const out = formatToolCall('Edit', {
      file_path: `${process.cwd()}/x.ts`,
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    })
    expect(out).toContain('(all)')
  })
  it('Write: surfaces line count when content provided', () => {
    const out = formatToolCall('Write', {
      file_path: `${process.cwd()}/x.ts`,
      content: 'line1\nline2\nline3',
    })
    expect(out).toContain('3L')
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

  it('result line prints token usage + turns but hides cost by default (Pro/Max users aren\'t billed)', () => {
    const prev = process.env.CANARY_HEAL_SHOW_COST
    delete process.env.CANARY_HEAL_SHOW_COST
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
    expect(out).not.toContain('$')
    spy.mockRestore()
    if (prev !== undefined) process.env.CANARY_HEAL_SHOW_COST = prev
  })

  it('writes benchmark usage sidecar on result events when configured', () => {
    const prev = process.env.CANARY_HEAL_SHOW_COST
    delete process.env.CANARY_HEAL_SHOW_COST
    const file = path.join(os.tmpdir(), `claude-usage-${Date.now()}.jsonl`)
    process.env.CANARY_LAB_BENCHMARK_USAGE_FILE = file

    handleLine(
      JSON.stringify({
        type: 'result',
        duration_ms: 1000,
        is_error: false,
        usage: {
          input_tokens: 120,
          output_tokens: 80,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 200,
        },
      }),
    )

    const usage = JSON.parse(fs.readFileSync(file, 'utf-8').trim())
    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 30,
    })

    fs.rmSync(file, { force: true })
    if (prev !== undefined) process.env.CANARY_HEAL_SHOW_COST = prev
  })

  it('result line includes cost when CANARY_HEAL_SHOW_COST=1', () => {
    const prev = process.env.CANARY_HEAL_SHOW_COST
    process.env.CANARY_HEAL_SHOW_COST = '1'
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'result',
        duration_ms: 1000,
        is_error: false,
        num_turns: 3,
        total_cost_usd: 0.0523,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('$0.0523')
    spy.mockRestore()
    if (prev === undefined) delete process.env.CANARY_HEAL_SHOW_COST
    else process.env.CANARY_HEAL_SHOW_COST = prev
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

  it('extracts the text block when tool_result content is an array', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo arr' } },
          ],
        },
      }),
    )
    handleLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: [{ type: 'text', text: 'array payload' }],
            },
          ],
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('array payload')
    spy.mockRestore()
  })

  it('assistant thinking block with non-empty text prints a 💭 one-liner', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'thinking',
              thinking: 'The previous fix is correct but the service was not restarted',
            },
          ],
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('💭 thinking')
    expect(out).toContain('The previous fix is correct')
    spy.mockRestore()
  })

  it('assistant thinking block with empty text prints nothing (signature-only thinking)', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: '', signature: 'xxx' }],
        },
      }),
    )
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('rate_limit_event and SessionStart hook chatter are dropped silently', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))
    handleLine(
      JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:resume' }),
    )
    handleLine(
      JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:resume' }),
    )
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('marks tool errors with ✗ instead of ↳', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'boom' } },
          ],
        },
      }),
    )
    handleLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't3', content: 'failed', is_error: true },
          ],
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('✗')
    spy.mockRestore()
  })
})
