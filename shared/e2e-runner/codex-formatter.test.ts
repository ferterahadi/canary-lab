import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  c,
  elapsed,
  relPath,
  truncate,
  summarizeOutput,
  cleanCommand,
  parseCommand,
  quote,
  kindIcon,
  handleLine,
  writeSessionSummary,
  resetSessionState,
} from './codex-formatter'

beforeEach(() => {
  resetSessionState()
})

afterEach(() => {
  delete process.env.CANARY_LAB_BENCHMARK_USAGE_FILE
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

  it('writes benchmark usage sidecar on turn.completed when configured', () => {
    const file = path.join(os.tmpdir(), `codex-usage-${Date.now()}.jsonl`)
    process.env.CANARY_LAB_BENCHMARK_USAGE_FILE = file
    handleLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    )
    const usage = JSON.parse(fs.readFileSync(file, 'utf-8').trim())
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    fs.rmSync(file, { force: true })
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
    expect(out).toContain('↳')
    expect(out).toContain('nothing to commit')
    spy.mockRestore()
  })

  it('renders sed -n range reads as 📖 Read with a line range', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: `sed -n '84,149p' ${process.cwd()}/features/foo/server.ts`,
          exit_code: 0,
          aggregated_output: 'some line',
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('Read')
    expect(out).toContain('features/foo/server.ts')
    expect(out).toContain('L84-149')
    spy.mockRestore()
  })

  it('renders a failed test -f guarded read as "not found"', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: `test -f logs/diagnosis-journal.json && sed -n '1,240p' logs/diagnosis-journal.json`,
          exit_code: 1,
          aggregated_output: '',
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('Read')
    expect(out).toContain('logs/diagnosis-journal.json')
    expect(out).toContain('not found')
    // Must not render a scary red "exit 1" for a missing-file guard.
    expect(out).not.toContain('exit 1')
    spy.mockRestore()
  })

  it('renders rg as 🔍 Grep with pattern + path', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: `rg -n -F 'rejected coupon code=' features/tricky/scripts`,
          exit_code: 0,
          aggregated_output: 'features/tricky/scripts/server.ts:104:...',
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('Grep')
    expect(out).toContain('rejected coupon code=')
    expect(out).toContain('features/tricky/scripts')
    spy.mockRestore()
  })
})

describe('parseCommand', () => {
  it('maps sed range reads to Read with L-range', () => {
    const p = parseCommand(`sed -n '10,50p' features/foo/server.ts`)
    expect(p.tool).toBe('Read')
    expect(p.label).toContain('features/foo/server.ts')
    expect(p.label).toContain('L10-50')
    expect(p.guardedRead).toBe(false)
  })
  it('strips a leading test -f guard and marks the read as guarded', () => {
    const p = parseCommand(`test -f logs/foo && sed -n '1,10p' logs/foo`)
    expect(p.tool).toBe('Read')
    expect(p.guardedRead).toBe(true)
  })
  it('maps sed pattern-range reads to Read', () => {
    const p = parseCommand(`sed -n '/<start>/,/<\\/start>/p' logs/svc.log`)
    expect(p.tool).toBe('Read')
    expect(p.label).toContain('logs/svc.log')
  })
  it('maps cat / head / tail to Read', () => {
    expect(parseCommand('cat foo.ts').tool).toBe('Read')
    expect(parseCommand('head -n 50 foo.ts').tool).toBe('Read')
    expect(parseCommand('tail -100 foo.ts').tool).toBe('Read')
  })
  it('maps rg with quoted pattern + path to Grep', () => {
    const p = parseCommand(`rg -n 'COUPONS' features/x/scripts`)
    expect(p.tool).toBe('Grep')
    expect(p.label).toContain('COUPONS')
    expect(p.label).toContain('features/x/scripts')
  })
  it('maps ls to List', () => {
    const p = parseCommand('ls features/foo')
    expect(p.tool).toBe('List')
    expect(p.label).toBe('features/foo')
  })
  it('maps find to Glob', () => {
    const p = parseCommand('find features -name "*.ts"')
    expect(p.tool).toBe('Glob')
  })
  it('falls through to Bash for unrecognized commands', () => {
    const p = parseCommand('git status')
    expect(p.tool).toBe('Bash')
    expect(p.label).toContain('git status')
  })

  it('emits a quoted agent_message block', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello\nworld' },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('│ hello')
    expect(out).toContain('│ world')
    spy.mockRestore()
  })

  it('skips agent_message when text is empty or whitespace-only', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '   ' },
      }),
    )
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('emits one line per change for a file_change item', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          changes: [
            { kind: 'add', path: `${process.cwd()}/new.ts` },
            { kind: 'delete', path: `${process.cwd()}/old.ts` },
            { kind: 'update', path: `${process.cwd()}/touched.ts` },
          ],
        },
      }),
    )
    const out = spy.mock.calls.map((c) => c[0] as string).join('')
    expect(out).toContain('new.ts')
    expect(out).toContain('old.ts')
    expect(out).toContain('touched.ts')
    expect(out).toContain('Write')
    expect(out).toContain('Edit')
    expect(out).toContain('✓ applied')
    // Two stdout.writes per change (tool line + result line)
    expect(spy).toHaveBeenCalledTimes(6)
    spy.mockRestore()
  })
})
