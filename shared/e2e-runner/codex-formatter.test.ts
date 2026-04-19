import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  c,
  elapsed,
  relPath,
  truncate,
  summarizeOutput,
  cleanCommand,
  quote,
  kindIcon,
  handleLine,
  writeSessionSummary,
  resetSessionState,
} from './codex-formatter'

beforeEach(() => {
  resetSessionState()
})

describe('c (color)', () => {
  it('returns plain text when not a TTY (test env)', () => {
    expect(c('green', 'ok')).toBe('ok')
    expect(c('red', 'x')).toBe('x')
  })
})

describe('elapsed', () => {
  it('formats as m:ss', () => {
    expect(elapsed()).toMatch(/^\d+:\d{2}$/)
  })
})

describe('relPath', () => {
  it('strips CWD + /', () => {
    expect(relPath(`${process.cwd()}/foo/bar.ts`)).toBe('foo/bar.ts')
  })
  it('returns "." when path equals CWD', () => {
    expect(relPath(process.cwd())).toBe('.')
  })
  it('handles /private prefix on macOS', () => {
    expect(relPath(`/private${process.cwd()}/x.ts`)).toBe('x.ts')
  })
  it('returns empty for empty input', () => {
    expect(relPath('')).toBe('')
  })
  it('replaces HOME with ~ when path is elsewhere', () => {
    const home = process.env.HOME ?? ''
    if (home) {
      expect(relPath(`${home}/outside`)).toBe('~/outside')
    }
  })
})

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })
  it('adds ellipsis for long strings', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
  })
})

describe('summarizeOutput', () => {
  it('returns (no output) marker for empty', () => {
    expect(summarizeOutput('')).toBe('(no output)')
    expect(summarizeOutput('   \n  \n')).toBe('(no output)')
  })
  it('returns first non-empty line for single-line output', () => {
    expect(summarizeOutput('hello')).toBe('hello')
  })
  it('appends "+N more lines" suffix for multi-line output', () => {
    expect(summarizeOutput('line1\nline2\nline3')).toBe('line1 (+2 more lines)')
  })
})

describe('cleanCommand', () => {
  it('unwraps /bin/zsh -lc \'cmd\'', () => {
    expect(cleanCommand("/bin/zsh -lc 'npm run test'")).toBe('npm run test')
  })
  it('unwraps /bin/bash -c "cmd"', () => {
    expect(cleanCommand('/bin/bash -c "echo hi"')).toBe('echo hi')
  })
  it('leaves non-wrapped commands alone', () => {
    expect(cleanCommand('git status')).toBe('git status')
  })
})

describe('quote', () => {
  it('prefixes each line with │', () => {
    expect(quote('a\nb')).toBe('  │ a\n  │ b')
  })
})

describe('kindIcon', () => {
  it('add → +, delete → -, other → ~', () => {
    expect(kindIcon('add')).toBe('+')
    expect(kindIcon('delete')).toBe('-')
    expect(kindIcon('update')).toBe('~')
    expect(kindIcon('whatever')).toBe('~')
  })
})

describe('handleLine', () => {
  it('ignores empty and invalid lines silently', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine('')
    handleLine('   ')
    handleLine('not-json')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('emits a line on thread.started', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(JSON.stringify({ type: 'thread.started', thread_id: '12345678abc' }))
    const out = (spy.mock.calls[0]?.[0] as string) ?? ''
    expect(out).toContain('thread')
    expect(out).toContain('12345678')
    spy.mockRestore()
  })

  it('emits usage summary on turn.completed', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    )
    const out = (spy.mock.calls[0]?.[0] as string) ?? ''
    expect(out).toContain('turn done')
    expect(out).toContain('(10 in / 5 out)')
    spy.mockRestore()
  })

  it('writeSessionSummary aggregates tokens + turns + reasoning across the session', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Two turns + one reasoning step.
    handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'planning a refactor' },
      }),
    )
    handleLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    )
    handleLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 20, output_tokens: 7 },
      }),
    )
    spy.mockClear()
    writeSessionSummary()
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('session done')
    expect(out).toContain('30 in / 12 out')
    expect(out).toContain('2 turns')
    expect(out).toContain('1 reasoning step')
    spy.mockRestore()
  })

  it('emits command execution summary on item.completed command_execution', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'git status',
          exit_code: 0,
          aggregated_output: 'nothing to commit',
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('$')
    expect(out).toContain('git status')
    expect(out).toContain('✓')
    expect(out).toContain('nothing to commit')
    spy.mockRestore()
  })
})
