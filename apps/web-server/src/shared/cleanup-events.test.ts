import { afterEach, expect, it, vi } from 'vitest'
import { bridgeCleanupEvents, CLEANUP_EVENT_COALESCE_MS } from './cleanup-events'
import { WorkspaceEventBus } from './workspace-events'
import type { WorkspaceEvent } from '../../../../shared/workspace-events'
import { PortifyRunStore } from '../features/portify/logic/runtime/store'
import type { PortifyManifest } from '../../../../shared/portify-index'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cleanup-events-')

let directory: string | undefined
afterEach(() => {
  vi.useRealTimers()
})

it('coalesces real store writes and deletions into scoped inventory notifications', () => {
  vi.useFakeTimers()
  directory = tempDir()
  const store = new PortifyRunStore(directory)
  const bus = new WorkspaceEventBus()
  const events: WorkspaceEvent[] = []
  bus.subscribe((event) => events.push(event))
  bridgeCleanupEvents(store, bus, ['portify', 'worktrees'])
  const manifest = { workflowId: 'one', feature: 'example', status: 'planning', startedAt: '2026-01-01T00:00:00Z' } as PortifyManifest
  store.save(manifest)
  store.save({ ...manifest, status: 'editing' })
  expect(events).toEqual([])
  vi.advanceTimersByTime(CLEANUP_EVENT_COALESCE_MS)
  expect(events).toEqual([
    { type: 'cleanup-changed', resource: 'portify' },
    { type: 'cleanup-changed', resource: 'worktrees' },
  ])
  store.remove('one')
  vi.advanceTimersByTime(CLEANUP_EVENT_COALESCE_MS)
  expect(events).toHaveLength(4)
  expect(store.get('one')).toBeNull()
})
