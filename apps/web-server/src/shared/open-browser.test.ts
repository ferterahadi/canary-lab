import { describe, it, expect, vi } from 'vitest'
import { resolveOpenCommand, openBrowser } from './open-browser'

// Replace the real child_process.spawn shim so tests that exercise the
// `opts.spawner ?? defaultOpenBrowserSpawner` fallback arm don't actually
// launch a browser. Tests that pass an explicit spawner are unaffected.
vi.mock('./open-browser-spawner', () => ({
  defaultOpenBrowserSpawner: vi.fn(() => {
    throw new Error('default spawner stubbed in tests')
  }),
}))

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

  it('falls back to defaultOpenBrowserSpawner when opts.spawner is omitted', () => {
    // The default spawner is mocked at the top of this file to throw, so we
    // expect openBrowser to swallow it and return false. The point of the
    // test is to exercise the `opts.spawner ?? defaultOpenBrowserSpawner`
    // nullish arm — explicit-spawner tests above only exercise the truthy arm.
    expect(openBrowser('http://x', { platform: 'linux' })).toBe(false)
  })
})

describe('defaultOpenBrowserSpawner', () => {
  // The module-level vi.mock() above replaces `defaultOpenBrowserSpawner`
  // for the rest of this file, so pull the real, unmocked implementation
  // via importActual to exercise the genuine `spawn(...)` delegation on
  // line 10 of open-browser-spawner.ts. `node -e` is a deterministic,
  // always-present command (see features.test.ts / playwright-list.test.ts
  // for the same pattern) — no real browser is launched.
  it('delegates to child_process.spawn and returns a real ChildProcess', async () => {
    const { defaultOpenBrowserSpawner } =
      await vi.importActual<typeof import('./open-browser-spawner')>('./open-browser-spawner')

    const child = defaultOpenBrowserSpawner('node', ['-e', 'process.exit(0)'], {
      detached: false,
      stdio: 'ignore',
    })

    expect(typeof child.pid).toBe('number')
    expect(child.pid).toBeGreaterThan(0)

    const [code] = await new Promise<[number | null]>((resolve, reject) => {
      child.once('exit', (exitCode) => resolve([exitCode]))
      child.once('error', reject)
    })
    expect(code).toBe(0)
  })
})
