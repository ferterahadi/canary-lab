import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ui from './ui'

// `colorEnabled()` is false under vitest (stdout is not a TTY), so `c`/`style`
// pass text through and the assertions below can match plain strings. The
// colour codes themselves are covered by ./colors.test.ts.

let logs: string[]
let errors: string[]

beforeEach(() => {
  logs = []
  errors = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  ui.setActiveRunnerLog(null)
  vi.restoreAllMocks()
})

describe('cli-ui printers', () => {
  it('prints a blank line', () => {
    ui.line()
    expect(logs).toEqual([''])
  })

  it('pads the banner rule to a minimum of 8 characters', () => {
    ui.banner('Run')
    expect(logs).toEqual(['', 'Run', '────────'])
  })

  it('matches the banner rule to a longer title', () => {
    ui.banner('Canary Lab boot')
    expect(logs[2]).toBe('─'.repeat('Canary Lab boot'.length))
  })

  it('prints a section header after a blank line', () => {
    ui.section('Services')
    expect(logs).toEqual(['', 'Services'])
  })

  it('indents steps and bullets by two spaces', () => {
    ui.step(2, 'boot the API')
    ui.bullet('todo-api')
    expect(logs).toEqual(['  2. boot the API', '  • todo-api'])
  })

  it('prints status lines flush-left, routing failures to stderr', () => {
    ui.ok('all green')
    ui.warn('slow start')
    ui.info('port 7420')
    ui.fail('boom')
    expect(logs).toEqual(['✓ all green', '! slow start', '› port 7420'])
    expect(errors).toEqual(['✗ boom'])
  })

  it('returns dim and path text instead of printing it', () => {
    expect(ui.dim('quiet')).toBe('quiet')
    expect(ui.path('/tmp/x')).toBe('/tmp/x')
    expect(logs).toEqual([])
  })

  it('re-exports the colour helpers so callers need one import', () => {
    expect(typeof ui.colorEnabled).toBe('function')
    expect(ui.c('green', 'x')).toBe('x')
    expect(ui.style(['bold', 'cyan'], 'x')).toBe('x')
  })
})

describe('runner-log teeing', () => {
  it('is a no-op when no sink is installed (web mode)', () => {
    // Every printer must survive the null sink — this is the only path web
    // mode ever takes.
    expect(() => {
      ui.banner('B')
      ui.section('S')
      ui.step(1, 'x')
      ui.bullet('y')
      ui.ok('o')
      ui.warn('w')
      ui.info('i')
      ui.fail('f')
    }).not.toThrow()
  })

  it('tees every message to the installed sink at its own level', () => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    ui.setActiveRunnerLog(sink)

    ui.banner('Boot')
    ui.section('Services')
    ui.step(3, 'start api')
    ui.bullet('todo-api')
    ui.ok('ready')
    ui.info('listening')
    ui.warn('retrying')
    ui.fail('crashed')

    // The tee strips layout (indent, glyphs) — runner.log carries the message,
    // not the terminal formatting. `ok` is the one that gains a prefix.
    expect(sink.info.mock.calls.map((c) => c[0])).toEqual([
      'Boot',
      'Services',
      '3. start api',
      'todo-api',
      'OK ready',
      'listening',
    ])
    expect(sink.warn.mock.calls.map((c) => c[0])).toEqual(['retrying'])
    expect(sink.error.mock.calls.map((c) => c[0])).toEqual(['crashed'])
  })

  it('stops teeing once the sink is uninstalled', () => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    ui.setActiveRunnerLog(sink)
    ui.info('captured')
    ui.setActiveRunnerLog(null)
    ui.info('not captured')
    expect(sink.info.mock.calls.map((c) => c[0])).toEqual(['captured'])
  })
})
