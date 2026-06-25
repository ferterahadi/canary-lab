import { describe, expect, it } from 'vitest'
import path from 'path'
import { portifyCleanupListing } from './cleanup'
import type { PortifyIndexEntry } from './types'

function entry(over: Partial<PortifyIndexEntry> & { workflowId: string }): PortifyIndexEntry {
  return { feature: 'f', status: 'saved', startedAt: '2026-01-01T00:00:00.000Z', ...over }
}

describe('portifyCleanupListing', () => {
  const logsDir = '/logs'
  const store = {
    list: (): PortifyIndexEntry[] => [
      entry({ workflowId: 'a', feature: 'checkout', status: 'saved', endedAt: '2026-01-02T00:00:00.000Z' }),
      entry({ workflowId: 'b', feature: 'auth', status: 'failed' }),
    ],
  }
  const sizes: Record<string, number> = {
    [path.join(logsDir, 'portify', 'a')]: 100,
    [path.join(logsDir, 'portify', 'b')]: 300,
  }
  const sizeOf = (dir: string): number => sizes[dir] ?? 0

  it('maps each workflow to a sized cleanup entry, biggest first', () => {
    const { workflows, totalBytes } = portifyCleanupListing(store, logsDir, sizeOf)
    expect(workflows.map((w) => w.workflowId)).toEqual(['b', 'a'])
    expect(workflows[0]).toMatchObject({ feature: 'auth', status: 'failed', folderBytes: 300 })
    expect(workflows[1]).toMatchObject({ feature: 'checkout', status: 'saved', folderBytes: 100, endedAt: '2026-01-02T00:00:00.000Z' })
    expect(totalBytes).toBe(400)
  })

  it('omits endedAt when absent', () => {
    const { workflows } = portifyCleanupListing(store, logsDir, sizeOf)
    expect('endedAt' in workflows[0]).toBe(false) // 'b' (failed, no endedAt)
  })

  it('returns empty listing for an empty store', () => {
    expect(portifyCleanupListing({ list: () => [] }, logsDir, sizeOf)).toEqual({ workflows: [], totalBytes: 0 })
  })
})
