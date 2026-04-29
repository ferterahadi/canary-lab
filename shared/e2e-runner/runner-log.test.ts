import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  RunnerLog,
  formatLine,
  renderEvent,
  stripAnsi,
} from './runner-log'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rl-')))
})

describe('stripAnsi', () => {
  it('removes ANSI color escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('plain')).toBe('plain')
    expect(stripAnsi('\x1b[1;33mbold-yellow\x1b[0m text')).toBe('bold-yellow text')
  })
})

describe('formatLine', () => {
  it('prefixes ISO timestamp + padded level + message and strips ANSI', () => {
    const line = formatLine('INFO', '\x1b[32mhello\x1b[0m', new Date('2026-04-29T15:42:01Z'))
    expect(line).toBe('2026-04-29T15:42:01.000Z INFO  hello\n')
  })

  it('trims trailing newlines from the message', () => {
    const line = formatLine('WARN', 'msg\n\n', new Date('2026-04-29T15:42:01Z'))
    expect(line).toBe('2026-04-29T15:42:01.000Z WARN  msg\n')
  })

  it('handles ERROR level (5-char level pads to 5)', () => {
    const line = formatLine('ERROR', 'boom', new Date('2026-04-29T15:42:01Z'))
    expect(line).toBe('2026-04-29T15:42:01.000Z ERROR boom\n')
  })
})

describe('renderEvent', () => {
  const svc = { name: 'shop', safeName: 'shop', command: 'x', cwd: '/' } as any

  it('renders service-started', () => {
    const r = renderEvent('service-started', { service: svc, pid: 7 })
    expect(r).toEqual({ level: 'INFO', message: 'Service started: shop (pid=7)' })
  })

  it('renders service-exit (clean → INFO, non-zero → WARN)', () => {
    expect(renderEvent('service-exit', { service: svc, exitCode: 0 })).toEqual({
      level: 'INFO',
      message: 'Service exited: shop code=0',
    })
    expect(renderEvent('service-exit', { service: svc, exitCode: 1 })).toEqual({
      level: 'WARN',
      message: 'Service exited: shop code=1',
    })
  })

  it('renders health-check (healthy/unhealthy)', () => {
    expect(renderEvent('health-check', { service: svc, healthy: true })).toEqual({
      level: 'INFO',
      message: 'Health check passed: shop',
    })
    expect(renderEvent('health-check', { service: svc, healthy: false })).toEqual({
      level: 'ERROR',
      message: 'Health check failed: shop',
    })
  })

  it('renders playwright-started/exit', () => {
    expect(renderEvent('playwright-started', { command: 'npx pw' })).toEqual({
      level: 'INFO',
      message: 'Running Playwright tests: npx pw',
    })
    expect(renderEvent('playwright-exit', { exitCode: 0 })).toEqual({
      level: 'INFO',
      message: 'Playwright exited: code=0',
    })
    expect(renderEvent('playwright-exit', { exitCode: 1 })).toEqual({
      level: 'WARN',
      message: 'Playwright exited: code=1',
    })
  })

  it('renders agent-started/exit', () => {
    expect(renderEvent('agent-started', { cycle: 2, command: 'claude -p' })).toEqual({
      level: 'INFO',
      message: 'Heal agent started (cycle 2): claude -p',
    })
    expect(renderEvent('agent-exit', { exitCode: 0 })).toEqual({
      level: 'INFO',
      message: 'Heal agent exited: code=0',
    })
  })

  it('renders heal-cycle-started (with and without failure signature)', () => {
    expect(renderEvent('heal-cycle-started', { cycle: 1, failureSignature: 'a|b' })).toEqual({
      level: 'INFO',
      message: 'Heal cycle 1 starting (failures: a|b)',
    })
    expect(renderEvent('heal-cycle-started', { cycle: 1, failureSignature: '' })).toEqual({
      level: 'INFO',
      message: 'Heal cycle 1 starting (failures: none)',
    })
  })

  it('renders signal-detected / run-status / run-complete', () => {
    expect(renderEvent('signal-detected', { kind: 'restart', body: {} })).toEqual({
      level: 'INFO',
      message: 'Signal detected: .restart',
    })
    expect(renderEvent('run-status', { status: 'healing' })).toEqual({
      level: 'INFO',
      message: 'Run status: healing',
    })
    expect(renderEvent('run-complete', { status: 'passed' })).toEqual({
      level: 'INFO',
      message: 'Run complete: status=passed',
    })
  })

  it('returns null for pty pass-through events', () => {
    expect(renderEvent('service-output', { service: svc, chunk: 'x' })).toBeNull()
    expect(renderEvent('playwright-output', { chunk: 'x' })).toBeNull()
    expect(renderEvent('agent-output', { chunk: 'x' })).toBeNull()
  })
})

