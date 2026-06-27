import { describe, it, expect, vi } from 'vitest'
import { VersionState } from './version-state'
import type { UpdateJobStore } from './update-job'

const emptyStore = { current: () => null } as unknown as UpdateJobStore

const okFetch = (version: string) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version }) }) as unknown as typeof fetch

describe('VersionState', () => {
  it('reports updateAvailable when the registry latest is newer than the running version', async () => {
    const bus = { publish: vi.fn() }
    const state = new VersionState({
      packageName: 'canary-lab',
      runningVersion: '1.4.0',
      fetchImpl: okFetch('1.4.2'),
      workspaceEvents: bus,
    })
    await state.refresh()
    const status = state.status(emptyStore)
    expect(status.current).toBe('1.4.0')
    expect(status.latest).toBe('1.4.2')
    expect(status.updateAvailable).toBe(true)
    expect(state.pendingTarget()).toBe('1.4.2')
    expect(bus.publish).toHaveBeenCalledWith({ type: 'version-changed' })
  })

  it('does not flag an update when already on latest, and emits no event', async () => {
    const bus = { publish: vi.fn() }
    const state = new VersionState({
      packageName: 'canary-lab',
      runningVersion: '1.4.2',
      fetchImpl: okFetch('1.4.2'),
      workspaceEvents: bus,
    })
    await state.refresh()
    const status = state.status(emptyStore)
    expect(status.updateAvailable).toBe(false)
    expect(state.pendingTarget()).toBeNull()
    // latest moved from null → 1.4.2, so one event fires; but no false "available".
    expect(bus.publish).toHaveBeenCalledTimes(1)
  })

  it('stays calm (no update, null latest) when the registry check fails', async () => {
    const state = new VersionState({
      packageName: 'canary-lab',
      runningVersion: '1.4.0',
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    })
    await state.refresh()
    const status = state.status(emptyStore)
    expect(status.latest).toBeNull()
    expect(status.updateAvailable).toBe(false)
  })

  it('skips the check entirely when the package name is unknown', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const state = new VersionState({ packageName: null, runningVersion: '1.4.0', fetchImpl })
    await state.refresh()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state.status(emptyStore).updateAvailable).toBe(false)
  })
})
