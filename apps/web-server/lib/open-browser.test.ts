import { describe, it, expect, vi } from 'vitest'
import { resolveOpenCommand, openBrowser } from './open-browser'

describe('resolveOpenCommand', () => {
  it('uses `open` on darwin', () => {
    expect(resolveOpenCommand('http://x', 'darwin')).toEqual({
      command: 'open',
      args: ['http://x'],
    })
  })

  it('uses `cmd /c start "" <url>` on win32', () => {
    expect(resolveOpenCommand('http://x', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'http://x'],
    })
  })

  it('falls back to xdg-open on linux', () => {
    expect(resolveOpenCommand('http://x', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://x'],
    })
  })

  it('falls back to xdg-open on unknown platforms', () => {
    expect(resolveOpenCommand('http://x', 'freebsd')).toEqual({
      command: 'xdg-open',
      args: ['http://x'],
    })
  })
})

describe('openBrowser', () => {
  it('returns false and skips spawn when url is empty', () => {
    const spawner = vi.fn()
    expect(openBrowser('', { spawner, platform: 'darwin' })).toBe(false)
    expect(spawner).not.toHaveBeenCalled()
  })

  it('spawns the resolved command and unref()s the child', () => {
    const unref = vi.fn()
    const spawner = vi.fn().mockReturnValue({ unref })
    const ok = openBrowser('http://localhost:7421', {
      platform: 'darwin',
      spawner,
    })
    expect(ok).toBe(true)
    expect(spawner).toHaveBeenCalledWith(
      'open',
      ['http://localhost:7421'],
      { detached: true, stdio: 'ignore' },
    )
    expect(unref).toHaveBeenCalledOnce()
  })

  it('uses win32 mapping when platform is win32', () => {
    const spawner = vi.fn().mockReturnValue({ unref: vi.fn() })
    openBrowser('http://x', { platform: 'win32', spawner })
    expect(spawner).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '""', 'http://x'],
      { detached: true, stdio: 'ignore' },
    )
  })

  it('swallows spawner errors and returns false', () => {
    const spawner = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(openBrowser('http://x', { platform: 'linux', spawner })).toBe(false)
  })

  it('uses process.platform when no platform option provided', () => {
    const spawner = vi.fn().mockReturnValue({ unref: vi.fn() })
    openBrowser('http://x', { spawner })
    // We can't assert which command without knowing the runtime, but the
    // call happened — meaning the default platform path executed.
    expect(spawner).toHaveBeenCalledOnce()
  })
})
