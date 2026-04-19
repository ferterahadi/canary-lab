import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileSync = vi.fn()
vi.mock('child_process', () => ({ execFileSync }))

const { escape, closeTerminalTabsByPrefix, openTerminalTabs } = await import('./terminal')

beforeEach(() => {
  execFileSync.mockReset()
  execFileSync.mockImplementation(() => Buffer.from(''))
})

describe('escape (terminal)', () => {
  it('escapes backslashes and double quotes', () => {
    expect(escape('plain')).toBe('plain')
    expect(escape('has "quote"')).toBe('has \\"quote\\"')
    expect(escape('back\\slash')).toBe('back\\\\slash')
    expect(escape('mix "a"\\b')).toBe('mix \\"a\\"\\\\b')
  })

  it('escapes backslashes before quotes to avoid re-interpretation', () => {
    expect(escape('\\"')).toBe('\\\\\\"')
  })
})

describe('closeTerminalTabsByPrefix', () => {
  it('is a no-op when prefixes is empty', () => {
    closeTerminalTabsByPrefix([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('builds an osascript that matches prefixes via custom title and closes matching tabs', () => {
    closeTerminalTabsByPrefix(['heal-agent-', 'svc-'])
    const [cmd, args, opts] = execFileSync.mock.calls[0]
    expect(cmd).toBe('osascript')
    expect(args[0]).toBe('-e')
    const script = args[1] as string
    expect(script).toContain('tell application "Terminal"')
    expect(script).toContain('(custom title of t starts with "heal-agent-")')
    expect(script).toContain('(custom title of t starts with "svc-")')
    expect(script).toContain(' or ')
    expect(script).toContain('close t saving no')
    expect(opts).toEqual({ stdio: 'ignore' })
  })

  it('swallows osascript failures (Terminal not running)', () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error('not running')
    })
    expect(() => closeTerminalTabsByPrefix(['x-'])).not.toThrow()
  })

  it('escapes prefixes against AppleScript injection', () => {
    closeTerminalTabsByPrefix(['weird"name\\'])
    const script = execFileSync.mock.calls[0][1][1] as string
    expect(script).toContain('(custom title of t starts with "weird\\"name\\\\")')
  })
})

describe('openTerminalTabs', () => {
  it('is a no-op when tabs is empty', () => {
    openTerminalTabs([], 'label')
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('first tab uses `do script` directly; later tabs keystroke cmd-T first', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    openTerminalTabs(
      [
        { dir: '/a', command: 'npm run dev', name: 'svc-a' },
        { dir: '/b', command: 'echo hi', name: 'svc-b' },
      ],
      'opening',
    )
    const [cmd, args, opts] = execFileSync.mock.calls[0]
    expect(cmd).toBe('osascript')
    expect(args[0]).toBe('-e')
    const script = args[1] as string
    expect(script).toContain('tell application "Terminal"')
    expect(script).toContain('activate')
    expect(script).toContain('set newTab to do script "cd /a && npm run dev"')
    expect(script).toContain('set custom title of newTab to "svc-a"')
    expect(script).toContain(
      'tell application "System Events" to keystroke "t" using command down',
    )
    expect(script).toContain('set newTab to do script "cd /b && echo hi" in front window')
    expect(script).toContain('set custom title of newTab to "svc-b"')
    expect(opts).toEqual({ stdio: 'inherit' })
  })

  it('falls back to "tab-N" when name is missing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    openTerminalTabs([{ dir: '/x', command: 'c', name: undefined as any }], '')
    const script = execFileSync.mock.calls[0][1][1] as string
    expect(script).toContain('set custom title of newTab to "tab-1"')
  })

  it('escapes dir/command/name against injection', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    openTerminalTabs(
      [{ dir: '/p"a\\th', command: 'echo "hi"', name: 'bad"name' }],
      '',
    )
    const script = execFileSync.mock.calls[0][1][1] as string
    expect(script).toContain(
      'set newTab to do script "cd /p\\"a\\\\th && echo \\"hi\\""',
    )
    expect(script).toContain('set custom title of newTab to "bad\\"name"')
  })

  it('logs the label when provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    openTerminalTabs([{ dir: '/x', command: 'c', name: 'n' }], 'my-label')
    expect(logSpy).toHaveBeenCalledWith('my-label')
  })
})
