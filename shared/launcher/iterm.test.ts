import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileSync = vi.fn()
vi.mock('child_process', () => ({ execFileSync }))

const { escape, closeItermSessionsByPrefix, closeItermSessionsByIds, openItermTabs } =
  await import('./iterm')

beforeEach(() => {
  execFileSync.mockReset()
  execFileSync.mockImplementation(() => '')
})

describe('escape (iterm)', () => {
  it('escapes backslashes and double quotes', () => {
    expect(escape('plain')).toBe('plain')
    expect(escape('has "quote"')).toBe('has \\"quote\\"')
    expect(escape('back\\slash')).toBe('back\\\\slash')
    expect(escape('mix "a"\\b')).toBe('mix \\"a\\"\\\\b')
  })

  it('escapes backslashes before quotes to avoid re-interpretation', () => {
    expect(escape('\\"')).toBe('\\\\\\"')
  })

  it('leaves other characters (newlines, tabs, unicode) untouched', () => {
    expect(escape('line1\nline2')).toBe('line1\nline2')
    expect(escape('tab\tthere')).toBe('tab\tthere')
    expect(escape('émoji 🚀')).toBe('émoji 🚀')
  })
})

describe('closeItermSessionsByPrefix', () => {
  it('is a no-op when prefixes is empty', () => {
    closeItermSessionsByPrefix([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('collects ttys via osascript, pkills each, then closes tabs', () => {
    execFileSync
      .mockImplementationOnce(() => '/dev/ttys001\n/dev/ttys002\n')
      .mockImplementation(() => '')

    closeItermSessionsByPrefix(['heal-agent-', 'svc-'])

    const collectArgs = execFileSync.mock.calls[0]
    expect(collectArgs[0]).toBe('osascript')
    expect(collectArgs[1][0]).toBe('-e')
    expect(collectArgs[1][1]).toContain('name of s starts with "heal-agent-"')
    expect(collectArgs[1][1]).toContain('name of s starts with "svc-"')
    expect(collectArgs[1][1]).toContain(' or ')
    expect(collectArgs[1][1]).toContain('return ttyList as text')

    expect(execFileSync.mock.calls[1]).toEqual([
      'pkill',
      ['-9', '-t', 'ttys001'],
      { stdio: 'ignore' },
    ])
    expect(execFileSync.mock.calls[2]).toEqual([
      'pkill',
      ['-9', '-t', 'ttys002'],
      { stdio: 'ignore' },
    ])

    const closeArgs = execFileSync.mock.calls[3]
    expect(closeArgs[0]).toBe('osascript')
    expect(closeArgs[1][1]).toContain('close t saving no')
    expect(closeArgs[1][1]).toContain('name of s starts with "heal-agent-"')
  })

  it('returns early when the collect osascript call throws (iTerm not running)', () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error('iTerm not running')
    })
    closeItermSessionsByPrefix(['x-'])
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })

  it('swallows pkill failures and still runs the close script', () => {
    execFileSync
      .mockImplementationOnce(() => '/dev/ttys009\n')
      .mockImplementationOnce(() => {
        throw new Error('no such tty')
      })
      .mockImplementation(() => '')

    closeItermSessionsByPrefix(['x-'])

    expect(execFileSync).toHaveBeenCalledTimes(3)
    expect(execFileSync.mock.calls[2][0]).toBe('osascript')
  })

  it('swallows close-script failure (non-fatal)', () => {
    execFileSync
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => {
        throw new Error('close failed')
      })
    expect(() => closeItermSessionsByPrefix(['x-'])).not.toThrow()
  })

  it('escapes quotes/backslashes in prefixes to prevent AppleScript injection', () => {
    execFileSync.mockImplementationOnce(() => '')
    closeItermSessionsByPrefix(['weird"name\\'])
    const script = execFileSync.mock.calls[0][1][1] as string
    expect(script).toContain('name of s starts with "weird\\"name\\\\"')
  })
})

describe('closeItermSessionsByIds', () => {
  it('is a no-op when ids is empty', () => {
    closeItermSessionsByIds([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('matches by (id of s as string) and kills ttys', () => {
    execFileSync
      .mockImplementationOnce(() => '/dev/ttys010\n')
      .mockImplementation(() => '')

    closeItermSessionsByIds(['ABC-123', 'DEF-456'])

    const script = execFileSync.mock.calls[0][1][1] as string
    expect(script).toContain('(id of s as string) is in {"ABC-123", "DEF-456"}')

    expect(execFileSync.mock.calls[1]).toEqual([
      'pkill',
      ['-9', '-t', 'ttys010'],
      { stdio: 'ignore' },
    ])
    expect(execFileSync.mock.calls[2][0]).toBe('osascript')
    expect(execFileSync.mock.calls[2][1][1]).toContain(
      '(id of s as string) is in {"ABC-123", "DEF-456"}',
    )
  })

  it('returns early when the collect osascript call throws', () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error('nope')
    })
    closeItermSessionsByIds(['X'])
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })
})

describe('openItermTabs', () => {
  it('returns [] and calls nothing when tabs is empty', () => {
    expect(openItermTabs([], 'label')).toEqual([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('builds a script that creates a window for the first tab and new tabs for the rest, writes cd+command, returns parsed ids', () => {
    execFileSync.mockImplementationOnce(() => 'SID-1\nSID-2\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const ids = openItermTabs(
      [
        { dir: '/a/b', command: 'npm run dev', name: 'svc-a' },
        { dir: '/c/d', command: 'echo hi', name: 'svc-b' },
      ],
      'opening tabs',
    )

    expect(ids).toEqual(['SID-1', 'SID-2'])
    expect(logSpy).toHaveBeenCalledWith('opening tabs')

    const [cmd, args, opts] = execFileSync.mock.calls[0]
    expect(cmd).toBe('osascript')
    expect(args[0]).toBe('-e')
    const script = args[1] as string
    expect(script).toContain('create window with default profile')
    expect(script).toContain('set s1 to current session of current tab')
    expect(script).toContain('set name of s1 to "svc-a"')
    expect(script).toContain('set t2 to create tab with default profile')
    expect(script).toContain('set name of s2 to "svc-b"')
    expect(script).toContain('write text "cd /a/b && npm run dev"')
    expect(script).toContain('write text "cd /c/d && echo hi"')
    expect(script).toContain('set idList to {(id of s1 as string), (id of s2 as string)}')
    expect(script).toContain('return idList as text')
    expect(opts).toMatchObject({ encoding: 'utf-8' })

    logSpy.mockRestore()
  })

  it('falls back to "tab-N" names when StartTab.name is missing', () => {
    execFileSync.mockImplementationOnce(() => '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    openItermTabs([{ dir: '/x', command: 'c', name: undefined as any }], '')
    const script = execFileSync.mock.calls[0][1][1] as string
    expect(script).toContain('set name of s1 to "tab-1"')
  })

  it('escapes dir/command/name against AppleScript injection', () => {
    execFileSync.mockImplementationOnce(() => '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    openItermTabs(
      [{ dir: '/p"a\\th', command: 'echo "hi"', name: 'bad"name' }],
      '',
    )
    const script = execFileSync.mock.calls[0][1][1] as string
    expect(script).toContain('set name of s1 to "bad\\"name"')
    expect(script).toContain('write text "cd /p\\"a\\\\th && echo \\"hi\\""')
  })

  it('returns [] when osascript throws', () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error('iTerm not installed')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(
      openItermTabs([{ dir: '/x', command: 'c', name: 'n' }], ''),
    ).toEqual([])
  })
})
