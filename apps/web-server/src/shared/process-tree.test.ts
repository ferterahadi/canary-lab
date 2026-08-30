import { describe, expect, it, vi } from 'vitest'

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }))
vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }))

import { canSignalProcessGroup, processGroupAlive, signalProcessTree } from './process-tree'

function target(pid: number | undefined = 4242) {
  return { pid, kill: vi.fn() }
}

describe('process-tree', () => {
  it('signals an owned Unix process group instead of only its parent', () => {
    const child = target()
    const killGroup = vi.fn(() => true)

    signalProcessTree(child, 'SIGTERM', { detachedProcessGroup: true }, { platform: 'darwin', killGroup })

    expect(killGroup).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('falls back to the direct child when the Unix group is already gone', () => {
    const child = target()
    signalProcessTree(child, 'SIGKILL', { detachedProcessGroup: true }, {
      platform: 'linux',
      killGroup: () => { throw new Error('ESRCH') },
    })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('does not group-signal a Unix child that was not started detached', () => {
    const child = target()
    const killGroup = vi.fn()
    signalProcessTree(child, 'SIGTERM', { detachedProcessGroup: false }, { platform: 'linux', killGroup })
    expect(killGroup).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('uses taskkill /T on Windows and adds /F only for a forced stop', () => {
    const graceful = vi.fn()
    const forced = vi.fn()
    const numericForced = vi.fn()
    signalProcessTree(target(), 'SIGTERM', { detachedProcessGroup: false }, { platform: 'win32', taskkill: graceful })
    signalProcessTree(target(), 'SIGKILL', { detachedProcessGroup: false }, { platform: 'win32', taskkill: forced })
    signalProcessTree(target(), 9, { detachedProcessGroup: false }, { platform: 'win32', taskkill: numericForced })
    expect(graceful).toHaveBeenCalledWith(['/pid', '4242', '/T'])
    expect(forced).toHaveBeenCalledWith(['/pid', '4242', '/T', '/F'])
    expect(numericForced).toHaveBeenCalledWith(['/pid', '4242', '/T', '/F'])
  })

  it('uses the native taskkill command when no Windows test seam is supplied', () => {
    mockSpawnSync.mockReturnValue({ error: undefined, status: 0 })
    const child = target()
    signalProcessTree(child, 'SIGTERM', { detachedProcessGroup: false }, { platform: 'win32' })
    expect(mockSpawnSync).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T'], { stdio: 'ignore' })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('falls back to the direct child when the native taskkill command cannot start', () => {
    mockSpawnSync.mockReturnValue({ error: new Error('missing'), status: null })
    const child = target()
    signalProcessTree(child, 'SIGTERM', { detachedProcessGroup: false }, { platform: 'win32' })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('falls back when taskkill starts but cannot terminate the tree', () => {
    mockSpawnSync.mockReturnValue({ error: undefined, status: 1 })
    const child = target()
    signalProcessTree(child, 'SIGTERM', { detachedProcessGroup: false }, { platform: 'win32' })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('falls back when taskkill fails and never group-signals an unsafe pid', () => {
    const windows = target()
    signalProcessTree(windows, 'SIGTERM', { detachedProcessGroup: false }, {
      platform: 'win32',
      taskkill: () => { throw new Error('missing') },
    })
    expect(windows.kill).toHaveBeenCalledWith('SIGTERM')

    const unsafe = target(1)
    const killGroup = vi.fn()
    signalProcessTree(unsafe, 9, { detachedProcessGroup: true }, { platform: 'darwin', killGroup })
    expect(killGroup).not.toHaveBeenCalled()
    expect(unsafe.kill).toHaveBeenCalledWith(undefined)
  })

  it('swallows a direct child that already exited', () => {
    const child = { pid: undefined, kill: vi.fn(() => { throw new Error('gone') }) }
    expect(() => signalProcessTree(child, 'SIGTERM', { detachedProcessGroup: true })).not.toThrow()
  })

  it('probes only safe process groups', () => {
    const alive = vi.fn(() => true)
    expect(processGroupAlive(4242, alive)).toBe(true)
    expect(alive).toHaveBeenCalledWith(-4242, 0)

    expect(processGroupAlive(1, alive)).toBe(false)
    expect(processGroupAlive(undefined, alive)).toBe(false)
    expect(canSignalProcessGroup(2)).toBe(true)
    expect(canSignalProcessGroup(1)).toBe(false)
  })

  it('reports a missing process group as gone', () => {
    expect(processGroupAlive(4242, () => { throw new Error('ESRCH') })).toBe(false)
  })
})