describe('RunnerLog', () => {
  it('creates the log file and parent dir on construction', () => {
    const p = path.join(tmpDir, 'a', 'b', 'runner.log')
    new RunnerLog(p)
    expect(fs.existsSync(p)).toBe(true)
  })

  it('does not overwrite an existing log file on construction', () => {
    const p = path.join(tmpDir, 'runner.log')
    fs.writeFileSync(p, 'pre-existing\n')
    new RunnerLog(p)
    expect(fs.readFileSync(p, 'utf-8')).toBe('pre-existing\n')
  })

  it('writes info/warn/error lines with ANSI stripped and timestamps prefixed', () => {
    const p = path.join(tmpDir, 'runner.log')
    const log = new RunnerLog(p)
    log.info('hello \x1b[32mworld\x1b[0m')
    log.warn('careful')
    log.error('broke')
    const body = fs.readFileSync(p, 'utf-8')
    const lines = body.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO  hello world$/)
    expect(lines[1]).toMatch(/ WARN  careful$/)
    expect(lines[2]).toMatch(/ ERROR broke$/)
    // No raw ANSI escapes anywhere in the file.
    expect(body).not.toMatch(/\x1b\[/)
  })

  it('appends across multiple writes', () => {
    const p = path.join(tmpDir, 'runner.log')
    const log = new RunnerLog(p)
    log.info('a')
    log.info('b')
    log.info('c')
    const lines = fs.readFileSync(p, 'utf-8').trim().split('\n')
    expect(lines.map((l) => l.split(' INFO  ')[1])).toEqual(['a', 'b', 'c'])
  })

  it('recordEvent writes a rendered line for known events', () => {
    const p = path.join(tmpDir, 'runner.log')
    const log = new RunnerLog(p)
    const svc = { name: 'shop', safeName: 'shop', command: 'x', cwd: '/' } as any
    log.recordEvent('service-started', { service: svc, pid: 9 })
    log.recordEvent('run-complete', { status: 'passed' })
    const body = fs.readFileSync(p, 'utf-8')
    expect(body).toContain('Service started: shop (pid=9)')
    expect(body).toContain('Run complete: status=passed')
  })

  it('recordEvent is a no-op for events without a runner-log surface', () => {
    const p = path.join(tmpDir, 'runner.log')
    const log = new RunnerLog(p)
    const svc = { name: 'shop', safeName: 'shop', command: 'x', cwd: '/' } as any
    log.recordEvent('service-output', { service: svc, chunk: 'noise' })
    expect(fs.readFileSync(p, 'utf-8')).toBe('')
  })

  it('close() makes subsequent writes a no-op', () => {
    const p = path.join(tmpDir, 'runner.log')
    const log = new RunnerLog(p)
    log.info('before')
    log.close()
    log.info('after')
    log.warn('still nope')
    const body = fs.readFileSync(p, 'utf-8')
    expect(body).toContain('before')
    expect(body).not.toContain('after')
    expect(body).not.toContain('still nope')
  })

  it('write() swallows fs errors silently', () => {
    // Construct against a path that exists, then chmod its parent to read-only
    // to force append failures. Skip on platforms where chmod doesn't apply.
    const p = path.join(tmpDir, 'runner.log')
    const log = new RunnerLog(p)
    // Replace the file with a directory of the same name so appendFileSync fails.
    fs.unlinkSync(p)
    fs.mkdirSync(p)
    expect(() => log.info('should not throw')).not.toThrow()
  })
})
