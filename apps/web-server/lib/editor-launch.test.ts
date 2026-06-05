import { afterEach, describe, it, expect, vi } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import { launchEditorDir } from './editor-launch'

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  spawnSync: vi.fn(() => ({ status: 0 })),
}))

const spawnMock = vi.mocked(spawn)
const spawnSyncMock = vi.mocked(spawnSync)

/** Make `commandExists(cmd)` return true only for the listed commands. */
function commandsPresent(...present: string[]): void {
  spawnSyncMock.mockImplementation((_lookup, args) => ({
    status: present.includes((args as string[])[0]) ? 0 : 1,
  }) as ReturnType<typeof spawnSync>)
}

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { fn() } finally { Object.defineProperty(process, 'platform', original) }
}

describe('launchEditorDir', () => {
  afterEach(() => vi.clearAllMocks())

  describe('auto resolution', () => {
    it('prefers cursor when it is installed', () => {
      commandsPresent('cursor', 'code')
      expect(launchEditorDir('auto', '/dir')).toBe('cursor')
      expect(spawnMock).toHaveBeenCalledWith('cursor', ['/dir'], expect.objectContaining({ detached: true }))
    })

    it('falls back to code when cursor is missing', () => {
      commandsPresent('code')
      expect(launchEditorDir('auto', '/dir')).toBe('vscode')
      expect(spawnMock).toHaveBeenCalledWith('code', ['/dir'], expect.objectContaining({ detached: true }))
    })

    it('falls back to the system opener when no CLI is installed', () => {
      commandsPresent() // nothing installed
      expect(launchEditorDir('auto', '/dir')).toBe('system')
      expect(spawnMock).toHaveBeenCalledWith('open', ['/dir'], expect.objectContaining({ detached: true }))
    })
  })

  describe('explicit editor', () => {
    it('launches cursor', () => {
      expect(launchEditorDir('cursor', '/dir')).toBe('cursor')
      expect(spawnMock).toHaveBeenCalledWith('cursor', ['/dir'], expect.anything())
    })
    it('launches vscode via the `code` CLI', () => {
      expect(launchEditorDir('vscode', '/dir')).toBe('vscode')
      expect(spawnMock).toHaveBeenCalledWith('code', ['/dir'], expect.anything())
    })
    it('launches the system opener', () => {
      expect(launchEditorDir('system', '/dir')).toBe('system')
      expect(spawnMock).toHaveBeenCalledWith('open', ['/dir'], expect.anything())
    })
  })

  describe('per-platform system opener', () => {
    it('uses `open` on macOS', () => {
      withPlatform('darwin', () => {
        expect(launchEditorDir('system', '/dir')).toBe('system')
        expect(spawnMock).toHaveBeenCalledWith('open', ['/dir'], expect.anything())
      })
    })

    it('uses `cmd /c start` and the `where` lookup on Windows', () => {
      withPlatform('win32', () => {
        commandsPresent() // force the auto path down to launchSystem
        expect(launchEditorDir('auto', '/dir')).toBe('system')
        expect(spawnSyncMock).toHaveBeenCalledWith('where', ['cursor'], expect.anything())
        expect(spawnMock).toHaveBeenCalledWith('cmd', ['/c', 'start', '', '/dir'], expect.anything())
      })
    })

    it('uses `xdg-open` on Linux', () => {
      withPlatform('linux', () => {
        expect(launchEditorDir('system', '/dir')).toBe('system')
        expect(spawnMock).toHaveBeenCalledWith('xdg-open', ['/dir'], expect.anything())
      })
    })
  })
})
