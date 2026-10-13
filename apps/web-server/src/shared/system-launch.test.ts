import { expect, it, vi } from 'vitest'
import { launchDetached, resolveSystemCommand, type SystemLaunchTarget } from './system-launch'

it.each([
  [{ kind: 'url', url: 'https://example.test/a?b=c&d=e' }, 'darwin', 'open', ['https://example.test/a?b=c&d=e']],
  [{ kind: 'url', url: 'https://example.test' }, 'win32', 'cmd', ['/c', 'start', '""', 'https://example.test']],
  [{ kind: 'url', url: 'https://example.test' }, 'linux', 'xdg-open', ['https://example.test']],
  [{ kind: 'path', path: '/a directory/file' }, 'darwin', 'open', ['/a directory/file']],
  [{ kind: 'path', path: 'C:\\a directory' }, 'win32', 'cmd', ['/c', 'start', '', 'C:\\a directory']],
  [{ kind: 'path', path: '/a directory' }, 'linux', 'xdg-open', ['/a directory']],
  [{ kind: 'application', agent: 'claude' }, 'darwin', 'open', ['-a', 'Claude']],
  [{ kind: 'application', agent: 'codex' }, 'darwin', 'open', ['-a', 'Codex']],
  [{ kind: 'application', agent: 'claude' }, 'win32', 'cmd', ['/c', 'start', '', 'Claude']],
  [{ kind: 'application', agent: 'codex' }, 'win32', 'cmd', ['/c', 'start', '', 'Codex']],
  [{ kind: 'application', agent: 'claude' }, 'linux', 'claude', []],
  [{ kind: 'application', agent: 'codex' }, 'linux', 'codex', []],
] satisfies Array<[SystemLaunchTarget, string, string, string[]]>)('resolves %j on %s', (target, platform, command, args) => {
  expect(resolveSystemCommand(target, platform)).toEqual({ command, args })
})

it('detaches and releases the spawned child without adding shell interpretation', () => {
  const unref = vi.fn()
  const spawner = vi.fn(() => ({ unref }))
  launchDetached({ command: 'open', args: ['/a path'] }, spawner)
  expect(spawner).toHaveBeenCalledWith('open', ['/a path'], { detached: true, stdio: 'ignore' })
  expect(unref).toHaveBeenCalledOnce()
})

it('leaves synchronous spawn failures to the caller', () => {
  const error = new Error('unavailable')
  expect(() => launchDetached({ command: 'open', args: [] }, () => { throw error })).toThrow(error)
})
